import * as vscode from 'vscode';

export enum ExtendedRangeType {
    Unknown = "UNKNOWN",
    UserEdit = "USER_EDIT",
    AIGenerated = "AI_GENERATED",
    UndoRedo = "UNDO_REDO",
    Paste = "PASTE",
}

export class ExtendedRange extends vscode.Range {
    private readonly creationTimestamp: number;
    private rangeType: ExtendedRangeType;
    private author: string;

    constructor(
        start: vscode.Position,
        end: vscode.Position,
        rangeType: ExtendedRangeType = ExtendedRangeType.Unknown,
        creationTimestamp: number = Date.now(),
        author: string = '',
    ) {
        super(start, end);
        this.rangeType = rangeType;
        this.creationTimestamp = creationTimestamp;
        this.author = author;
    }

    getType(): ExtendedRangeType {
        return this.rangeType;
    }

    getCreationTimestamp(): number {
        return this.creationTimestamp;
    }

    getAuthor(): string {
        return this.author;
    }
}