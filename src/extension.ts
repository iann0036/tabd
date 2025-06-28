import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execSync } from 'child_process';
import { getUpdatedRanges } from "./positionalTracking";
import { Mutex } from 'async-mutex';
import { fsPath, uniqueFileName, shouldProcessFile } from './utils';
import { ExtendedRange, ExtendedRangeType, mergeRangesSequentially } from './extendedRange';
import { PasteEditProvider } from './pasteEditProvider';
import { triggerDecorationUpdate } from './decorators';

var editLock = new Mutex();
var globalFileState: {
	[key: string]: {
		changes: ExtendedRange[],
		savePath?: string,
		pasteRanges: ExtendedRange[],
		loadTimestamp?: number,
	},
} = {};

interface SerializedChange {
	start: { line: number; character: number };
	end: { line: number; character: number };
	type: ExtendedRangeType;
	creationTimestamp: number;
	author?: string;
}

interface SerializedFileState {
	version: number;
	changes: SerializedChange[];
}

let currentUser: string = "";

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
						{
							onDeletion: 'shrink',
							onAddition: 'split',
						},
						e.reason,
						e.document,
					);
				}

				fileState.changes = updatedRanges;

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
		vscode.workspace.onDidSaveTextDocument(e => {
			if (e.uri.scheme !== 'file' || !shouldProcessFile(e.uri)) {
				return;
			}
			
			// Check if tracking is disabled
			const config = vscode.workspace.getConfiguration('tabd');
			const disabled = config.get<boolean>('disabled', false);
			if (disabled) {
				return;
			}
			
			if (globalFileState[fsPath(e.uri)]) {
				editLock.runExclusive(() => {
					// Save the current state of the file
					const fileState = globalFileState[fsPath(e.uri)];

					// If there are no changes recorded, skip saving
					if (!fileState || fileState.changes.length === 0) {
						console.warn(`No changes recorded for ${e.uri.fsPath}. Skipping file state save.`);
						return;
					}

					const workspaceFolder = vscode.workspace.getWorkspaceFolder(e.uri);
					if (!workspaceFolder) {
						console.warn(`No workspace folder found for ${e.uri.fsPath}. Cannot save file state.`);
						return;
					}

					const config = vscode.workspace.getConfiguration('tabd');
					const storageType = config.get<string>('storage', 'repository');

					if (currentUser === "" && storageType === 'repository') {
						currentUser = getCurrentGitUser(workspaceFolder);
					}

					// Write to existing file if it exists
					if (fileState.savePath) {
						fs.writeFileSync(fileState.savePath, JSON.stringify({
							version: 1,
							changes: fileState.changes
								.filter(change => change.getCreationTimestamp() > (fileState.loadTimestamp || 0))
								.map(change => ({
									start: change.start,
									end: change.end,
									type: change.getType(),
									creationTimestamp: change.getCreationTimestamp(),
									author: change.getAuthor() || currentUser || (storageType === 'repository' ? 'an unknown user' : ''),
								})),
						}));
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
					const baseStorageDir = getStorageDirectory(workspaceFolder, e);
					if (!fs.existsSync(baseStorageDir)) {
						fs.mkdirSync(baseStorageDir, { recursive: true });
						// TODO: Make a README.md file in the storage directory
					}

					// Write the file state to a JSON file
					const fileChangeRecordDir = getLogDirectory(workspaceFolder, e);
					const fileChangeRecordPath = path.join(fileChangeRecordDir, uniqueFileName());
					if (!fs.existsSync(fileChangeRecordDir)) {
						fs.mkdirSync(fileChangeRecordDir, { recursive: true });
					}
					if (fs.existsSync(fileChangeRecordPath)) {
						throw new Error(`File change record already exists at ${fileChangeRecordPath}. This should not happen!`);
					}
					
					// TODO: Add a whole file hash to ensure the file state is valid
					fs.writeFileSync(fileChangeRecordPath, JSON.stringify({
						version: 1,
						changes: fileState.changes
							.filter(change => change.getCreationTimestamp() > (fileState.loadTimestamp || 0))
							.map(change => ({
								start: change.start,
								end: change.end,
								type: change.getType(),
								creationTimestamp: change.getCreationTimestamp(),
								author: change.getAuthor() || currentUser || (storageType === 'repository' ? 'an unknown user' : ''),
							})),
					}));

					// Update the global file state
					fileState.savePath = fileChangeRecordPath;
					globalFileState[fsPath(e.uri)] = fileState;
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
}

export function deactivate() {}

/**
 * Get the current Git user name
 * @param workspaceFolder The workspace folder containing the Git repository
 * @returns The current Git user name or 'You' if unable to determine
 */
function getCurrentGitUser(workspaceFolder: vscode.WorkspaceFolder): string {
	try {
		const userCommand = 'git config user.name';
		const currentUser = execSync(userCommand, {
			cwd: workspaceFolder.uri.fsPath,
			encoding: 'utf8',
			timeout: 2000,
		}).trim();
		
		if (currentUser && currentUser.trim().length > 1) {
			return currentUser;
		}
	} catch (error) {
		console.warn('Failed to get current Git user:', error);
	}

	try {
		const userCommand = 'git config user.email';
		const currentUser = execSync(userCommand, {
			cwd: workspaceFolder.uri.fsPath,
			encoding: 'utf8',
			timeout: 2000,
		}).trim();
		
		if (currentUser && currentUser.trim().length > 1) {
			return currentUser;
		}
	} catch (error) {
		console.warn('Failed to get current Git user:', error);
	}

	return '';
}

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

	// Check is Git is initialized at the workspace root (only required for repository storage)
	const config = vscode.workspace.getConfiguration('tabd');
	const storageType = config.get<string>('storage', 'repository');
	
	if (storageType === 'repository') {
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
				return new ExtendedRange(
					new vscode.Position(change.start.line, change.start.character),
					new vscode.Position(change.end.line, change.end.character),
					change.type,
					change.creationTimestamp,
					change.author || "",
				);
			});

			updatedRanges = mergeRangesSequentially(updatedRanges, newChanges);
		} catch (error) {
			console.warn(`Failed to load file state from ${fileChangeRecordPath}:`, error);
		}
	}

	globalFileState[filePath].changes = updatedRanges;
}

function getStorageDirectory(workspaceFolder: vscode.WorkspaceFolder, document: vscode.TextDocument): string {
	const config = vscode.workspace.getConfiguration('tabd');
	const storageType = config.get<string>('storage', 'repository');
	
	if (storageType === 'homeDirectory') {
		// Create sanitized workspace path for home directory storage
		const workspacePath = workspaceFolder.uri.fsPath;
		const sanitizedPath = workspacePath
			.replace(/[^a-zA-Z0-9]/g, '_')
			.replace(/_+/g, '_')
			.replace(/^_|_$/g, '');
		
		return path.join(os.homedir(), '.tabd', 'workspaces', sanitizedPath);
	} else if (storageType === 'repository') {
		return path.join(workspaceFolder.uri.fsPath, '.tabd');
	} else {
		throw new Error(`Unsupported storage type: ${storageType}`);
	}
}

function getLogDirectory(workspaceFolder: vscode.WorkspaceFolder, document: vscode.TextDocument): string {
	const baseStorageDir = getStorageDirectory(workspaceFolder, document);
	const relativePath = vscode.workspace.asRelativePath(document.uri, false);
	return path.join(baseStorageDir, 'log', relativePath);
}
