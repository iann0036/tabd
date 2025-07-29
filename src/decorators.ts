import * as vscode from 'vscode';
import { ExtendedRange, ExtendedRangeType } from './extendedRange';

const userEditDecorator = vscode.window.createTextEditorDecorationType({
	backgroundColor: "#88888811",
	//isWholeLine: true,
	rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
});

const aiGeneratedDecorator = vscode.window.createTextEditorDecorationType({
    // cyan background
	backgroundColor: "#00ffff26",
	//isWholeLine: true,
	rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
});

const undoRedoDecorator = vscode.window.createTextEditorDecorationType({
	backgroundColor: "#80008026",
	//isWholeLine: true,
	rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
});

const unknownDecorator = vscode.window.createTextEditorDecorationType({
	backgroundColor: "#ff000026",
	//isWholeLine: true,
	rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
});

const pasteDecorator = vscode.window.createTextEditorDecorationType({
	backgroundColor: "#ff880026",
	//isWholeLine: true,
	rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
});

const idePasteDecorator = vscode.window.createTextEditorDecorationType({
	backgroundColor: "#a4f54226",
	//isWholeLine: true,
	rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
});

export function triggerDecorationUpdate(d: vscode.TextDocument, updatedRanges: ExtendedRange[]) {
    const config = vscode.workspace.getConfiguration('tabd');
    const showBlame = config.get<boolean>('showBlame', false);

    if (showBlame) {
        forceShowDecorations(d, updatedRanges);
        return;
    }
    
    // Clear decorations when blame is not shown by default
    for (const editor of vscode.window.visibleTextEditors) {
        if (editor.document === d) {
            editor.setDecorations(userEditDecorator, []);
            editor.setDecorations(aiGeneratedDecorator, []);
            editor.setDecorations(undoRedoDecorator, []);
            editor.setDecorations(pasteDecorator, []);
            editor.setDecorations(idePasteDecorator, []);
            editor.setDecorations(unknownDecorator, []);
        }
    }
}

export function forceShowDecorations(d: vscode.TextDocument, updatedRanges: ExtendedRange[]) {
    for (const editor of vscode.window.visibleTextEditors) {
        if (editor.document === d) {
            editor.setDecorations(userEditDecorator, updatedRanges.filter(range => range.getType() === ExtendedRangeType.UserEdit).map(range => {
                return {
                    range: range,
                    hoverMessage: `Edit by ${range.getAuthor() || 'you'} • Created at: ${new Date(range.getCreationTimestamp()).toLocaleString()}`,
                };
            }));
            editor.setDecorations(aiGeneratedDecorator, updatedRanges.filter(range => range.getType() === ExtendedRangeType.AIGenerated).map(range => {
                const aiType = {
                    'inlineCompletion': ' • Using inline completion',
                    'applyPatch': ' • Using the apply patch tool',
                    'createFile': ' • Using the create file tool',
                    'insertEdit': ' • Using the insert edit tool',
                    'replaceString': ' • Using the replace string tool',
                    'applyEdit': ' • Using an apply edit command',
                }[range.getAiType()] || ` • Using an unknown tool (${range.getAiType()})`;
                return {
                    range: range,
                    hoverMessage: `AI Generated under ${range.getAuthor() ? (range.getAuthor() + "'s") : 'your'} control${range.getAiName() !== '' ? ` • ${range.getAiName()}` : ''}${range.getAiModel() !== '' ? ` (${range.getAiModel()})` : ''}${aiType} • Created at: ${new Date(range.getCreationTimestamp()).toLocaleString()}`,
                };
            }));
            editor.setDecorations(undoRedoDecorator, updatedRanges.filter(range => range.getType() === ExtendedRangeType.UndoRedo).map(range => {
                return {
                    range: range,
                    hoverMessage: `Undo/Redo by ${range.getAuthor() || 'you'} • Created at: ${new Date(range.getCreationTimestamp()).toLocaleString()}`,
                };
            }));
            editor.setDecorations(pasteDecorator, updatedRanges.filter(range => range.getType() === ExtendedRangeType.Paste).map(range => {
                return {
                    range: range,
                    hoverMessage: `Clipboard Paste by ${range.getAuthor() || 'you'}${range.getPasteUrl() !== '' ? ` • From the webpage [${range.getPasteTitle()}](${range.getPasteUrl()})` : ''} • Created at: ${new Date(range.getCreationTimestamp()).toLocaleString()}`,
                };
            }));
            editor.setDecorations(idePasteDecorator, updatedRanges.filter(range => range.getType() === ExtendedRangeType.IDEPaste).map(range => {
                return {
                    range: range,
                    hoverMessage: `Clipboard Paste by ${range.getAuthor() || 'you'}${range.getPasteUrl() !== '' ? ` • From the [${range.getPasteUrl()}](${range.getPasteUrl()}) repository at \`${range.getPasteTitle()}\`` : ''} • Created at: ${new Date(range.getCreationTimestamp()).toLocaleString()}`,
                };
            }));
            editor.setDecorations(unknownDecorator, updatedRanges.filter(range => range.getType() === ExtendedRangeType.Unknown).map(range => {
                return {
                    range: range,
                    hoverMessage: `Unknown Action by ${range.getAuthor() || 'you'} • Created at: ${new Date(range.getCreationTimestamp()).toLocaleString()}`
                };
            }));
        }
    }
}
