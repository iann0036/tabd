import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import { getUpdatedRanges, mostRecentInternalCommand } from "./positionalTracking";
import { Mutex } from 'async-mutex';
import { fsPath, uniqueFileName, shouldProcessFile, getLogDirectory, getStorageDirectory } from './utils';
import { ExtendedRange, ExtendedRangeOptions, ExtendedRangeType, mergeRangesSequentially, mergeUserEdits } from './extendedRange';
import { PasteEditProvider } from './pasteEditProvider';
import { triggerDecorationUpdate } from './decorators';
import { SerializedFileState, GlobalFileState } from './types';
import { getGitNotesNamespace, saveToGitNotes, loadFromGitNotes, getCurrentGitUser } from './git';
import { enableClipboardTracking, disableClipboardTracking } from './clipboard';

let currentUser: string = "";
var editLock = new Mutex();
var globalFileState: GlobalFileState = {};

export function activate(context: vscode.ExtensionContext) {
	// Only exclude the .tabd directory from the file explorer when using repository storage
	const config = vscode.workspace.getConfiguration('tabd');
	const storageType = config.get<string>('storage', 'repository');
	
	if (storageType === 'repository') {
		const files = vscode.workspace.getConfiguration('files');
		const exclude = files.get('exclude') as Record<string, boolean>;
		exclude['**/.tabd'] = true;
		files.update('exclude', exclude, vscode.ConfigurationTarget.Global);
	}

	const notifyPaste = function (d: vscode.TextDocument, ranges: readonly vscode.Range[]) {
		return editLock.runExclusive(async () => {
			// Check if tracking is disabled
			const config = vscode.workspace.getConfiguration('tabd');
			const disabled = config.get<boolean>('disabled', false);
			if (disabled) {
				return;
			}

			let fileState = globalFileState[fsPath(d.uri)];
			const now = Date.now();
			if (!fileState) {
				fileState = globalFileState[fsPath(d.uri)] = { changes: [], pasteRanges: [], loadTimestamp: now-1 };
			}

			for (const range of ranges) {
				// Create a new range for the paste operation
				const pasteRange = new ExtendedRange(range.start, range.end, ExtendedRangeType.Paste, now);
				fileState.pasteRanges = fileState.pasteRanges.filter(p => p.getCreationTimestamp() > now - 400); // memory cleanup
				fileState.pasteRanges.push(pasteRange);
			}
		});
	};

	const providerRegistrations = vscode.Disposable.from(
		// Register the text editor change listener
		vscode.workspace.onDidChangeTextDocument(e => {
			if (e.document.uri.scheme !== 'file' || !shouldProcessFile(e.document.uri)) {
				return;
			}

			// Check if tracking is disabled
			const config = vscode.workspace.getConfiguration('tabd');
			const disabled = config.get<boolean>('disabled', false);
			if (disabled) {
				return;
			}

			return editLock.runExclusive(async () => {
				let fileState = globalFileState[fsPath(e.document.uri)];
				let updatedRanges: ExtendedRange[];

				if (!fileState) {
					fileState = globalFileState[fsPath(e.document.uri)] = { changes: [], pasteRanges: [], loadTimestamp: Date.now() - 1 };
					updatedRanges = [];
				} else {
					updatedRanges = getUpdatedRanges(
						fileState.changes,
						fileState.pasteRanges,
						e.contentChanges,
						e.reason,
						e.document,
					);
				}

				fileState.changes = updatedRanges;

				console.debug("Triggering decoration update due to onDidChangeTextDocument for", e.document.uri.fsPath);
				triggerDecorationUpdate(e.document, updatedRanges);
			});
		}),

		// Register listener for when text editors are opened
		vscode.window.onDidChangeActiveTextEditor(editor => {
			if (!editor || editor.document.uri.scheme !== 'file' || !shouldProcessFile(editor.document.uri)) {
				return;
			}
			
			// Check if tracking is disabled
			const config = vscode.workspace.getConfiguration('tabd');
			const disabled = config.get<boolean>('disabled', false);
			if (disabled) {
				return;
			}

			loadGlobalFileStateForDocumentFromDisk(editor.document);
			
			const showBlameByDefault = config.get<boolean>('showBlameByDefault', false);
			
			if (showBlameByDefault) {
				const filePath = fsPath(editor.document.uri);
				const fileState = globalFileState[filePath];
				if (fileState && fileState.changes.length > 0) {
					console.debug("Triggering decoration update due to onDidChangeActiveTextEditor for", editor.document.uri.fsPath);
					triggerDecorationUpdate(editor.document, fileState.changes);
				}
			}
		}),

		// Register listener for configuration changes
		vscode.workspace.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration('tabd.showBlameByDefault')) {
				// Update decorations for all visible editors when the setting changes
				for (const editor of vscode.window.visibleTextEditors) {
					if (editor.document.uri.scheme === 'file' && shouldProcessFile(editor.document.uri)) {
						const filePath = fsPath(editor.document.uri);
						const fileState = globalFileState[filePath];
						if (fileState && fileState.changes.length > 0) {
							triggerDecorationUpdate(editor.document, fileState.changes);
						}
					}
				}
			}
			
			if (e.affectsConfiguration('tabd.storage')) {
				// Clear global file state when storage type changes to force reload from new location
				globalFileState = {};
				
				// Update files.exclude based on storage type
				const config = vscode.workspace.getConfiguration('tabd');
				const storageType = config.get<string>('storage', 'repository');
				
				if (storageType === 'repository') {
					const files = vscode.workspace.getConfiguration('files');
					const exclude = files.get('exclude') as Record<string, boolean>;
					exclude['**/.tabd'] = true;
					files.update('exclude', exclude, vscode.ConfigurationTarget.Global);
				}
				
				// Reload file state for active editor
				if (vscode.window.activeTextEditor) {
					loadGlobalFileStateForDocumentFromDisk(vscode.window.activeTextEditor.document);
					const showBlameByDefault = config.get<boolean>('showBlameByDefault', false);
					
					if (showBlameByDefault) {
						const filePath = fsPath(vscode.window.activeTextEditor.document.uri);
						const fileState = globalFileState[filePath];
						if (fileState && fileState.changes.length > 0) {
							triggerDecorationUpdate(vscode.window.activeTextEditor.document, fileState.changes);
						}
					}
				}
			}
		}),

		// Register the listener for saving text documents
		vscode.workspace.onDidSaveTextDocument(document => {
			if (document.uri.scheme !== 'file' || !shouldProcessFile(document.uri)) {
				return;
			}
			
			// Check if tracking is disabled
			const config = vscode.workspace.getConfiguration('tabd');
			const disabled = config.get<boolean>('disabled', false);
			if (disabled) {
				return;
			}
			
			if (globalFileState[fsPath(document.uri)]) {
				editLock.runExclusive(() => {
					// Save the current state of the file
					const fileState = globalFileState[fsPath(document.uri)];

					// If there are no changes recorded, skip saving
					if (!fileState || fileState.changes.length === 0) {
						console.warn(`No changes recorded for ${document.uri.fsPath}. Skipping file state save.`);
						return;
					}

					const workspaceFolder = vscode.workspace.getWorkspaceFolder(document.uri);
					if (!workspaceFolder) {
						console.warn(`No workspace folder found for ${document.uri.fsPath}. Cannot save file state.`);
						return;
					}

					const config = vscode.workspace.getConfiguration('tabd');
					const storageType = config.get<string>('storage', 'repository');

					if (currentUser === "" && (storageType === 'repository' || storageType === 'experimental')) {
						currentUser = getCurrentGitUser(workspaceFolder);
					}

					// Prepare the data to save
					const dataToSave: SerializedFileState = {
						version: 1,
						changes: mergeUserEdits(fileState.changes)
							.filter(change => change.getCreationTimestamp() > (fileState.loadTimestamp || 0))
							.map(change => ({
								start: change.start,
								end: change.end,
								type: change.getType(),
								creationTimestamp: change.getCreationTimestamp(),
								author: change.getAuthor() || currentUser || ((storageType === 'repository' || storageType === 'experimental') ? 'an unknown user' : ''),
								pasteUrl: change.getPasteUrl() || '',
								pasteTitle: change.getPasteTitle() || '',
								aiName: change.getAiName() || '',
								aiModel: change.getAiModel() || '',
								aiExplanation: change.getAiExplanation() || '',
							})),
					};

					// Handle gitnotes storage
					if (storageType === 'experimental') {
						// Check if Git is initialized at the workspace root
						const gitPath = path.join(workspaceFolder.uri.fsPath, '.git');
						const isGitRepo = fs.existsSync(gitPath);
						
						if (!isGitRepo) {
							console.warn('No Git repository found. Skipping file state save.');
							return;
						}

						try {
							const namespace = getGitNotesNamespace(workspaceFolder, document);
							saveToGitNotes(workspaceFolder, document, dataToSave, namespace);
							
							globalFileState[fsPath(document.uri)] = fileState;
						} catch (error) {
							console.error('Failed to save to Git notes:', error);
						}
						return;
					}

					// Write to existing file if it exists (traditional storage)
					if (fileState.savePath) {
						fs.writeFileSync(fileState.savePath, JSON.stringify(dataToSave));
						return;
					}

					// Check is Git is initialized at the workspace root (only required for repository storage)					
					if (storageType === 'repository') {
						const gitPath = path.join(workspaceFolder.uri.fsPath, '.git');
						const isGitRepo = fs.existsSync(gitPath);
						
						if (!isGitRepo) {
							console.warn('No Git repository found. Skipping file state save.');
							return;
						}
					}
					
					// Get the appropriate storage directory
					const baseStorageDir = getStorageDirectory(workspaceFolder, document);
					if (!fs.existsSync(baseStorageDir)) {
						fs.mkdirSync(baseStorageDir, { recursive: true });
						// TODO: Make a README.md file in the storage directory
					}

					// Write the file state to a JSON file
					const fileChangeRecordDir = getLogDirectory(workspaceFolder, document);
					const fileChangeRecordPath = path.join(fileChangeRecordDir, uniqueFileName());
					if (!fs.existsSync(fileChangeRecordDir)) {
						fs.mkdirSync(fileChangeRecordDir, { recursive: true });
					}
					if (fs.existsSync(fileChangeRecordPath)) {
						throw new Error(`File change record already exists at ${fileChangeRecordPath}. This should not happen!`);
					}
					
					// TODO: Add a whole file hash to ensure the file state is valid
					fs.writeFileSync(fileChangeRecordPath, JSON.stringify(dataToSave));

					// Update the global file state
					fileState.savePath = fileChangeRecordPath;
					globalFileState[fsPath(document.uri)] = fileState;
				});
			}
		}),

		// Register the paste edit provider
		vscode.languages.registerDocumentPasteEditProvider({
			scheme: 'file'
		}, new PasteEditProvider(notifyPaste), {
			pasteMimeTypes: [
				"text/*",
				"application/*",
			],
			providedPasteEditKinds: [
				vscode.DocumentDropOrPasteEditKind.Text,
			],
		}),

		// Register the command to toggle the blame
		vscode.commands.registerCommand('tabd.toggleBlame', async () => {
			const config = vscode.workspace.getConfiguration('tabd');
			const currentValue = config.get<boolean>('showBlameByDefault', false);
			
			// Toggle the configuration value
			await config.update('showBlameByDefault', !currentValue, vscode.ConfigurationTarget.Global);
		}),

		// Register the command to enable/disable change tracking
		vscode.commands.registerCommand('tabd.toggleEnabled', async () => {
			const config = vscode.workspace.getConfiguration('tabd');
			const currentValue = config.get<boolean>('disabled', false);
			
			// Toggle the configuration value
			await config.update('disabled', !currentValue, vscode.ConfigurationTarget.Global);
		}),

		// Register the command to clear data for the current file
		vscode.commands.registerCommand('tabd.clearDataFile', async () => {
			const activeEditor = vscode.window.activeTextEditor;
			if (!activeEditor || activeEditor.document.uri.scheme !== 'file') {
				vscode.window.showWarningMessage('No active file editor found.');
				return;
			}

			const document = activeEditor.document;
			const workspaceFolder = vscode.workspace.getWorkspaceFolder(document.uri);
			if (!workspaceFolder) {
				vscode.window.showWarningMessage('File is not part of a workspace.');
				return;
			}

			const result = await vscode.window.showWarningMessage(
				`Are you sure you want to clear all Tab'd data for "${path.basename(document.uri.fsPath)}"? This action cannot be undone.`,
				{ modal: true },
				'Clear Data'
			);

			if (result === 'Clear Data') {
				try {
					await clearFileData(workspaceFolder, document);
					
					// Clear from memory
					const filePath = fsPath(document.uri);
					if (globalFileState[filePath]) {
						globalFileState[filePath] = { changes: [], pasteRanges: [], loadTimestamp: Date.now() - 1 };
					}
					
					// Update decorations to reflect cleared state
					triggerDecorationUpdate(document, []);
					
					vscode.window.showInformationMessage(`Tab'd data cleared for "${path.basename(document.uri.fsPath)}".`);
				} catch (error) {
					console.error('Failed to clear file data:', error);
					vscode.window.showErrorMessage(`Failed to clear Tab'd data: ${error instanceof Error ? error.message : String(error)}`);
				}
			}
		}),

		// Register the command to clear data for the current workspace or repository
		vscode.commands.registerCommand('tabd.clearDataWorkspace', async () => {
			const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
			if (!workspaceFolder) {
				vscode.window.showWarningMessage('No workspace folder found.');
				return;
			}

			const result = await vscode.window.showWarningMessage(
				`Are you sure you want to clear all Tab'd data for the entire workspace "${workspaceFolder.name}"? This action cannot be undone.`,
				{ modal: true },
				'Clear All Data'
			);

			if (result === 'Clear All Data') {
				try {
					await clearWorkspaceData(workspaceFolder);
					
					// Clear from memory
					globalFileState = {};
					
					// Update decorations for all visible editors
					for (const editor of vscode.window.visibleTextEditors) {
						if (editor.document.uri.scheme === 'file' && shouldProcessFile(editor.document.uri)) {
							triggerDecorationUpdate(editor.document, []);
						}
					}
					
					vscode.window.showInformationMessage(`All Tab'd data cleared for workspace "${workspaceFolder.name}".`);
				} catch (error) {
					console.error('Failed to clear workspace data:', error);
					vscode.window.showErrorMessage(`Failed to clear workspace data: ${error instanceof Error ? error.message : String(error)}`);
				}
			}
		}),

		// Register listener for window state changes
		vscode.window.onDidChangeWindowState(windowState => {
			if (windowState.focused && windowState.active) {
				enableClipboardTracking();
			} else {
				disableClipboardTracking();
			}
		}),

		// Register the command to gather events from other extensions
		vscode.commands.registerCommand('tabd._internal', async (args) => {
			// Check if tracking is disabled
			const config = vscode.workspace.getConfiguration('tabd');
			const disabled = config.get<boolean>('disabled', false);
			if (disabled) {
				return;
			}

			const obj = JSON.parse(String(args));

			let d = await vscode.workspace.openTextDocument(vscode.Uri.file(obj.filePath));

			if (obj._type === 'postInsertEdit') {
				editLock.runExclusive(async () => {
					let fileState = globalFileState[fsPath(mostRecentInternalCommand.document.uri)];
					let updatedRanges = getUpdatedRanges(
						fileState.changes,
						fileState.pasteRanges,
						mostRecentInternalCommand.changes,
						ExtendedRangeType.AIGenerated,
						mostRecentInternalCommand.document,
					);

					fileState.changes = updatedRanges;

					triggerDecorationUpdate(mostRecentInternalCommand.document, updatedRanges);
				});
				return;
			}
			
			mostRecentInternalCommand.value = obj;
			
			if (obj._type === 'createFile') {
				editLock.runExclusive(async () => {
					let fileState = globalFileState[fsPath(d.uri)];
					let updatedRanges: ExtendedRange[];

					if (!fileState) {
						fileState = globalFileState[fsPath(d.uri)] = { changes: [], pasteRanges: [], loadTimestamp: Date.now() - 1 };
					}
					
					updatedRanges = getUpdatedRanges(
						fileState.changes,
						fileState.pasteRanges,
						[
							{
								range: new vscode.Range(new vscode.Position(0, 0), new vscode.Position(0, 0)),
								rangeOffset: 0, // unused
								rangeLength: 0, // unused
								text: obj.insertText,
							}
						],
						undefined,
						d,
					);

					fileState.changes = updatedRanges;

					triggerDecorationUpdate(d, updatedRanges);
				});
			}
		}),
	);
	
	context.subscriptions.push(providerRegistrations);

	if (vscode.window.activeTextEditor) {
		loadGlobalFileStateForDocumentFromDisk(vscode.window.activeTextEditor.document);
		const config = vscode.workspace.getConfiguration('tabd');
		const showBlameByDefault = config.get<boolean>('showBlameByDefault', false);
		
		if (showBlameByDefault) {
			const filePath = fsPath(vscode.window.activeTextEditor.document.uri);
			const fileState = globalFileState[filePath];
			if (fileState && fileState.changes.length > 0) {
				triggerDecorationUpdate(vscode.window.activeTextEditor.document, fileState.changes);
			}
		}
	}

	enableClipboardTracking();
}

