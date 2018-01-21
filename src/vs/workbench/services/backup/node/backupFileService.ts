/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

'use strict';

import * as path from 'path';
import * as crypto from 'crypto';
import * as pfs from 'vs/base/node/pfs';
import Uri from 'vs/base/common/uri';
import { ResourceQueue } from 'vs/base/common/async';
import { IBackupFileService, BACKUP_FILE_UPDATE_OPTIONS } from 'vs/workbench/services/backup/common/backup';
import { IFileService, ITextSnapshot, BufferedTextSnapshot, IFileStat } from 'vs/platform/files/common/files';
import { TPromise } from 'vs/base/common/winjs.base';
import { readToMatchingString } from 'vs/base/node/stream';
import { Range } from 'vs/editor/common/core/range';
import { DefaultEndOfLine, ITextBufferFactory, EndOfLinePreference } from 'vs/editor/common/model';

export interface IBackupFilesModel {
	resolve(backupRoot: string): TPromise<IBackupFilesModel>;

	add(resource: Uri, versionId?: number): void;
	has(resource: Uri, versionId?: number): boolean;
	get(): Uri[];
	remove(resource: Uri): void;
	count(): number;
	clear(): void;
}

export class BackupFilesModel implements IBackupFilesModel {
	private cache: { [resource: string]: number /* version ID */ } = Object.create(null);

	public resolve(backupRoot: string): TPromise<IBackupFilesModel> {
		return pfs.readDirsInDir(backupRoot).then(backupSchemas => {

			// For all supported schemas
			return TPromise.join(backupSchemas.map(backupSchema => {

				// Read backup directory for backups
				const backupSchemaPath = path.join(backupRoot, backupSchema);
				return pfs.readdir(backupSchemaPath).then(backupHashes => {

					// Remember known backups in our caches
					backupHashes.forEach(backupHash => {
						const backupResource = Uri.file(path.join(backupSchemaPath, backupHash));
						this.add(backupResource);
					});
				});
			}));
		}).then(() => this, error => this);
	}

	public add(resource: Uri, versionId = 0): void {
		this.cache[resource.toString()] = versionId;
	}

	public count(): number {
		return Object.keys(this.cache).length;
	}

	public has(resource: Uri, versionId?: number): boolean {
		const cachedVersionId = this.cache[resource.toString()];
		if (typeof cachedVersionId !== 'number') {
			return false; // unknown resource
		}

		if (typeof versionId === 'number') {
			return versionId === cachedVersionId; // if we are asked with a specific version ID, make sure to test for it
		}

		return true;
	}

	public get(): Uri[] {
		return Object.keys(this.cache).map(k => Uri.parse(k));
	}

	public remove(resource: Uri): void {
		delete this.cache[resource.toString()];
	}

	public clear(): void {
		this.cache = Object.create(null);
	}
}

export class BackupFileService implements IBackupFileService {

	private static readonly META_MARKER = '\n';

	public _serviceBrand: any;

	private backupWorkspacePath: string;

	private isShuttingDown: boolean;
	private ready: TPromise<IBackupFilesModel>;
	private ioOperationQueues: ResourceQueue; // queue IO operations to ensure write order

	constructor(
		backupWorkspacePath: string,
		@IFileService private fileService: IFileService
	) {
		this.isShuttingDown = false;
		this.ioOperationQueues = new ResourceQueue();

		this.initialize(backupWorkspacePath);
	}

	public initialize(backupWorkspacePath: string): void {
		this.backupWorkspacePath = backupWorkspacePath;

		this.ready = this.init();
	}

	public get backupEnabled(): boolean {
		return !!this.backupWorkspacePath; // Hot exit requires a backup path
	}

	private init(): TPromise<IBackupFilesModel> {
		const model = new BackupFilesModel();

		if (!this.backupEnabled) {
			return TPromise.as(model);
		}

		return model.resolve(this.backupWorkspacePath);
	}

	public hasBackups(): TPromise<boolean> {
		return this.ready.then(model => {
			return model.count() > 0;
		});
	}

	public loadBackupResource(resource: Uri): TPromise<Uri> {
		return this.ready.then(model => {
			const backupResource = this.toBackupResource(resource);
			if (!backupResource) {
				return void 0;
			}

			// Return directly if we have a known backup with that resource
			if (model.has(backupResource)) {
				return backupResource;
			}

			return void 0;
		});
	}

	public backupResource(resource: Uri, content: string | ITextSnapshot, versionId?: number): TPromise<void> {
		if (this.isShuttingDown) {
			return TPromise.as(void 0);
		}

		return this.ready.then(model => {
			const backupResource = this.toBackupResource(resource);
			if (!backupResource) {
				return void 0;
			}

			if (model.has(backupResource, versionId)) {
				return void 0; // return early if backup version id matches requested one
			}

			return this.ioOperationQueues.queueFor(backupResource).queue(() => {
				const preamble = `${resource.toString()}${BackupFileService.META_MARKER}`;

				// Update content with value
				let updateContentPromise: TPromise<IFileStat>;
				if (typeof content === 'string') {
					updateContentPromise = this.fileService.updateContent(backupResource, `${preamble}${content}`, BACKUP_FILE_UPDATE_OPTIONS);
				}

				// Update content with snapshot
				else {
					updateContentPromise = this.fileService.updateContent(backupResource, new BufferedTextSnapshot(content, preamble), BACKUP_FILE_UPDATE_OPTIONS);
				}

				return updateContentPromise.then(() => model.add(backupResource, versionId));
			});
		});
	}

	public discardResourceBackup(resource: Uri): TPromise<void> {
		return this.ready.then(model => {
			const backupResource = this.toBackupResource(resource);
			if (!backupResource) {
				return void 0;
			}

			return this.ioOperationQueues.queueFor(backupResource).queue(() => {
				return pfs.del(backupResource.fsPath).then(() => model.remove(backupResource));
			});
		});
	}

	public discardAllWorkspaceBackups(): TPromise<void> {
		this.isShuttingDown = true;

		return this.ready.then(model => {
			if (!this.backupEnabled) {
				return void 0;
			}

			return pfs.del(this.backupWorkspacePath).then(() => model.clear());
		});
	}

	public getWorkspaceFileBackups(): TPromise<Uri[]> {
		return this.ready.then(model => {
			const readPromises: TPromise<Uri>[] = [];

			model.get().forEach(fileBackup => {
				readPromises.push(
					readToMatchingString(fileBackup.fsPath, BackupFileService.META_MARKER, 2000, 10000)
						.then(Uri.parse)
				);
			});

			return TPromise.join(readPromises);
		});
	}

	public parseBackupContent(textBufferFactory: ITextBufferFactory): string {
		// The first line of a backup text file is the file name
		const textBuffer = textBufferFactory.create(DefaultEndOfLine.LF);
		const lineCount = textBuffer.getLineCount();
		const range = new Range(2, 1, lineCount, textBuffer.getLineLength(lineCount) + 1);
		return textBuffer.getValueInRange(range, EndOfLinePreference.TextDefined);
	}

	public toBackupResource(resource: Uri): Uri {
		if (!this.backupEnabled) {
			return null;
		}

		return Uri.file(path.join(this.backupWorkspacePath, resource.scheme, this.hashPath(resource)));
	}

	private hashPath(resource: Uri): string {
		return crypto.createHash('md5').update(resource.fsPath).digest('hex');
	}
}
