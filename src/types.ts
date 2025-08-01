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
    aiType?: string;
}

export interface SerializedFileState {
    version: number;
    changes: SerializedChange[];
    /** SHA-256 checksum of the workspace file content when this data was saved */
    checksum?: string;
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

export interface ClipboardData {
    type: string;
    text: string;
    timestamp: number;
    url?: string;
    title?: string;
    relativePath?: string;
    workspacePath?: string;
}