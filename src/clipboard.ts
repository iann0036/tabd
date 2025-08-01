import * as vscode from 'vscode';
import { shouldProcessFile } from './utils';
import { ClipboardData } from './types';

var lastClipboardContent: string | null = null;
var clipboardTrackingTimer: NodeJS.Timeout | null = null;

// Exported global variable to store the latest clipboard data
export var latestClipboardData: ClipboardData;

export async function enableClipboardTracking() {
    if (clipboardTrackingTimer) {
        return; // Already enabled
    }

    const config = vscode.workspace.getConfiguration('tabd');
    const disabled = config.get<boolean>('disabled', false);
    if (disabled) {
        return; // Tracking is disabled
    }
    const enableIDEClipboardMonitoring = config.get<boolean>('enableIDEClipboardMonitoring', true);
    if (!enableIDEClipboardMonitoring) {
        return; // IDE clipboard monitoring is disabled
    }

    lastClipboardContent = await vscode.env.clipboard.readText();

    clipboardTrackingTimer = setInterval(checkClipboardContent, 500); // Check clipboard every 500ms
}

async function checkClipboardContent() {
    let text = await vscode.env.clipboard.readText();
    
    if (text && text.trim().length > 0) {
        if (text !== lastClipboardContent) {
            lastClipboardContent = text;
            
            if (vscode.window.state.active && vscode.window.state.focused) {
                const activeEditor = vscode.window.activeTextEditor;
                if (activeEditor && activeEditor.document.uri.scheme === 'file' && shouldProcessFile(activeEditor.document.uri)) {
                    // Get text editor selection and ensure it matches the clipboard content
                    const selection = activeEditor.selection;
                    let selectedText = "";
                    if (!selection.isEmpty) {
                        selectedText = activeEditor.document.getText(selection);
                    }
                    
                    // Only proceed if clipboard content matches the current selection or current line
                    // This helps confirm the clipboard change originated from this editor
                    if (selectedText && selectedText === text) {
                        // Clipboard content matches selection - this is likely a copy operation from this editor
                    } else if (!selectedText) {
                        // No selection - check if clipboard matches current line (VS Code's copy line behavior)
                        const currentLine = activeEditor.document.lineAt(activeEditor.selection.active.line);
                        const currentLineText = currentLine.text;
                        
                        if (currentLineText.trim() === text.trim() && currentLineText.trim().length > 0) {
                            // Clipboard content matches current line - this is likely a copy line operation
                        } else {
                            // Clipboard content doesn't match current line or selection - skip to avoid noise
                            return;
                        }
                    } else {
                        // Has selection but clipboard doesn't match - skip to avoid noise
                        return;
                    }
                    
                    try {
                        const workspaceFolder = vscode.workspace.getWorkspaceFolder(activeEditor.document.uri);
                        if (!workspaceFolder) {
                            return;
                        }

                        let relativePath = vscode.workspace.asRelativePath(activeEditor.document.uri, false);

                        // Create the clipboard data object and store it in the global variable
                        latestClipboardData = {
                            type: "ide_clipboard_copy",
                            text: text,
                            timestamp: Date.now(),
                            relativePath: relativePath,
                            workspacePath: workspaceFolder.uri.fsPath,
                            url: undefined,
                            title: undefined
                        };

                        return;
                    } catch (error) {
                        console.warn('Failed to store clipboard data:', error);
                    }
                }
            }
        }
    }
}

export function disableClipboardTracking() {
    if (clipboardTrackingTimer) {
        clearInterval(clipboardTrackingTimer);
        clipboardTrackingTimer = null;

        // Ensure we check the clipboard one last time to capture any final changes
        checkClipboardContent().then(() => {
            // Clear the global clipboard data when tracking is disabled
            latestClipboardData = {} as ClipboardData;
        });
    }
}
