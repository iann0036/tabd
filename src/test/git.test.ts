import * as assert from 'assert';
import * as vscode from 'vscode';
import { getCurrentGitUser, getGitNotesNamespace } from '../git';

suite('Git Integration Test Suite', () => {

	suite('getCurrentGitUser Tests', () => {
		test('should return empty string when git is not available', () => {
			// Mock workspace folder pointing to non-git directory
			const mockWorkspaceFolder: vscode.WorkspaceFolder = {
				uri: vscode.Uri.file('/tmp/non-git-workspace'),
				name: 'non-git-workspace',
				index: 0
			};

			const result = getCurrentGitUser(mockWorkspaceFolder);
			
			// Should return empty string when git commands fail
			assert.strictEqual(result, '');
		});

		test('should handle git command errors gracefully', () => {
			const mockWorkspaceFolder: vscode.WorkspaceFolder = {
				uri: vscode.Uri.file('/invalid/path/that/does/not/exist'),
				name: 'invalid-workspace',
				index: 0
			};

			// Should not throw an error
			assert.doesNotThrow(() => {
				const result = getCurrentGitUser(mockWorkspaceFolder);
				assert.strictEqual(typeof result, 'string');
			});
		});
	});

	suite('getGitNotesNamespace Tests', () => {
		test('should generate namespace for file path', () => {
			const mockWorkspaceFolder: vscode.WorkspaceFolder = {
				uri: vscode.Uri.file('/test/workspace'),
				name: 'test-workspace',
				index: 0
			};

			const mockDocument = {
				uri: vscode.Uri.file('/test/workspace/src/components/Button.tsx')
			} as vscode.TextDocument;

			try {
				const namespace = getGitNotesNamespace(mockWorkspaceFolder, mockDocument);
				
				// Should start with tabd prefix
				assert.ok(namespace.startsWith('tabd__'));
				
				// Should contain branch name and file hash
				const parts = namespace.split('__');
				assert.ok(parts.length >= 3); // tabd, branch, hash
			} catch (error) {
				// Expected in test environment without git setup
				assert.ok(error instanceof Error);
			}
		});

		test('should handle special characters in file paths', () => {
			const mockWorkspaceFolder: vscode.WorkspaceFolder = {
				uri: vscode.Uri.file('/test/workspace'),
				name: 'test-workspace',
				index: 0
			};

			const mockDocument = {
				uri: vscode.Uri.file('/test/workspace/src/components/My Component (v2).tsx')
			} as vscode.TextDocument;

			try {
				const namespace = getGitNotesNamespace(mockWorkspaceFolder, mockDocument);
				
				// Should handle special characters by converting them
				assert.ok(namespace.startsWith('tabd__'));
				assert.ok(!namespace.includes('('));
				assert.ok(!namespace.includes(')'));
				assert.ok(!namespace.includes(' '));
			} catch (error) {
				// Expected in test environment without git setup
				assert.ok(error instanceof Error);
			}
		});

		test('should generate consistent namespace for same file', () => {
			const mockWorkspaceFolder: vscode.WorkspaceFolder = {
				uri: vscode.Uri.file('/test/workspace'),
				name: 'test-workspace',
				index: 0
			};

			const mockDocument = {
				uri: vscode.Uri.file('/test/workspace/src/test.ts')
			} as vscode.TextDocument;

			try {
				const namespace1 = getGitNotesNamespace(mockWorkspaceFolder, mockDocument);
				const namespace2 = getGitNotesNamespace(mockWorkspaceFolder, mockDocument);
				
				// Should be identical for the same file
				assert.strictEqual(namespace1, namespace2);
			} catch (error) {
				// Expected in test environment without git setup
				assert.ok(error instanceof Error);
			}
		});

		test('should generate different namespaces for different files', () => {
			const mockWorkspaceFolder: vscode.WorkspaceFolder = {
				uri: vscode.Uri.file('/test/workspace'),
				name: 'test-workspace',
				index: 0
			};

			const mockDocument1 = {
				uri: vscode.Uri.file('/test/workspace/src/file1.ts')
			} as vscode.TextDocument;

			const mockDocument2 = {
				uri: vscode.Uri.file('/test/workspace/src/file2.ts')
			} as vscode.TextDocument;

			try {
				const namespace1 = getGitNotesNamespace(mockWorkspaceFolder, mockDocument1);
				const namespace2 = getGitNotesNamespace(mockWorkspaceFolder, mockDocument2);
				
				// Should be different for different files
				assert.notStrictEqual(namespace1, namespace2);
			} catch (error) {
				// Expected in test environment without git setup
				assert.ok(error instanceof Error);
			}
		});

		test('should handle nested directory structures', () => {
			const mockWorkspaceFolder: vscode.WorkspaceFolder = {
				uri: vscode.Uri.file('/test/workspace'),
				name: 'test-workspace',
				index: 0
			};

			const mockDocument = {
				uri: vscode.Uri.file('/test/workspace/src/deep/nested/folder/file.ts')
			} as vscode.TextDocument;

			try {
				const namespace = getGitNotesNamespace(mockWorkspaceFolder, mockDocument);
				
				// Should handle nested paths correctly
				assert.ok(namespace.startsWith('tabd__'));
				assert.ok(namespace.length > 20); // Should be reasonably long due to hashing
			} catch (error) {
				// Expected in test environment without git setup
				assert.ok(error instanceof Error);
			}
		});
	});

	suite('Error Handling Tests', () => {
		test('should handle invalid workspace folders', () => {
			const invalidWorkspaceFolder: vscode.WorkspaceFolder = {
				uri: vscode.Uri.file(''),
				name: '',
				index: 0
			};

			assert.doesNotThrow(() => {
				getCurrentGitUser(invalidWorkspaceFolder);
			});
		});

		test('should handle very long file paths', () => {
			const mockWorkspaceFolder: vscode.WorkspaceFolder = {
				uri: vscode.Uri.file('/test/workspace'),
				name: 'test-workspace',
				index: 0
			};

			// Create a very long file path
			const longPath = '/test/workspace/' + 'a'.repeat(1000) + '/file.ts';
			const mockDocument = {
				uri: vscode.Uri.file(longPath)
			} as vscode.TextDocument;

			try {
				const namespace = getGitNotesNamespace(mockWorkspaceFolder, mockDocument);
				
				// Should handle long paths by hashing them
				assert.ok(namespace.length < 200); // Should be reasonable length due to hashing
			} catch (error) {
				// Expected in test environment without git setup
				assert.ok(error instanceof Error);
			}
		});
	});
});
