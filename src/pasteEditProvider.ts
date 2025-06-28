import * as vscode from "vscode";
import { shouldProcessFile } from "./utils";

export class PasteEditProvider implements vscode.DocumentPasteEditProvider {
    public static readonly id = "tabd.pasteEditProvider";
    private readonly notifyPaste: (d: vscode.TextDocument, ranges: readonly vscode.Range[]) => Promise<void>;

    constructor(
        notifyPaste: (d: vscode.TextDocument, ranges: readonly vscode.Range[]) => Promise<void>
    ) {
        this.notifyPaste = notifyPaste;
    }

    async provideDocumentPasteEdits(
        document: vscode.TextDocument,
        ranges: readonly vscode.Range[],
        dataTransfer: vscode.DataTransfer,
        context: vscode.DocumentPasteEditContext,
        token: vscode.CancellationToken
    ): Promise<vscode.DocumentPasteEdit[] | undefined> {
        console.log(
            "provideDocumentPasteEdits",
            document,
            ranges,
            dataTransfer,
            context,
            token
        );

        if (ranges.length === 0 || !shouldProcessFile(document.uri)) {
            return;
        }
        await this.notifyPaste(document, ranges);

        return;
    }
}