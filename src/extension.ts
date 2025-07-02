import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execSync } from 'child_process';
import { getUpdatedRanges } from "./positionalTracking";
import { Mutex } from 'async-mutex';
import { fsPath, uniqueFileName, shouldProcessFile } from './utils';
import { ExtendedRange, ExtendedRangeOptions, ExtendedRangeType, mergeRangesSequentially } from './extendedRange';
import { PasteEditProvider } from './pasteEditProvider';
import { triggerDecorationUpdate } from './decorators';
import { createHash } from 'crypto';

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
	pasteUrl?: string;
	pasteTitle?: string;
	aiName?: string;
	aiModel?: string;
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
	} else if (storageType === 'experimental') {
		// For gitnotes, use home directory to store temporary files before applying to git notes
		const workspacePath = workspaceFolder.uri.fsPath;
		const sanitizedPath = workspacePath
			.replace(/[^a-zA-Z0-9]/g, '_')
			.replace(/_+/g, '_')
			.replace(/^_|_$/g, '');
		
		return path.join(os.homedir(), '.tabd', 'experimental', sanitizedPath);
	} else {
		throw new Error(`Unsupported storage type: ${storageType}`);
	}
}

function getLogDirectory(workspaceFolder: vscode.WorkspaceFolder, document: vscode.TextDocument): string {
	const config = vscode.workspace.getConfiguration('tabd');
	const storageType = config.get<string>('storage', 'repository');
	
	if (storageType === 'experimental') {
		// For gitnotes, we don't use a traditional log directory structure
		// Instead, we create a temp directory for note content files
		const baseStorageDir = getStorageDirectory(workspaceFolder, document);
		return path.join(baseStorageDir, 'temp');
	} else {
		const baseStorageDir = getStorageDirectory(workspaceFolder, document);
		const relativePath = vscode.workspace.asRelativePath(document.uri, false);
		return path.join(baseStorageDir, 'log', relativePath);
	}
}

/**
 * Generate a Git notes namespace for a file
 * @param workspaceFolder The workspace folder
 * @param document The document
 * @returns The Git notes namespace (e.g., "tabd__directory1__file1.txt")
 */
function getGitNotesNamespace(workspaceFolder: vscode.WorkspaceFolder, document: vscode.TextDocument): string {
	const relativePath = vscode.workspace.asRelativePath(document.uri, false);
	// Replace path separators and special characters with double underscores
	const namespace = relativePath
		.replace(/[/\\]/g, '__')
		.replace(/[^a-zA-Z0-9._-]/g, '_');

	const sha256namespace = createHash('sha256').update(namespace).digest('hex');

	const branchNameOutput = execSync(`git rev-parse --abbrev-ref HEAD`, {
		cwd: workspaceFolder.uri.fsPath,
		encoding: 'utf8',
		timeout: 2000,
	}).trim();
	
	return `tabd__${branchNameOutput}__${sha256namespace}`;
}

/**
 * Save data to Git notes
 * @param workspaceFolder The workspace folder
 * @param document The document
 * @param data The data to save
 * @param namespace The Git notes namespace
 */
function saveToGitNotes(workspaceFolder: vscode.WorkspaceFolder, document: vscode.TextDocument, data: SerializedFileState, namespace: string): void {
	try {
		// Create temporary file with the note content
		const tempDir = getLogDirectory(workspaceFolder, document);
		if (!fs.existsSync(tempDir)) {
			fs.mkdirSync(tempDir, { recursive: true });
		}
		
		const tempFilePath = path.join(tempDir, `${namespace}_${Date.now()}.json`);
		fs.writeFileSync(tempFilePath, JSON.stringify(data, null, 2));
		
		// Get the HEAD commit hash
		const headCommit = execSync('git rev-parse HEAD', {
			cwd: workspaceFolder.uri.fsPath,
			encoding: 'utf8',
			timeout: 5000,
		}).trim();
		
		// Add the note using the temporary file
		execSync(`git notes --ref=${namespace} add -f -F "${tempFilePath}" ${headCommit}`, {
			cwd: workspaceFolder.uri.fsPath,
			timeout: 10000,
		});
		
		// Push the notes to origin
		try {
			execSync(`git push origin refs/notes/${namespace}`, {
				cwd: workspaceFolder.uri.fsPath,
				timeout: 15000,
			});
		} catch (pushError) {
			console.warn(`Failed to push Git notes to origin for namespace ${namespace}:`, pushError);
		}
		
		// Clean up temporary file
		fs.unlinkSync(tempFilePath);
	} catch (error) {
		console.warn(`Failed to save to Git notes namespace ${namespace}:`, error);
		throw error;
	}
}

/**
 * Load data from Git notes
 * @param workspaceFolder The workspace folder
 * @param document The document
 * @param namespace The Git notes namespace
 * @returns The loaded data or null if not found
 */
