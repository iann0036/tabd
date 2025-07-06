import * as vscode from 'vscode';
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';
import { SerializedFileState } from './types';
import { getLogDirectory } from './utils';

/**
 * Get the current Git user name
 * @param workspaceFolder The workspace folder containing the Git repository
 * @returns The current Git user name or 'You' if unable to determine
 */
export function getCurrentGitUser(workspaceFolder: vscode.WorkspaceFolder): string {
    try {
        const userCommand = 'git config user.name';
        const currentUser = execSync(userCommand, {
            cwd: workspaceFolder.uri.fsPath,
            encoding: 'utf8',
            timeout: 2000,
        }).trim();
        
        if (currentUser && currentUser.trim().length > 1) {
            return currentUser;
        }
    } catch (error) {
        console.warn('Failed to get current Git user:', error);
    }

    try {
        const userCommand = 'git config user.email';
        const currentUser = execSync(userCommand, {
            cwd: workspaceFolder.uri.fsPath,
            encoding: 'utf8',
            timeout: 2000,
        }).trim();
        
        if (currentUser && currentUser.trim().length > 1) {
            return currentUser;
        }
    } catch (error) {
        console.warn('Failed to get current Git user:', error);
    }

    return '';
}

/**
 * Generate a Git notes namespace for a file
 * @param workspaceFolder The workspace folder
 * @param document The document
 * @returns The Git notes namespace (e.g., "tabd__directory1__file1.txt")
 */
export function getGitNotesNamespace(workspaceFolder: vscode.WorkspaceFolder, document: vscode.TextDocument): string {
	const relativePath = vscode.workspace.asRelativePath(document.uri, false);
	// Replace path separators and special characters with double underscores
	const namespace = relativePath
		.replace(/[/\\]/g, '__')
		.replace(/[^a-zA-Z0-9._-]/g, '_');

	const sha256namespace = createHash('sha256').update(namespace).digest('hex');

	const branchNameOutput = execSync(`git rev-parse --abbrev-ref HEAD`, {
		cwd: workspaceFolder.uri.fsPath,
		encoding: 'utf8',
		timeout: 2000,
	}).trim();
	
	return `tabd__${branchNameOutput}__${sha256namespace}`;
}

/**
 * Save data to Git notes
 * @param workspaceFolder The workspace folder
 * @param document The document
 * @param data The data to save
 * @param namespace The Git notes namespace
 */
export function saveToGitNotes(workspaceFolder: vscode.WorkspaceFolder, document: vscode.TextDocument, data: SerializedFileState, namespace: string): void {
	try {
		// Create temporary file with the note content
		const tempDir = getLogDirectory(workspaceFolder, document);
		if (!fs.existsSync(tempDir)) {
			fs.mkdirSync(tempDir, { recursive: true });
		}
		
		const tempFilePath = path.join(tempDir, `${namespace}_${Date.now()}.json`);
		fs.writeFileSync(tempFilePath, JSON.stringify(data, null, 2));
		
		// Get the HEAD commit hash
		const headCommit = execSync('git rev-parse HEAD', {
			cwd: workspaceFolder.uri.fsPath,
			encoding: 'utf8',
			timeout: 5000,
		}).trim();
		
		// Add the note using the temporary file
		execSync(`git notes --ref=${namespace} add -f -F "${tempFilePath}" ${headCommit}`, {
			cwd: workspaceFolder.uri.fsPath,
			timeout: 10000,
		});
		
		// Push the notes to origin
		try {
			execSync(`git push origin refs/notes/${namespace}`, {
				cwd: workspaceFolder.uri.fsPath,
				timeout: 15000,
			});
		} catch (pushError) {
			console.warn(`Failed to push Git notes to origin for namespace ${namespace}:`, pushError);
		}
		
		// Clean up temporary file
		fs.unlinkSync(tempFilePath);
	} catch (error) {
		console.warn(`Failed to save to Git notes namespace ${namespace}:`, error);
		throw error;
	}
}

/**
 * Load data from Git notes
 * @param workspaceFolder The workspace folder
 * @param document The document
 * @param namespace The Git notes namespace
 * @returns The loaded data or null if not found
 */
export function loadFromGitNotes(workspaceFolder: vscode.WorkspaceFolder, document: vscode.TextDocument, namespace: string): SerializedFileState[] {
	try {
		// Pull notes from origin first
		try {
			execSync(`git fetch origin refs/notes/${namespace}:refs/notes/${namespace}`, {
				cwd: workspaceFolder.uri.fsPath,
				timeout: 15000,
			});
		} catch (pullError) {
			console.warn(`Failed to pull Git notes from origin for namespace ${namespace}:`, pullError);
		}
		
		// List all notes for this namespace
		const notesOutput = execSync(`git notes --ref=${namespace} list`, {
			cwd: workspaceFolder.uri.fsPath,
			encoding: 'utf8',
			timeout: 5000,
		}).trim();
		
		if (!notesOutput) {
			return [];
		}
		
		const notes: SerializedFileState[] = [];
		const noteLines = notesOutput.split('\n').filter(line => line.trim());
		
		for (const noteLine of noteLines) {
			const [noteId, commitId] = noteLine.split(' ');
			if (!noteId || !commitId) {
				continue;
			}
			
			try {
				// Get the note content
				const noteContent = execSync(`git notes --ref=${namespace} show ${commitId}`, {
					cwd: workspaceFolder.uri.fsPath,
					encoding: 'utf8',
					timeout: 5000,
				});
				
				const noteData: SerializedFileState = JSON.parse(noteContent);
				if (noteData.version === 1) {
					notes.push(noteData);
				}
			} catch (noteError) {
				console.warn(`Failed to load note ${noteId} for commit ${commitId}:`, noteError);
			}
		}
		
		// Sort by creation timestamp if available
		notes.sort((a, b) => {
			const aTime = a.changes.length > 0 ? Math.min(...a.changes.map(c => c.creationTimestamp)) : 0;
			const bTime = b.changes.length > 0 ? Math.min(...b.changes.map(c => c.creationTimestamp)) : 0;
			return aTime - bTime;
		});
		
		return notes;
	} catch (error) {
		console.warn(`Failed to load from Git notes namespace ${namespace}:`, error);
		return [];
	}
}
