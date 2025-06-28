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

export function activate(context: vscode.ExtensionContext) {
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

			for (const editor of vscode.window.visibleTextEditors) {
				if (editor.document === e.document) {
					editor.setDecorations(userEditDecorator, updatedRanges.filter(range => range.getType() === ExtendedRangeType.UserEdit));
					editor.setDecorations(aiModificationDecorator, updatedRanges.filter(range => range.getType() === ExtendedRangeType.AIModification));
					editor.setDecorations(undoRedoDecorator, updatedRanges.filter(range => range.getType() === ExtendedRangeType.UndoRedo));
					editor.setDecorations(pasteDecorator, updatedRanges.filter(range => range.getType() === ExtendedRangeType.Paste));
					editor.setDecorations(unknownDecorator, updatedRanges.filter(range => range.getType() === ExtendedRangeType.Unknown));
				}
			}
        });
	});

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
					
					fs.writeFileSync(fileChangeRecordPath, JSON.stringify({
						version: 1,
						changes: fileState.changes.map(change => ({
							start: change.start,
							end: change.end,
							type: change.getType(),
							creationTimestamp: change.getCreationTimestamp(),
						})),
					}));
				}

				// Update the global file state
				fileState.savePath = fileChangeRecordPath;
				globalFileState[fsPath(e.uri)] = fileState;
			});
		}
	});

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
		})
	);
	
	context.subscriptions.push(providerRegistrations);
}

export function deactivate() {}
