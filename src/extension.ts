import * as vscode from 'vscode';
import { getUpdatedRanges, getUpdatedPosition } from "./positionalTracking";
import { Mutex } from 'async-mutex';
import { fsPath } from './utils';
import { ExtendedRange, ExtendedRangeType } from './extendedRange';

const debugOutputChannel = vscode.window.createOutputChannel("Debug Tabd Repo Validation");

const decorationType1 = vscode.window.createTextEditorDecorationType({
	backgroundColor: "#ff000033",
	//isWholeLine: true,
	rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
});

const decorationType2 = vscode.window.createTextEditorDecorationType({
	backgroundColor: "#00ff0033",
	//isWholeLine: true,
	rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
});

const decorationType3 = vscode.window.createTextEditorDecorationType({
	backgroundColor: "#0000ff33",
	//isWholeLine: true,
	rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
});

const decorationType4 = vscode.window.createTextEditorDecorationType({
	backgroundColor: "#ffff0033",
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
			let pendingRanges: ExtendedRange[] = [];
			let preservationRanges: vscode.Range[] = [];

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
					editor.setDecorations(decorationType1, updatedRanges.filter(range => range.getType() === ExtendedRangeType.UserEdit).map(range => new vscode.Range(range.start, range.end)));
					editor.setDecorations(decorationType2, updatedRanges.filter(range => range.getType() === ExtendedRangeType.AIModification).map(range => new vscode.Range(range.start, range.end)));
					editor.setDecorations(decorationType3, updatedRanges.filter(range => range.getType() === ExtendedRangeType.UndoRedo).map(range => new vscode.Range(range.start, range.end)));
					editor.setDecorations(decorationType4, updatedRanges.filter(range => range.getType() === ExtendedRangeType.Unknown).map(range => new vscode.Range(range.start, range.end)));
				}
			}
        });
	});
}



export function deactivate() {}
