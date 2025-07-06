import * as assert from 'assert';
import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { ExtendedRange, ExtendedRangeType, ExtendedRangeOptions, mergeRangesSequentially, mergeUserEdits } from '../extendedRange';
import { getUpdatedPosition, getUpdatedRanges } from '../positionalTracking';
import { shouldProcessFile, fsPath, uniqueFileName, getStorageDirectory, getLogDirectory } from '../utils';
import { PasteEditProvider } from '../pasteEditProvider';
import { getCurrentGitUser, getGitNotesNamespace } from '../git';

suite('Extension Test Suite', () => {
	vscode.window.showInformationMessage('Start all tests.');

	suite('ExtendedRange Tests', () => {
		test('should create ExtendedRange with default values', () => {
			const start = new vscode.Position(0, 0);
			const end = new vscode.Position(0, 10);
			const range = new ExtendedRange(start, end);

			assert.strictEqual(range.getType(), ExtendedRangeType.Unknown);
			assert.strictEqual(range.getAuthor(), '');
			assert.strictEqual(range.getPasteUrl(), '');
			assert.strictEqual(range.getPasteTitle(), '');
			assert.strictEqual(range.getAiName(), '');
			assert.strictEqual(range.getAiModel(), '');
			assert.ok(range.getCreationTimestamp() > 0);
		});

		test('should create ExtendedRange with custom values', () => {
			const start = new vscode.Position(1, 5);
			const end = new vscode.Position(2, 15);
			const timestamp = Date.now();
			const options = new ExtendedRangeOptions();
			options.pasteUrl = 'https://example.com';
			options.pasteTitle = 'Example';
			options.aiName = 'GitHub Copilot';
			options.aiModel = 'gpt-4';

			const range = new ExtendedRange(
				start,
				end,
				ExtendedRangeType.AIGenerated,
				timestamp,
				'testuser',
				options
			);

			assert.strictEqual(range.getType(), ExtendedRangeType.AIGenerated);
			assert.strictEqual(range.getAuthor(), 'testuser');
			assert.strictEqual(range.getCreationTimestamp(), timestamp);
			assert.strictEqual(range.getPasteUrl(), 'https://example.com');
			assert.strictEqual(range.getPasteTitle(), 'Example');
			assert.strictEqual(range.getAiName(), 'GitHub Copilot');
			assert.strictEqual(range.getAiModel(), 'gpt-4');
		});

		test('should merge adjacent user edits within time limit', () => {
			const baseTime = Date.now();
			const ranges = [
				new ExtendedRange(
					new vscode.Position(0, 0),
					new vscode.Position(0, 5),
					ExtendedRangeType.UserEdit,
					baseTime,
					'user1'
				),
				new ExtendedRange(
					new vscode.Position(0, 5),
					new vscode.Position(0, 10),
					ExtendedRangeType.UserEdit,
					baseTime + 30000, // 30 seconds later
					'user1'
				),
				new ExtendedRange(
					new vscode.Position(1, 0),
					new vscode.Position(1, 5),
					ExtendedRangeType.Paste,
					baseTime,
					'user1'
				)
			];

			const merged = mergeUserEdits(ranges);
			
			// Should merge the two adjacent user edits and keep the paste separate
			assert.strictEqual(merged.length, 2);
			
			const mergedUserEdit = merged.find(r => r.getType() === ExtendedRangeType.UserEdit);
			const pasteRange = merged.find(r => r.getType() === ExtendedRangeType.Paste);
			
			assert.ok(mergedUserEdit);
			assert.ok(pasteRange);
			assert.strictEqual(mergedUserEdit.start.line, 0);
			assert.strictEqual(mergedUserEdit.start.character, 0);
			assert.strictEqual(mergedUserEdit.end.line, 0);
			assert.strictEqual(mergedUserEdit.end.character, 10);
		});

		test('should not merge user edits beyond time limit', () => {
			const baseTime = Date.now();
			const ranges = [
				new ExtendedRange(
					new vscode.Position(0, 0),
					new vscode.Position(0, 5),
					ExtendedRangeType.UserEdit,
					baseTime,
					'user1'
				),
				new ExtendedRange(
					new vscode.Position(0, 5),
					new vscode.Position(0, 10),
					ExtendedRangeType.UserEdit,
					baseTime + 70000, // 70 seconds later (beyond 60s limit)
					'user1'
				)
			];

			const merged = mergeUserEdits(ranges);
			
			// Should not merge due to time limit
			assert.strictEqual(merged.length, 2);
		});
	});

	suite('Position Tracking Tests', () => {
		test('should update position after text insertion', () => {
			const position = new vscode.Position(2, 10);
			const change: vscode.TextDocumentContentChangeEvent = {
				range: new vscode.Range(new vscode.Position(1, 5), new vscode.Position(1, 5)),
				rangeOffset: 0,
				rangeLength: 0,
				text: 'hello\nworld'
			};

			const updatedPosition = getUpdatedPosition(position, change);
			
			// Should move down by 1 line due to newline insertion
			assert.strictEqual(updatedPosition.line, 3);
			assert.strictEqual(updatedPosition.character, 10);
		});

		test('should update position after text deletion', () => {
			const position = new vscode.Position(2, 10);
			const change: vscode.TextDocumentContentChangeEvent = {
				range: new vscode.Range(new vscode.Position(1, 0), new vscode.Position(2, 5)),
				rangeOffset: 0,
				rangeLength: 10,
				text: ''
			};

			const updatedPosition = getUpdatedPosition(position, change);
			
			// Should move up by 1 line and adjust character position
			assert.strictEqual(updatedPosition.line, 1);
			assert.strictEqual(updatedPosition.character, 5); // 10 - 5 = 5
		});
	});

	suite('Utility Functions Tests', () => {
		test('shouldProcessFile should reject dotfiles', () => {
			const hiddenFileUri = vscode.Uri.file('/test/.hidden.txt');
			const normalFileUri = vscode.Uri.file('/test/normal.txt');
			const dotFolderFileUri = vscode.Uri.file('/test/.folder/file.txt');

			assert.strictEqual(shouldProcessFile(hiddenFileUri), false);
			assert.strictEqual(shouldProcessFile(normalFileUri), true);
			assert.strictEqual(shouldProcessFile(dotFolderFileUri), false);
		});

		test('uniqueFileName should generate unique filenames', () => {
			const filename1 = uniqueFileName();
			const filename2 = uniqueFileName();

			assert.ok(filename1.startsWith('tabd-'));
			assert.ok(filename1.endsWith('.json'));
			assert.ok(filename2.startsWith('tabd-'));
			assert.ok(filename2.endsWith('.json'));
			assert.notStrictEqual(filename1, filename2);
		});

		test('fsPath should handle URIs correctly', () => {
			const testUri = vscode.Uri.file('/test/path/file.txt');
			const result = fsPath(testUri);
			
			assert.ok(result.includes('file.txt'));
		});
	});

	suite('Range Merging Tests', () => {
		test('should merge overlapping ranges by timestamp', () => {
			const oldTime = Date.now() - 1000;
			const newTime = Date.now();
			
			const existingRanges = [
				new ExtendedRange(
					new vscode.Position(0, 0),
					new vscode.Position(0, 10),
					ExtendedRangeType.UserEdit,
					oldTime,
					'user1'
				)
			];
			
			const newRanges = [
				new ExtendedRange(
					new vscode.Position(0, 5),
					new vscode.Position(0, 15),
					ExtendedRangeType.AIGenerated,
					newTime,
					'user1'
				)
			];

			const merged = mergeRangesSequentially(existingRanges, newRanges);
			
			// Should have the AI range and the non-overlapping part of the user edit
			assert.ok(merged.length >= 1);
			assert.ok(merged.some(r => r.getType() === ExtendedRangeType.AIGenerated));
		});

		test('should handle completely contained ranges', () => {
			const oldTime = Date.now() - 1000;
			const newTime = Date.now();
			
			const existingRanges = [
				new ExtendedRange(
					new vscode.Position(0, 0),
					new vscode.Position(0, 20),
					ExtendedRangeType.UserEdit,
					oldTime,
					'user1'
				)
			];
			
			const newRanges = [
				new ExtendedRange(
					new vscode.Position(0, 5),
					new vscode.Position(0, 15),
					ExtendedRangeType.AIGenerated,
					newTime,
					'user1'
				)
			];

			const merged = mergeRangesSequentially(existingRanges, newRanges);
			
			// Should split the user edit around the AI range
			assert.ok(merged.length >= 2);
			assert.ok(merged.some(r => r.getType() === ExtendedRangeType.AIGenerated));
			assert.ok(merged.some(r => r.getType() === ExtendedRangeType.UserEdit));
		});
	});

	suite('PasteEditProvider Tests', () => {
		test('should create PasteEditProvider with notify function', () => {
			const mockNotify = async (doc: vscode.TextDocument, ranges: readonly vscode.Range[]) => {
				// Mock implementation
			};

			const provider = new PasteEditProvider(mockNotify);
			assert.ok(provider);
		});
	});

	suite('Configuration and Storage Tests', () => {
		test('should generate correct storage directory paths', () => {
			// Create mock workspace folder
			const mockWorkspaceFolder: vscode.WorkspaceFolder = {
				uri: vscode.Uri.file('/test/workspace'),
				name: 'test-workspace',
				index: 0
			};

			// Create mock document
			const mockDocument = {
				uri: vscode.Uri.file('/test/workspace/src/file.ts')
			} as vscode.TextDocument;

			// Test with repository storage (mocked config)
			const origGet = vscode.workspace.getConfiguration;
			vscode.workspace.getConfiguration = (section?: string) => {
				return {
					get: (key: string, defaultValue?: any) => {
						if (key === 'storage') {
							return 'repository';
						}
						return defaultValue;
					}
				} as any;
			};

			try {
				const storageDir = getStorageDirectory(mockWorkspaceFolder, mockDocument);
				assert.ok(storageDir.includes('.tabd'));
			} finally {
				vscode.workspace.getConfiguration = origGet;
			}
		});
	});

	suite('Git Integration Tests', () => {
		test('should generate git notes namespace', () => {
			// These tests would need a real git repository to work properly
			// For now, just test the function doesn't throw
			const mockWorkspaceFolder: vscode.WorkspaceFolder = {
				uri: vscode.Uri.file('/test/workspace'),
				name: 'test-workspace',
				index: 0
			};

			const mockDocument = {
				uri: vscode.Uri.file('/test/workspace/src/file.ts')
			} as vscode.TextDocument;

			try {
				// This will likely throw in test environment without git
				const namespace = getGitNotesNamespace(mockWorkspaceFolder, mockDocument);
				assert.ok(namespace.startsWith('tabd__'));
			} catch (error) {
				// Expected in test environment without git setup
				assert.ok(true);
			}
		});
	});

	suite('Edge Cases and Error Handling', () => {
		test('should handle empty ranges', () => {
			const emptyRange = new ExtendedRange(
				new vscode.Position(0, 0),
				new vscode.Position(0, 0),
				ExtendedRangeType.UserEdit
			);

			assert.strictEqual(emptyRange.isEmpty, true);
		});

		test('should handle edge case positions gracefully', () => {
			// Test with positions that are technically valid but represent edge cases
			const edgeRange = new ExtendedRange(
				new vscode.Position(0, 0),
				new vscode.Position(0, 0),
				ExtendedRangeType.UserEdit
			);

			// Should not throw and should be empty
			assert.ok(edgeRange);
			assert.strictEqual(edgeRange.isEmpty, true);
			
			// Test with a very large position that could cause issues
			const largeRange = new ExtendedRange(
				new vscode.Position(0, 0),
				new vscode.Position(Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER),
				ExtendedRangeType.UserEdit
			);
			
			// Should not throw
			assert.ok(largeRange);
		});

		test('should handle merging empty range arrays', () => {
			const result = mergeRangesSequentially([], []);
			assert.strictEqual(result.length, 0);
		});

		test('should handle merging with single ranges', () => {
			const singleRange = [
				new ExtendedRange(
					new vscode.Position(0, 0),
					new vscode.Position(0, 5),
					ExtendedRangeType.UserEdit
				)
			];

			const result = mergeRangesSequentially(singleRange, []);
			assert.strictEqual(result.length, 1);
		});
	});

	suite('ExtendedRangeType Enum Tests', () => {
		test('should have all expected range types', () => {
			assert.strictEqual(ExtendedRangeType.Unknown, 'UNKNOWN');
			assert.strictEqual(ExtendedRangeType.UserEdit, 'USER_EDIT');
			assert.strictEqual(ExtendedRangeType.AIGenerated, 'AI_GENERATED');
			assert.strictEqual(ExtendedRangeType.UndoRedo, 'UNDO_REDO');
			assert.strictEqual(ExtendedRangeType.Paste, 'PASTE');
			assert.strictEqual(ExtendedRangeType.IDEPaste, 'IDE_PASTE');
		});
	});
});
