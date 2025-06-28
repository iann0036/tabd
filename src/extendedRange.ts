import * as vscode from 'vscode';

export enum ExtendedRangeType {
    Unknown = "UNKNOWN",
    UserEdit = "USER_EDIT",
    AIModification = "AI_MODIFICATION",
    UndoRedo = "UNDO_REDO",
    Paste = "PASTE",
}

export class ExtendedRange extends vscode.Range {
    private readonly creationTimestamp: number;
    private rangeType: ExtendedRangeType;

    constructor(
        start: vscode.Position,
        end: vscode.Position,
        rangeType: ExtendedRangeType = ExtendedRangeType.Unknown,
        creationTimestamp: number = Date.now(),
    ) {
        super(start, end);
        this.rangeType = rangeType;
        this.creationTimestamp = creationTimestamp;
    }

    getType(): ExtendedRangeType {
        return this.rangeType;
    }

    getCreationTimestamp(): number {
        return this.creationTimestamp;
    }
}