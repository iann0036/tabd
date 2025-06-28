import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { getUpdatedRanges } from "./positionalTracking";
import { Mutex } from 'async-mutex';
import { fsPath, uniqueFileName, shouldProcessFile } from './utils';
import { ExtendedRange, ExtendedRangeType } from './extendedRange';
import { PasteEditProvider } from './pasteEditProvider';
import { triggerDecorationUpdate, forceShowDecorations } from './decorators';

var editLock = new Mutex();
var globalFileState: {
	[key: string]: {
		changes: ExtendedRange[],
		savePath?: string,
		pasteRanges: ExtendedRange[],
	},
} = {};

interface SerializedChange {
	start: { line: number; character: number };
	end: { line: number; character: number };
	type: ExtendedRangeType;
	creationTimestamp: number;
}

interface SerializedFileState {
	version: number;
	changes: SerializedChange[];
}

export function activate(context: vscode.ExtensionContext) {
	// Exclude the .tabd directory from the file explorer
	const files = vscode.workspace.getConfiguration('files');
	const exclude = files.get('exclude') as Record<string, boolean>;
	exclude['**/.tabd'] = true;
	files.update('exclude', exclude, vscode.ConfigurationTarget.Global);

	const notifyPaste = function (d: vscode.TextDocument, ranges: readonly vscode.Range[]) {
		return editLock.runExclusive(async () => {
			let fileState = globalFileState[fsPath(d.uri)];
			if (!fileState) {
				fileState = globalFileState[fsPath(d.uri)] = { changes: [], pasteRanges: [] };
			}

			for (const range of ranges) {
				// Create a new range for the paste operation
				const now = Date.now();
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

			return editLock.runExclusive(async () => {
				let fileState = globalFileState[fsPath(e.document.uri)];
				let updatedRanges: ExtendedRange[];

				if (!fileState) {
					fileState = globalFileState[fsPath(e.document.uri)] = { changes: [], pasteRanges: [] };
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

			loadGlobalFileStateForDocumentFromDisk(editor.document);

			const config = vscode.workspace.getConfiguration('tabd');
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
		}),

		// Register the listener for saving text documents
		vscode.workspace.onDidSaveTextDocument(e => {
			if (e.uri.scheme !== 'file' || !shouldProcessFile(e.uri)) {
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

					// Write to existing file if it exists
					if (fileState.savePath) {
						fs.writeFileSync(fileState.savePath, JSON.stringify({
							version: 1,
							changes: fileState.changes.map(change => ({
								start: change.start,
								end: change.end,
								type: change.getType(),
								creationTimestamp: change.getCreationTimestamp(),
							})),
						}));
						return;
					}

					// Check is Git is initialized at the workspace root
					const workspaceFolder = vscode.workspace.getWorkspaceFolder(e.uri);
					if (!workspaceFolder) {
						console.warn(`No workspace folder found for ${e.uri.fsPath}. Cannot save file state.`);
						return;
					}

					const gitPath = path.join(workspaceFolder.uri.fsPath, '.git');
					const isGitRepo = fs.existsSync(gitPath);
					
					if (!isGitRepo) {
						console.warn('No Git repository found. Skipping file state save.');
						return;
					}
					
					// Create .tabd/
					const tabdDir = path.join(workspaceFolder.uri.fsPath, '.tabd');
					if (!fs.existsSync(tabdDir)) {
						fs.mkdirSync(tabdDir, { recursive: true });
						// TODO: Make a README.md file in the .tabd directory
					}

					// Write the file state to a JSON file
					const relativePath = vscode.workspace.asRelativePath(e.uri, false);
					const fileChangeRecordDir = path.join(workspaceFolder.uri.fsPath, '.tabd', 'log', relativePath);
					const fileChangeRecordPath = path.join(workspaceFolder.uri.fsPath, '.tabd', 'log', relativePath, uniqueFileName());
					if (!fs.existsSync(fileChangeRecordDir)) {
						fs.mkdirSync(fileChangeRecordDir, { recursive: true });
					}
					if (fs.existsSync(fileChangeRecordPath)) {
						throw new Error(`File change record already exists at ${fileChangeRecordPath}. This should not happen!`);
					}
					
					fs.writeFileSync(fileChangeRecordPath, JSON.stringify({
						version: 1,
						changes: fileState.changes.map(change => ({
							start: change.start,
							end: change.end,
							type: change.getType(),
							creationTimestamp: change.getCreationTimestamp(),
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

	globalFileState[filePath] = { changes: [], pasteRanges: [] };

	// Check is Git is initialized at the workspace root
	const workspaceFolder = vscode.workspace.getWorkspaceFolder(document.uri);
	if (!workspaceFolder) {
		return;
	}

	const gitPath = path.join(workspaceFolder.uri.fsPath, '.git');
	const isGitRepo = fs.existsSync(gitPath);
	
	if (!isGitRepo) {
		return;
	}

	const relativePath = vscode.workspace.asRelativePath(document.uri, false);
	const fileChangeRecordDir = path.join(workspaceFolder.uri.fsPath, '.tabd', 'log', relativePath);

	if (!fs.existsSync(fileChangeRecordDir)) {
		return; // No file state found
	}

	const fileChangeRecords = fs.readdirSync(fileChangeRecordDir)
		.filter(file => file.endsWith('.json'))
		.map(file => path.join(fileChangeRecordDir, file));
	
	if (fileChangeRecords.length === 0) {
		return; // No file state found
	}

	for (const fileChangeRecordPath of fileChangeRecords) {
		try {
			const fileState = JSON.parse(fs.readFileSync(fileChangeRecordPath, 'utf8'));
			if (fileState.version !== 1) {
				continue; // Unsupported version
			}

			const fileStateTyped: SerializedFileState = fileState;
			const changes: ExtendedRange[] = fileStateTyped.changes.map((change: SerializedChange) => new ExtendedRange(
				new vscode.Position(change.start.line, change.start.character),
				new vscode.Position(change.end.line, change.end.character),
				change.type,
				change.creationTimestamp
			));

			// TODO: Add a whole file hash to ensure the file state is valid

			globalFileState[filePath].changes.push(...changes);
		} catch (error) {
			console.warn(`Failed to load file state from ${fileChangeRecordPath}:`, error);
		}
	}
}
