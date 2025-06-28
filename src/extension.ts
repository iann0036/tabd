import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { getUpdatedRanges } from "./positionalTracking";
import { Mutex } from 'async-mutex';
import { fsPath, uniqueFileName, shouldProcessFile } from './utils';
import { ExtendedRange, ExtendedRangeType } from './extendedRange';
import { PasteEditProvider } from './pasteEditProvider';

const userEditDecorator = vscode.window.createTextEditorDecorationType({
	backgroundColor: "#00ffff33",
	//isWholeLine: true,
	rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
});

const aiModificationDecorator = vscode.window.createTextEditorDecorationType({
	//backgroundColor: "#00ff0033",
	outlineColor: "#00ff0033",
	outline: "1px solid",
	//isWholeLine: true,
	rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
});

const undoRedoDecorator = vscode.window.createTextEditorDecorationType({
	backgroundColor: "#0000ff33",
	//isWholeLine: true,
	rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
});

const unknownDecorator = vscode.window.createTextEditorDecorationType({
	backgroundColor: "#dddddd33",
	//isWholeLine: true,
	rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
});

const pasteDecorator = vscode.window.createTextEditorDecorationType({
	backgroundColor: "#ff00ff33",
	//isWholeLine: true,
	rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
});

var editLock = new Mutex();
var globalFileState: {
	[key: string]: {
		changes: ExtendedRange[],
		savePath?: string,
		pasteRanges: ExtendedRange[],
	},
} = {};

function triggerDecorationUpdate(d: vscode.TextDocument, updatedRanges: ExtendedRange[]) {
	const config = vscode.workspace.getConfiguration('tabd');
	const showBlameByDefault = config.get<boolean>('showBlameByDefault', false);

	if (showBlameByDefault) {
		forceShowDecorations(d, updatedRanges);
		return;
	}
	
	// Clear decorations when blame is not shown by default
	for (const editor of vscode.window.visibleTextEditors) {
		if (editor.document === d) {
			editor.setDecorations(userEditDecorator, []);
			editor.setDecorations(aiModificationDecorator, []);
			editor.setDecorations(undoRedoDecorator, []);
			editor.setDecorations(pasteDecorator, []);
			editor.setDecorations(unknownDecorator, []);
		}
	}
}

function forceShowDecorations(d: vscode.TextDocument, updatedRanges: ExtendedRange[]) {
	for (const editor of vscode.window.visibleTextEditors) {
		if (editor.document === d) {
			editor.setDecorations(userEditDecorator, updatedRanges.filter(range => range.getType() === ExtendedRangeType.UserEdit));
			editor.setDecorations(aiModificationDecorator, updatedRanges.filter(range => range.getType() === ExtendedRangeType.AIModification));
			editor.setDecorations(undoRedoDecorator, updatedRanges.filter(range => range.getType() === ExtendedRangeType.UndoRedo));
			editor.setDecorations(pasteDecorator, updatedRanges.filter(range => range.getType() === ExtendedRangeType.Paste));
			editor.setDecorations(unknownDecorator, updatedRanges.filter(range => range.getType() === ExtendedRangeType.Unknown));
		}
	}
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
		vscode.commands.registerCommand('tabd.blame', async () => {
			const editor = vscode.window.activeTextEditor;
			if (!editor) {
				vscode.window.showErrorMessage("No active text editor currently open.");
				return;
			} else if (!editor || editor.document.uri.scheme !== 'file' || !shouldProcessFile(editor.document.uri)) {
				vscode.window.showErrorMessage("No active text editor or unsupported file type.");
				return;
			}
			const filePath = fsPath(editor.document.uri);
			const fileState = globalFileState[filePath];
			if (!fileState) {
				//vscode.window.showErrorMessage("No changes recorded for this file.");
				return;
			}
			const changes = fileState.changes;
			if (changes.length === 0) {
				//vscode.window.showInformationMessage("No changes recorded for this file.");
				return;
			}
			const changeInfo = changes.map(change => {
				return `Change from ${change.start.line + 1}:${change.start.character} to ${change.end.line + 1}:${change.end.character} - Type: ${change.getType()} - Created at: ${new Date(change.getCreationTimestamp()).toLocaleString()}`;
			}).join('\n');
			const message = `Changes in ${path.basename(filePath)}:\n${changeInfo}`;
			vscode.window.showInformationMessage(message);

			forceShowDecorations(editor.document, changes);
		}),
	);
	
	context.subscriptions.push(providerRegistrations);
}

export function deactivate() {}