function loadFromGitNotes(workspaceFolder: vscode.WorkspaceFolder, document: vscode.TextDocument, namespace: string): SerializedFileState[] {
	try {
		// Pull notes from origin first
		try {
			execSync(`git fetch origin refs/notes/${namespace}:refs/notes/${namespace}`, {
				cwd: workspaceFolder.uri.fsPath,
				timeout: 15000,
			});
		} catch (pullError) {
			console.warn(`Failed to pull Git notes from origin for namespace ${namespace}:`, pullError);
		}
		
		// List all notes for this namespace
		const notesOutput = execSync(`git notes --ref=${namespace} list`, {
			cwd: workspaceFolder.uri.fsPath,
			encoding: 'utf8',
			timeout: 5000,
		}).trim();
		
		if (!notesOutput) {
			return [];
		}
		
		const notes: SerializedFileState[] = [];
		const noteLines = notesOutput.split('\n').filter(line => line.trim());
		
		for (const noteLine of noteLines) {
			const [noteId, commitId] = noteLine.split(' ');
			if (!noteId || !commitId) {
				continue;
			}
			
			try {
				// Get the note content
				const noteContent = execSync(`git notes --ref=${namespace} show ${commitId}`, {
					cwd: workspaceFolder.uri.fsPath,
					encoding: 'utf8',
					timeout: 5000,
				});
				
				const noteData: SerializedFileState = JSON.parse(noteContent);
				if (noteData.version === 1) {
					notes.push(noteData);
				}
			} catch (noteError) {
				console.warn(`Failed to load note ${noteId} for commit ${commitId}:`, noteError);
			}
		}
		
		// Sort by creation timestamp if available
		notes.sort((a, b) => {
			const aTime = a.changes.length > 0 ? Math.min(...a.changes.map(c => c.creationTimestamp)) : 0;
			const bTime = b.changes.length > 0 ? Math.min(...b.changes.map(c => c.creationTimestamp)) : 0;
			return aTime - bTime;
		});
		
		return notes;
	} catch (error) {
		console.warn(`Failed to load from Git notes namespace ${namespace}:`, error);
		return [];
	}
}

function mergeUserEdits(userEdits: ExtendedRange[]): ExtendedRange[] {
	// Filter only USER_EDIT ranges and sort by position
	const userEditRanges = userEdits
		.filter(range => range.getType() === ExtendedRangeType.UserEdit)
		.sort((a, b) => {
			if (a.start.line !== b.start.line) {
				return a.start.line - b.start.line;
			}
			return a.start.character - b.start.character;
		});

	if (userEditRanges.length <= 1) {
		return userEdits; // Nothing to merge
	}

	const mergedRanges: ExtendedRange[] = [];
	const nonUserEdits = userEdits.filter(range => range.getType() !== ExtendedRangeType.UserEdit);
	
	let currentGroup: ExtendedRange[] = [userEditRanges[0]];

	for (let i = 1; i < userEditRanges.length; i++) {
		const current = userEditRanges[i];
		const previous = currentGroup[currentGroup.length - 1];

		// Check if ranges are adjacent (previous.end equals current.start)
		const areAdjacent = previous.end.isEqual(current.start);
		
		// Check if timestamp difference is less than 60 seconds (60000 ms)
		const timeDiff = Math.abs(current.getCreationTimestamp() - previous.getCreationTimestamp());
		const withinTimeLimit = timeDiff < 60000;

		if (areAdjacent && withinTimeLimit) {
			// Add to current group
			currentGroup.push(current);
		} else {
			// Process current group and start a new one
			if (currentGroup.length > 1) {
				// Merge the group
				const earliestTimestamp = Math.min(...currentGroup.map(r => r.getCreationTimestamp()));
				const mergedRange = new ExtendedRange(
					currentGroup[0].start,
					currentGroup[currentGroup.length - 1].end,
					ExtendedRangeType.UserEdit,
					earliestTimestamp,
					currentGroup[0].getAuthor(),
					currentGroup[0].getOptions()
				);
				mergedRanges.push(mergedRange);
			} else {
				// Single range, add as is
				mergedRanges.push(currentGroup[0]);
			}
			
			// Start new group
			currentGroup = [current];
		}
	}

	// Process the last group
	if (currentGroup.length > 1) {
		const earliestTimestamp = Math.min(...currentGroup.map(r => r.getCreationTimestamp()));
		const mergedRange = new ExtendedRange(
			currentGroup[0].start,
			currentGroup[currentGroup.length - 1].end,
			ExtendedRangeType.UserEdit,
			earliestTimestamp,
			currentGroup[0].getAuthor(),
			currentGroup[0].getOptions()
		);
		mergedRanges.push(mergedRange);
	} else if (currentGroup.length === 1) {
		mergedRanges.push(currentGroup[0]);
	}

	// Return all ranges (merged user edits + non-user edits)
	return [...mergedRanges, ...nonUserEdits];
}