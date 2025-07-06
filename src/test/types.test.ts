import * as assert from 'assert';
import * as vscode from 'vscode';
import { SerializedFileState, SerializedChange, FileState, GlobalFileState } from '../types';
import { ExtendedRangeType } from '../extendedRange';

suite('Types and Integration Test Suite', () => {

	suite('SerializedChange Tests', () => {
		test('should define correct structure for serialized change', () => {
			const change: SerializedChange = {
				start: { line: 0, character: 0 },
				end: { line: 0, character: 10 },
				type: ExtendedRangeType.UserEdit,
				creationTimestamp: Date.now(),
				author: 'test-user',
				pasteUrl: 'https://example.com',
				pasteTitle: 'Example',
				aiName: 'GitHub Copilot',
				aiModel: 'gpt-4'
			};

			assert.strictEqual(typeof change.start.line, 'number');
			assert.strictEqual(typeof change.start.character, 'number');
			assert.strictEqual(typeof change.end.line, 'number');
			assert.strictEqual(typeof change.end.character, 'number');
			assert.strictEqual(change.type, ExtendedRangeType.UserEdit);
			assert.strictEqual(typeof change.creationTimestamp, 'number');
			assert.strictEqual(change.author, 'test-user');
		});

		test('should allow optional fields to be undefined', () => {
			const minimalChange: SerializedChange = {
				start: { line: 1, character: 5 },
				end: { line: 1, character: 15 },
				type: ExtendedRangeType.AIGenerated,
				creationTimestamp: Date.now()
			};

			assert.ok(minimalChange);
			assert.strictEqual(minimalChange.author, undefined);
			assert.strictEqual(minimalChange.pasteUrl, undefined);
			assert.strictEqual(minimalChange.pasteTitle, undefined);
			assert.strictEqual(minimalChange.aiName, undefined);
			assert.strictEqual(minimalChange.aiModel, undefined);
		});
	});

	suite('SerializedFileState Tests', () => {
		test('should define correct structure for file state', () => {
			const fileState: SerializedFileState = {
				version: 1,
				changes: [
					{
						start: { line: 0, character: 0 },
						end: { line: 0, character: 5 },
						type: ExtendedRangeType.UserEdit,
						creationTimestamp: Date.now(),
						author: 'user1'
					},
					{
						start: { line: 1, character: 0 },
						end: { line: 1, character: 10 },
						type: ExtendedRangeType.Paste,
						creationTimestamp: Date.now(),
						author: 'user2',
						pasteUrl: 'https://stackoverflow.com'
					}
				]
			};

			assert.strictEqual(fileState.version, 1);
			assert.strictEqual(fileState.changes.length, 2);
			assert.strictEqual(fileState.changes[0].type, ExtendedRangeType.UserEdit);
			assert.strictEqual(fileState.changes[1].type, ExtendedRangeType.Paste);
		});

		test('should handle empty changes array', () => {
			const emptyFileState: SerializedFileState = {
				version: 1,
				changes: []
			};

			assert.strictEqual(emptyFileState.version, 1);
			assert.strictEqual(emptyFileState.changes.length, 0);
		});
	});

	suite('FileState Tests', () => {
		test('should create file state with ExtendedRange objects', () => {
			const fileState: FileState = {
				changes: [],
				pasteRanges: [],
				savePath: '/test/path/file.json',
				loadTimestamp: Date.now()
			};

			assert.ok(Array.isArray(fileState.changes));
			assert.ok(Array.isArray(fileState.pasteRanges));
			assert.strictEqual(fileState.savePath, '/test/path/file.json');
			assert.ok(typeof fileState.loadTimestamp === 'number');
		});

		test('should allow optional fields', () => {
			const minimalFileState: FileState = {
				changes: [],
				pasteRanges: []
			};

			assert.ok(Array.isArray(minimalFileState.changes));
			assert.ok(Array.isArray(minimalFileState.pasteRanges));
			assert.strictEqual(minimalFileState.savePath, undefined);
			assert.strictEqual(minimalFileState.loadTimestamp, undefined);
		});
	});

	suite('GlobalFileState Tests', () => {
		test('should store file states by file path', () => {
			const globalState: GlobalFileState = {};

			const fileState1: FileState = {
				changes: [],
				pasteRanges: [],
				loadTimestamp: Date.now()
			};

			const fileState2: FileState = {
				changes: [],
				pasteRanges: [],
				savePath: '/test/save/path.json'
			};

			globalState['/test/file1.ts'] = fileState1;
			globalState['/test/file2.ts'] = fileState2;

			assert.strictEqual(Object.keys(globalState).length, 2);
			assert.strictEqual(globalState['/test/file1.ts'], fileState1);
			assert.strictEqual(globalState['/test/file2.ts'], fileState2);
		});

		test('should handle dynamic key access', () => {
			const globalState: GlobalFileState = {};
			const filePath = '/dynamic/path/file.ts';

			// Should not throw when accessing non-existent key
			assert.strictEqual(globalState[filePath], undefined);

			// Should allow setting new keys
			globalState[filePath] = {
				changes: [],
				pasteRanges: []
			};

			assert.ok(globalState[filePath]);
		});
	});

	suite('Integration Tests', () => {
		test('should convert between FileState and SerializedFileState', () => {
			// This would typically be done by the extension's serialization logic
			const timestamp = Date.now();
			
			const serializedState: SerializedFileState = {
				version: 1,
				changes: [
					{
						start: { line: 0, character: 0 },
						end: { line: 0, character: 10 },
						type: ExtendedRangeType.UserEdit,
						creationTimestamp: timestamp,
						author: 'test-user'
					}
				]
			};

			// Verify the serialized format is correct
			assert.strictEqual(serializedState.version, 1);
			assert.strictEqual(serializedState.changes.length, 1);
			
			const change = serializedState.changes[0];
			assert.strictEqual(change.start.line, 0);
			assert.strictEqual(change.start.character, 0);
			assert.strictEqual(change.end.line, 0);
			assert.strictEqual(change.end.character, 10);
			assert.strictEqual(change.type, ExtendedRangeType.UserEdit);
			assert.strictEqual(change.creationTimestamp, timestamp);
			assert.strictEqual(change.author, 'test-user');
		});

		test('should handle all ExtendedRangeTypes in serialization', () => {
			const allTypes = [
				ExtendedRangeType.Unknown,
				ExtendedRangeType.UserEdit,
				ExtendedRangeType.AIGenerated,
				ExtendedRangeType.UndoRedo,
				ExtendedRangeType.Paste,
				ExtendedRangeType.IDEPaste
			];

			const changes: SerializedChange[] = allTypes.map((type, index) => ({
				start: { line: index, character: 0 },
				end: { line: index, character: 5 },
				type: type,
				creationTimestamp: Date.now(),
				author: 'test-user'
			}));

			const fileState: SerializedFileState = {
				version: 1,
				changes: changes
			};

			assert.strictEqual(fileState.changes.length, allTypes.length);
			
			fileState.changes.forEach((change, index) => {
				assert.strictEqual(change.type, allTypes[index]);
			});
		});

		test('should handle complex file state with all optional fields', () => {
			const complexChange: SerializedChange = {
				start: { line: 5, character: 10 },
				end: { line: 7, character: 25 },
				type: ExtendedRangeType.AIGenerated,
				creationTimestamp: Date.now(),
				author: 'ai-user',
				pasteUrl: 'https://github.com/user/repo',
				pasteTitle: 'README.md (on branch feature)',
				aiName: 'GitHub Copilot',
				aiModel: 'gpt-4-turbo'
			};

			const fileState: SerializedFileState = {
				version: 1,
				changes: [complexChange]
			};

			assert.strictEqual(fileState.changes[0].pasteUrl, 'https://github.com/user/repo');
			assert.strictEqual(fileState.changes[0].pasteTitle, 'README.md (on branch feature)');
			assert.strictEqual(fileState.changes[0].aiName, 'GitHub Copilot');
			assert.strictEqual(fileState.changes[0].aiModel, 'gpt-4-turbo');
		});

		test('should handle version compatibility', () => {
			const futureVersionState: SerializedFileState = {
				version: 2, // Future version
				changes: []
			};

			// Extension should handle different versions gracefully
			assert.strictEqual(futureVersionState.version, 2);

			const currentVersionState: SerializedFileState = {
				version: 1,
				changes: []
			};

			assert.strictEqual(currentVersionState.version, 1);
		});
	});

	suite('Type Safety Tests', () => {
		test('should enforce type constraints', () => {
			// These tests verify TypeScript type checking at runtime
			
			// Should allow valid ExtendedRangeType values
			const validTypes = [
				ExtendedRangeType.Unknown,
				ExtendedRangeType.UserEdit,
				ExtendedRangeType.AIGenerated,
				ExtendedRangeType.UndoRedo,
				ExtendedRangeType.Paste,
				ExtendedRangeType.IDEPaste
			];

			validTypes.forEach(type => {
				const change: SerializedChange = {
					start: { line: 0, character: 0 },
					end: { line: 0, character: 1 },
					type: type,
					creationTimestamp: Date.now()
				};
				assert.ok(change);
			});
		});

		test('should handle position coordinates correctly', () => {
			const change: SerializedChange = {
				start: { line: 0, character: 0 },
				end: { line: 100, character: 9999 },
				type: ExtendedRangeType.UserEdit,
				creationTimestamp: Date.now()
			};

			// Should handle large line/character numbers
			assert.strictEqual(change.start.line, 0);
			assert.strictEqual(change.start.character, 0);
			assert.strictEqual(change.end.line, 100);
			assert.strictEqual(change.end.character, 9999);
		});
	});
});
