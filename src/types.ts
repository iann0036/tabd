import { ExtendedRangeType, ExtendedRange } from './extendedRange';

export interface SerializedChange {
    start: { line: number; character: number };
    end: { line: number; character: number };
    type: ExtendedRangeType;
    creationTimestamp: number;
    author?: string;
    pasteUrl?: string;
    pasteTitle?: string;
    aiName?: string;
    aiModel?: string;
    aiExplanation?: string;
}

export interface SerializedFileState {
    version: number;
    changes: SerializedChange[];
}

export interface FileState {
    changes: ExtendedRange[];
    savePath?: string;
    pasteRanges: ExtendedRange[];
    loadTimestamp?: number;
}

export interface GlobalFileState {
    [key: string]: FileState;
}