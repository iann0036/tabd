import * as vscode from 'vscode';
import { getUpdatedRanges } from "./positionalTracking";
import { Mutex } from 'async-mutex';
import { fsPath } from './utils';
import { ExtendedRange, ExtendedRangeType } from './extendedRange';

const debugOutputChannel = vscode.window.createOutputChannel("Debug Tabd Repo Validation");

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

var editLock = new Mutex();
var globalFileState: {
	[key: string]: {
		changes: ExtendedRange[],
	},
} = {};

export function activate(context: vscode.ExtensionContext) {
	vscode.workspace.onDidChangeTextDocument(e => {
		if (e.document.uri.scheme !== 'file') {
			return;
		}

		console.log(JSON.stringify(e.contentChanges, null, 2));

		return editLock.runExclusive(async () => {
			let fileState = globalFileState[fsPath(e.document.uri)];
			let updatedRanges: ExtendedRange[];

			if (!fileState) {
				fileState = globalFileState[fsPath(e.document.uri)] = { changes: [] };
				updatedRanges = [];
			} else {
				updatedRanges = getUpdatedRanges(
					fileState.changes,
					e.contentChanges,
					{
						onDeletion: 'shrink',
						onAddition: 'split',
						outputChannel: debugOutputChannel,
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
					editor.setDecorations(unknownDecorator, updatedRanges.filter(range => range.getType() === ExtendedRangeType.Unknown));
				}
			}
        });
	});
}



export function deactivate() {}