async function clearFileData(workspaceFolder: vscode.WorkspaceFolder, document: vscode.TextDocument): Promise<void> {
	const config = vscode.workspace.getConfiguration('tabd');
	const storageType = config.get<string>('storage', 'repository');

	if (storageType === 'experimental') {
		// Clear Git notes for this file
		try {
			const namespace = getGitNotesNamespace(workspaceFolder, document);
			
			// Get all commits with notes in this namespace
			try {
				const notesOutput = execSync(`git notes --ref=${namespace} list`, {
					cwd: workspaceFolder.uri.fsPath,
					encoding: 'utf8',
					timeout: 5000,
				}).trim();
				
				if (notesOutput) {
					const noteLines = notesOutput.split('\n').filter((line: string) => line.trim());
					
					for (const noteLine of noteLines) {
						const [, commitId] = noteLine.split(' ');
						if (commitId) {
							try {
								execSync(`git notes --ref=${namespace} remove ${commitId}`, {
									cwd: workspaceFolder.uri.fsPath,
									timeout: 5000,
								});
							} catch (removeError) {
								console.warn(`Failed to remove note for commit ${commitId}:`, removeError);
							}
						}
					}
					
					// Try to push the removal to origin
					try {
						execSync(`git push origin refs/notes/${namespace}`, {
							cwd: workspaceFolder.uri.fsPath,
							timeout: 15000,
						});
					} catch (pushError) {
						console.warn(`Failed to push Git notes deletion to origin:`, pushError);
					}
				}
			} catch (listError) {
				// No notes exist for this namespace, which is fine
				console.debug(`No Git notes found for namespace ${namespace}:`, listError);
			}
		} catch (error) {
			console.warn('Failed to clear Git notes:', error);
			throw new Error(`Failed to clear Git notes: ${error instanceof Error ? error.message : String(error)}`);
		}
	} else {
		// Clear traditional file-based storage (homeDirectory and repository)
		const logDir = getLogDirectory(workspaceFolder, document);
		
		if (fs.existsSync(logDir)) {
			const files = fs.readdirSync(logDir);
			const jsonFiles = files.filter(file => file.endsWith('.json'));
			
			for (const file of jsonFiles) {
				const filePath = path.join(logDir, file);
				try {
					fs.unlinkSync(filePath);
				} catch (error) {
					console.warn(`Failed to delete file ${filePath}:`, error);
				}
			}
			
			// Try to remove the directory if it's empty
			try {
				if (fs.readdirSync(logDir).length === 0) {
					fs.rmdirSync(logDir);
				}
			} catch (error) {
				// Directory might not be empty or might not exist, which is fine
			}
		}
	}
	
	// Clear any temporary files for experimental storage
	if (storageType === 'experimental') {
		const tempDir = path.join(getStorageDirectory(workspaceFolder, document), 'temp');
		if (fs.existsSync(tempDir)) {
			const files = fs.readdirSync(tempDir);
			const namespace = getGitNotesNamespace(workspaceFolder, document);
			const relatedFiles = files.filter(file => file.startsWith(namespace));
			
			for (const file of relatedFiles) {
				try {
					fs.unlinkSync(path.join(tempDir, file));
				} catch (error) {
					console.warn(`Failed to delete temp file ${file}:`, error);
				}
			}
		}
	}
}

