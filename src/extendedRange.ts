import * as vscode from 'vscode';

export enum ExtendedRangeType {
    Unknown = 0,
    UserEdit = 1,
    AIModification = 2,
    UndoRedo = 3,
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