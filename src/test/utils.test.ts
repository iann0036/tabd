import * as assert from 'assert';
import * as vscode from 'vscode';
import * as path from 'path';
import * as os from 'os';
import { shouldProcessFile, fsPath, uniqueFileName, getStorageDirectory, getLogDirectory, generateDataChecksum, verifyDataChecksum } from '../utils';

suite('Utils Test Suite', () => {
	
	suite('shouldProcessFile Tests', () => {
		test('should process normal files', () => {
			const normalFile = vscode.Uri.file('/workspace/src/main.ts');
			assert.strictEqual(shouldProcessFile(normalFile), true);
		});

		test('should reject files starting with dot', () => {
			const hiddenFile = vscode.Uri.file('/workspace/.env');
			assert.strictEqual(shouldProcessFile(hiddenFile), false);
		});

		test('should reject files in hidden directories', () => {
			const fileInHiddenDir = vscode.Uri.file('/workspace/.git/config');
			assert.strictEqual(shouldProcessFile(fileInHiddenDir), false);
		});

		test('should reject files in nested hidden directories', () => {
			const nestedHiddenFile = vscode.Uri.file('/workspace/.vscode/settings.json');
			assert.strictEqual(shouldProcessFile(nestedHiddenFile), false);
		});

		test('should process files with dots in the name but not at start', () => {
			const fileWithDots = vscode.Uri.file('/workspace/my.config.ts');
			assert.strictEqual(shouldProcessFile(fileWithDots), true);
		});
	});

	suite('uniqueFileName Tests', () => {
		test('should generate filename with correct format', () => {
			const filename = uniqueFileName();
			
			assert.ok(filename.startsWith('tabd-'));
			assert.ok(filename.endsWith('.json'));
			assert.ok(filename.length > 15); // Should be reasonably long
		});

		test('should generate unique filenames', () => {
			const filenames = new Set();
			
			// Generate multiple filenames and ensure they're unique
			for (let i = 0; i < 10; i++) {
				const filename = uniqueFileName();
				assert.ok(!filenames.has(filename), `Duplicate filename generated: ${filename}`);
				filenames.add(filename);
			}
		});

		test('should contain timestamp and random components', () => {
			const filename = uniqueFileName();
			const parts = filename.replace('.json', '').split('-');
			
			assert.strictEqual(parts[0], 'tabd');
			assert.ok(parts[1].length >= 14); // timestamp component
			assert.ok(parts[2].length === 6); // random component
		});
	});

	suite('fsPath Tests', () => {
		test('should handle file URIs correctly', () => {
			const testPath = '/test/path/file.txt';
			const uri = vscode.Uri.file(testPath);
			const result = fsPath(uri);
			
			// The exact result may vary by platform, but should contain the filename
			assert.ok(result.includes('file.txt'));
		});

		test('should handle Windows drive letters', () => {
			if (process.platform === 'win32') {
				const testPath = 'c:\\test\\file.txt';
				const uri = vscode.Uri.file(testPath);
				const result = fsPath(uri);
				
				// Should uppercase the drive letter
				assert.ok(result.startsWith('C:'));
			} else {
				// Skip this test on non-Windows platforms
				assert.ok(true);
			}
		});
	});

	suite('Storage Directory Tests', () => {
		const mockWorkspaceFolder: vscode.WorkspaceFolder = {
			uri: vscode.Uri.file('/test/workspace'),
			name: 'test-workspace',
			index: 0
		};

		const mockDocument = {
			uri: vscode.Uri.file('/test/workspace/src/file.ts')
		} as vscode.TextDocument;

		test('should generate repository storage path', () => {
			const origGet = vscode.workspace.getConfiguration;
			vscode.workspace.getConfiguration = () => ({
				get: (key: string, defaultValue?: any) => {
					if (key === 'storage') {
						return 'repository';
					}
					return defaultValue;
				}
			} as any);

			try {
				const storageDir = getStorageDirectory(mockWorkspaceFolder, mockDocument);
				assert.ok(storageDir.includes('.tabd'));
				assert.ok(storageDir.includes('workspace'));
			} finally {
				vscode.workspace.getConfiguration = origGet;
			}
		});

		test('should generate home directory storage path', () => {
			const origGet = vscode.workspace.getConfiguration;
			vscode.workspace.getConfiguration = () => ({
				get: (key: string, defaultValue?: any) => {
					if (key === 'storage') {
						return 'homeDirectory';
					}
					return defaultValue;
				}
			} as any);

			try {
				const storageDir = getStorageDirectory(mockWorkspaceFolder, mockDocument);
				assert.ok(storageDir.includes(os.homedir()));
				assert.ok(storageDir.includes('.tabd'));
			} finally {
				vscode.workspace.getConfiguration = origGet;
			}
		});

		test('should generate experimental storage path', () => {
			const origGet = vscode.workspace.getConfiguration;
			vscode.workspace.getConfiguration = () => ({
				get: (key: string, defaultValue?: any) => {
					if (key === 'storage') {
						return 'experimental';
					}
					return defaultValue;
				}
			} as any);

			try {
				const storageDir = getStorageDirectory(mockWorkspaceFolder, mockDocument);
				assert.ok(storageDir.includes('experimental'));
				assert.ok(storageDir.includes('.tabd'));
			} finally {
				vscode.workspace.getConfiguration = origGet;
			}
		});

		test('should throw error for unsupported storage type', () => {
			const origGet = vscode.workspace.getConfiguration;
			vscode.workspace.getConfiguration = () => ({
				get: (key: string, defaultValue?: any) => {
					if (key === 'storage') {
						return 'unsupported';
					}
					return defaultValue;
				}
			} as any);

			try {
				assert.throws(() => {
					getStorageDirectory(mockWorkspaceFolder, mockDocument);
				}, /Unsupported storage type/);
			} finally {
				vscode.workspace.getConfiguration = origGet;
			}
		});
	});

	suite('Log Directory Tests', () => {
		const mockWorkspaceFolder: vscode.WorkspaceFolder = {
			uri: vscode.Uri.file('/test/workspace'),
			name: 'test-workspace',
			index: 0
		};

		const mockDocument = {
			uri: vscode.Uri.file('/test/workspace/src/file.ts')
		} as vscode.TextDocument;

		test('should generate log directory for repository storage', () => {
			const origGet = vscode.workspace.getConfiguration;
			vscode.workspace.getConfiguration = () => ({
				get: (key: string, defaultValue?: any) => {
					if (key === 'storage') {
						return 'repository';
					}
					return defaultValue;
				}
			} as any);

			try {
				const logDir = getLogDirectory(mockWorkspaceFolder, mockDocument);
				assert.ok(logDir.includes('log'));
				assert.ok(logDir.includes('src'));
			} finally {
				vscode.workspace.getConfiguration = origGet;
			}
		});

		test('should generate temp directory for experimental storage', () => {
			const origGet = vscode.workspace.getConfiguration;
			vscode.workspace.getConfiguration = () => ({
				get: (key: string, defaultValue?: any) => {
					if (key === 'storage') {
						return 'experimental';
					}
					return defaultValue;
				}
			} as any);

			try {
				const logDir = getLogDirectory(mockWorkspaceFolder, mockDocument);
				assert.ok(logDir.includes('temp'));
			} finally {
				vscode.workspace.getConfiguration = origGet;
			}
		});
	});

	suite('Checksum Tests', () => {
		test('should generate consistent checksums for same file content', () => {
			const fileContent = 'console.log("Hello, world!");';
			const checksum1 = generateDataChecksum(fileContent);
			const checksum2 = generateDataChecksum(fileContent);
			
			assert.strictEqual(checksum1, checksum2);
			assert.strictEqual(typeof checksum1, 'string');
			assert.strictEqual(checksum1.length, 64); // SHA-256 produces 64 character hex string
		});

		test('should generate different checksums for different file content', () => {
			const content1 = 'console.log("Hello, world!");';
			const content2 = 'console.log("Hello, universe!");';
			const checksum1 = generateDataChecksum(content1);
			const checksum2 = generateDataChecksum(content2);
			
			assert.notStrictEqual(checksum1, checksum2);
		});

		test('should verify valid file content checksums', () => {
			const fileContent = 'function test() { return true; }';
			const checksum = generateDataChecksum(fileContent);
			
			assert.strictEqual(verifyDataChecksum(fileContent, checksum), true);
		});

		test('should reject invalid file content checksums', () => {
			const fileContent = 'function test() { return true; }';
			const invalidChecksum = 'invalid_checksum';
			
			assert.strictEqual(verifyDataChecksum(fileContent, invalidChecksum), false);
		});

		test('should detect modified file content', () => {
			const originalContent = 'let x = 1;';
			const modifiedContent = 'let x = 2;';
			const originalChecksum = generateDataChecksum(originalContent);
			
			assert.strictEqual(verifyDataChecksum(modifiedContent, originalChecksum), false);
		});

		test('should handle empty file content', () => {
			const emptyContent = '';
			const checksum = generateDataChecksum(emptyContent);
			
			assert.strictEqual(typeof checksum, 'string');
			assert.strictEqual(checksum.length, 64);
			assert.strictEqual(verifyDataChecksum(emptyContent, checksum), true);
		});
	});
});