async function clearWorkspaceData(workspaceFolder: vscode.WorkspaceFolder): Promise<void> {
	const config = vscode.workspace.getConfiguration('tabd');
	const storageType = config.get<string>('storage', 'repository');

	if (storageType === 'experimental') {
		// Clear all Git notes with tabd prefix
		try {
			// Get all tabd-related notes refs
			try {
				const refsOutput = execSync(`git for-each-ref refs/notes/tabd__*`, {
					cwd: workspaceFolder.uri.fsPath,
					encoding: 'utf8',
					timeout: 10000,
				}).trim();
				
				if (refsOutput) {
					const refLines = refsOutput.split('\n').filter((line: string) => line.trim());
					
					for (const refLine of refLines) {
						const parts = refLine.split('\t');
						if (parts.length >= 3) {
							const refName = parts[2]; // refs/notes/tabd__...
							const namespace = refName.replace('refs/notes/', '');
							
							try {
								// Remove all notes in this namespace
								const notesOutput = execSync(`git notes --ref=${namespace} list`, {
									cwd: workspaceFolder.uri.fsPath,
									encoding: 'utf8',
									timeout: 5000,
								}).trim();
								
								if (notesOutput) {
									const noteLines = notesOutput.split('\n').filter((line: string) => line.trim());
									
									for (const noteLine of noteLines) {
										const [, commitId] = noteLine.split(' ');
										if (commitId) {
											try {
												execSync(`git notes --ref=${namespace} remove ${commitId}`, {
													cwd: workspaceFolder.uri.fsPath,
													timeout: 5000,
												});
											} catch (removeError) {
												console.warn(`Failed to remove note for commit ${commitId}:`, removeError);
											}
										}
									}
								}
								
								// Try to push the removal to origin
								try {
									execSync(`git push origin refs/notes/${namespace}`, {
										cwd: workspaceFolder.uri.fsPath,
										timeout: 15000,
									});
								} catch (pushError) {
									console.warn(`Failed to push Git notes deletion to origin for ${namespace}:`, pushError);
								}
							} catch (error) {
								console.warn(`Failed to clear notes for namespace ${namespace}:`, error);
							}
						}
					}
				}
			} catch (listError) {
				// No tabd notes exist, which is fine
				console.debug('No tabd Git notes found:', listError);
			}
		} catch (error) {
			console.warn('Failed to clear Git notes:', error);
			throw new Error(`Failed to clear Git notes: ${error instanceof Error ? error.message : String(error)}`);
		}
	} else {
		// Clear traditional file-based storage (homeDirectory and repository)
		const storageDir = getStorageDirectory(workspaceFolder, { uri: workspaceFolder.uri } as vscode.TextDocument);
		
		if (fs.existsSync(storageDir)) {
			try {
				// Remove the entire storage directory recursively
				fs.rmSync(storageDir, { recursive: true, force: true });
			} catch (error) {
				console.warn(`Failed to remove storage directory ${storageDir}:`, error);
				throw new Error(`Failed to remove storage directory: ${error instanceof Error ? error.message : String(error)}`);
			}
		}
	}
	
	// Clear experimental storage temp directory
	if (storageType === 'experimental') {
		const storageDir = getStorageDirectory(workspaceFolder, { uri: workspaceFolder.uri } as vscode.TextDocument);
		if (fs.existsSync(storageDir)) {
			try {
				fs.rmSync(storageDir, { recursive: true, force: true });
			} catch (error) {
				console.warn(`Failed to remove experimental storage directory ${storageDir}:`, error);
			}
		}
	}
}

export function deactivate() {}

function loadGlobalFileStateForDocumentFromDisk(document: vscode.TextDocument | undefined) {
	if (!document) {
		return;
	}

	if (document.uri.scheme !== 'file' || !shouldProcessFile(document.uri)) {
		return;
	}

	const filePath = fsPath(document.uri);
	if (globalFileState[filePath]) {
		return; // Already loaded
	}

	globalFileState[filePath] = { changes: [], pasteRanges: [], loadTimestamp: Date.now() - 1 };

	// Check is Git is initialized at the workspace root
	const workspaceFolder = vscode.workspace.getWorkspaceFolder(document.uri);
	if (!workspaceFolder) {
		return;
	}

	// Check is Git is initialized at the workspace root (required for repository and gitnotes storage)
	const config = vscode.workspace.getConfiguration('tabd');
	const storageType = config.get<string>('storage', 'repository');
	
	if (storageType === 'repository' || storageType === 'experimental') {
		// Set the current user if not already set
		if (currentUser === "") {
			currentUser = getCurrentGitUser(workspaceFolder) || "";
		}

		const gitPath = path.join(workspaceFolder.uri.fsPath, '.git');
		const isGitRepo = fs.existsSync(gitPath);
		
		if (!isGitRepo) {
			return;
		}
	}

	// Handle gitnotes storage
	if (storageType === 'experimental') {
		const namespace = getGitNotesNamespace(workspaceFolder, document);
		const noteData = loadFromGitNotes(workspaceFolder, document, namespace);
		
		let updatedRanges: ExtendedRange[] = [];
		
		for (const fileState of noteData) {
			if (fileState.version !== 1) {
				continue; // Unsupported version
			}
			
			const newChanges = fileState.changes.map(change => {
				const options = new ExtendedRangeOptions();
				options.pasteUrl = change.pasteUrl || "";
				options.pasteTitle = change.pasteTitle || "";
				options.aiName = change.aiName || "";
				options.aiModel = change.aiModel || "";
				options.aiExplanation = change.aiExplanation || "";
				options.aiType = change.aiType || "";

				return new ExtendedRange(
					new vscode.Position(change.start.line, change.start.character),
					new vscode.Position(change.end.line, change.end.character),
					change.type,
					change.creationTimestamp,
					change.author || "",
					options,
				);
			});

			updatedRanges = mergeRangesSequentially(updatedRanges, newChanges);
		}
		
		globalFileState[filePath].changes = updatedRanges;
		return;
	}

	// Handle traditional file-based storage (homeDirectory and repository)
	const fileChangeRecordDir = getLogDirectory(workspaceFolder, document);

	if (!fs.existsSync(fileChangeRecordDir)) {
		return; // No file state found
	}

	const fileChangeRecords = fs.readdirSync(fileChangeRecordDir)
		.filter(file => file.endsWith('.json'))
		.map(file => path.join(fileChangeRecordDir, file));
	
	if (fileChangeRecords.length === 0) {
		return; // No file state found
	}

	// Sort file change records by filename (which includes timestamp) to process chronologically
	fileChangeRecords.sort();

	let updatedRanges: ExtendedRange[] = [];

	for (const fileChangeRecordPath of fileChangeRecords) {
		try {
			const fileState: SerializedFileState = JSON.parse(fs.readFileSync(fileChangeRecordPath, 'utf8'));
			if (fileState.version !== 1) {
				continue; // Unsupported version
			}
			
			const newChanges = fileState.changes.map(change => {
				const options = new ExtendedRangeOptions();
				options.pasteUrl = change.pasteUrl || "";
				options.pasteTitle = change.pasteTitle || "";
				options.aiName = change.aiName || "";
				options.aiModel = change.aiModel || "";
				options.aiExplanation = change.aiExplanation || "";
				options.aiType = change.aiType || "";

				return new ExtendedRange(
					new vscode.Position(change.start.line, change.start.character),
					new vscode.Position(change.end.line, change.end.character),
					change.type,
					change.creationTimestamp,
					change.author || "",
					options,
				);
			});

			updatedRanges = mergeRangesSequentially(updatedRanges, newChanges);
		} catch (error) {
			console.warn(`Failed to load file state from ${fileChangeRecordPath}:`, error);
		}
	}

	globalFileState[filePath].changes = updatedRanges;
}
