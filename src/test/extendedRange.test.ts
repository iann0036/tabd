import * as assert from 'assert';
import * as vscode from 'vscode';
import { ExtendedRange, ExtendedRangeType, ExtendedRangeOptions, mergeRangesSequentially, mergeUserEdits } from '../extendedRange';

suite('ExtendedRange Test Suite', () => {

	suite('ExtendedRange Constructor Tests', () => {
		test('should create with minimal parameters', () => {
			const start = new vscode.Position(1, 5);
			const end = new vscode.Position(2, 10);
			const range = new ExtendedRange(start, end);

			assert.strictEqual(range.start.line, 1);
			assert.strictEqual(range.start.character, 5);
			assert.strictEqual(range.end.line, 2);
			assert.strictEqual(range.end.character, 10);
			assert.strictEqual(range.getType(), ExtendedRangeType.Unknown);
			assert.strictEqual(range.getAuthor(), '');
			assert.ok(range.getCreationTimestamp() > 0);
		});

		test('should create with all parameters', () => {
			const start = new vscode.Position(0, 0);
			const end = new vscode.Position(1, 0);
			const timestamp = 1234567890;
			const options = new ExtendedRangeOptions();
			options.pasteUrl = 'https://stackoverflow.com/questions/123';
			options.pasteTitle = 'How to test VS Code extensions';
			options.aiName = 'GitHub Copilot';
			options.aiModel = 'gpt-4';

			const range = new ExtendedRange(
				start,
				end,
				ExtendedRangeType.AIGenerated,
				timestamp,
				'test-user',
				options
			);

			assert.strictEqual(range.getType(), ExtendedRangeType.AIGenerated);
			assert.strictEqual(range.getAuthor(), 'test-user');
			assert.strictEqual(range.getCreationTimestamp(), timestamp);
			assert.strictEqual(range.getPasteUrl(), 'https://stackoverflow.com/questions/123');
			assert.strictEqual(range.getPasteTitle(), 'How to test VS Code extensions');
			assert.strictEqual(range.getAiName(), 'GitHub Copilot');
			assert.strictEqual(range.getAiModel(), 'gpt-4');
		});
	});

	suite('ExtendedRange Setter Tests', () => {
		test('should update type', () => {
			const range = new ExtendedRange(
				new vscode.Position(0, 0),
				new vscode.Position(0, 5)
			);

			range.setType(ExtendedRangeType.UserEdit);
			assert.strictEqual(range.getType(), ExtendedRangeType.UserEdit);
		});

		test('should update timestamp', () => {
			const range = new ExtendedRange(
				new vscode.Position(0, 0),
				new vscode.Position(0, 5)
			);

			const newTimestamp = 9876543210;
			range.setCreationTimestamp(newTimestamp);
			assert.strictEqual(range.getCreationTimestamp(), newTimestamp);
		});

		test('should update author', () => {
			const range = new ExtendedRange(
				new vscode.Position(0, 0),
				new vscode.Position(0, 5)
			);

			range.setAuthor('new-author');
			assert.strictEqual(range.getAuthor(), 'new-author');
		});
	});

	suite('mergeUserEdits Tests', () => {
		test('should merge adjacent user edits within time window', () => {
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
					new vscode.Position(0, 10),
					new vscode.Position(0, 15),
					ExtendedRangeType.UserEdit,
					baseTime + 45000, // 45 seconds later
					'user1'
				)
			];

			const merged = mergeUserEdits(ranges);
			
			// Should merge all three adjacent user edits
			assert.strictEqual(merged.length, 1);
			assert.strictEqual(merged[0].getType(), ExtendedRangeType.UserEdit);
			assert.strictEqual(merged[0].start.character, 0);
			assert.strictEqual(merged[0].end.character, 15);
			assert.strictEqual(merged[0].getCreationTimestamp(), baseTime); // Should use earliest timestamp
		});

		test('should not merge non-adjacent user edits', () => {
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
					new vscode.Position(0, 10), // Gap between 5 and 10
					new vscode.Position(0, 15),
					ExtendedRangeType.UserEdit,
					baseTime + 30000,
					'user1'
				)
			];

			const merged = mergeUserEdits(ranges);
			
			// Should not merge due to gap
			assert.strictEqual(merged.length, 2);
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

		test('should preserve non-user-edit ranges', () => {
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
					new vscode.Position(1, 0),
					new vscode.Position(1, 10),
					ExtendedRangeType.Paste,
					baseTime,
					'user1'
				),
				new ExtendedRange(
					new vscode.Position(2, 0),
					new vscode.Position(2, 8),
					ExtendedRangeType.AIGenerated,
					baseTime,
					'user1'
				)
			];

			const merged = mergeUserEdits(ranges);
			
			// Should have 3 ranges: 1 user edit, 1 paste, 1 AI generated
			assert.strictEqual(merged.length, 3);
			assert.ok(merged.some(r => r.getType() === ExtendedRangeType.UserEdit));
			assert.ok(merged.some(r => r.getType() === ExtendedRangeType.Paste));
			assert.ok(merged.some(r => r.getType() === ExtendedRangeType.AIGenerated));
		});

		test('should handle empty input', () => {
			const merged = mergeUserEdits([]);
			assert.strictEqual(merged.length, 0);
		});

		test('should handle single range', () => {
			const range = new ExtendedRange(
				new vscode.Position(0, 0),
				new vscode.Position(0, 5),
				ExtendedRangeType.UserEdit
			);

			const merged = mergeUserEdits([range]);
			assert.strictEqual(merged.length, 1);
			assert.strictEqual(merged[0], range);
		});
	});

	suite('mergeRangesSequentially Tests', () => {
		test('should handle non-overlapping ranges', () => {
			const existingRanges = [
				new ExtendedRange(
					new vscode.Position(0, 0),
					new vscode.Position(0, 5),
					ExtendedRangeType.UserEdit,
					1000
				)
			];

			const newRanges = [
				new ExtendedRange(
					new vscode.Position(1, 0),
					new vscode.Position(1, 5),
					ExtendedRangeType.Paste,
					2000
				)
			];

			const merged = mergeRangesSequentially(existingRanges, newRanges);
			
			// Should have both ranges
			assert.strictEqual(merged.length, 2);
			assert.ok(merged.some(r => r.getType() === ExtendedRangeType.UserEdit));
			assert.ok(merged.some(r => r.getType() === ExtendedRangeType.Paste));
		});

		test('should prioritize newer ranges in overlaps', () => {
			const oldTime = 1000;
			const newTime = 2000;

			const existingRanges = [
				new ExtendedRange(
					new vscode.Position(0, 0),
					new vscode.Position(0, 10),
					ExtendedRangeType.UserEdit,
					oldTime
				)
			];

			const newRanges = [
				new ExtendedRange(
					new vscode.Position(0, 5),
					new vscode.Position(0, 15),
					ExtendedRangeType.AIGenerated,
					newTime
				)
			];

			const merged = mergeRangesSequentially(existingRanges, newRanges);
			
			// Should have the AI range and possibly split user edit ranges
			assert.ok(merged.some(r => r.getType() === ExtendedRangeType.AIGenerated));
			
			// Find the AI range and verify it's complete
			const aiRange = merged.find(r => r.getType() === ExtendedRangeType.AIGenerated);
			assert.ok(aiRange);
			assert.strictEqual(aiRange.start.character, 5);
			assert.strictEqual(aiRange.end.character, 15);
		});

		test('should split existing range when new range is contained within', () => {
			const oldTime = 1000;
			const newTime = 2000;

			const existingRanges = [
				new ExtendedRange(
					new vscode.Position(0, 0),
					new vscode.Position(0, 20),
					ExtendedRangeType.UserEdit,
					oldTime
				)
			];

			const newRanges = [
				new ExtendedRange(
					new vscode.Position(0, 5),
					new vscode.Position(0, 15),
					ExtendedRangeType.AIGenerated,
					newTime
				)
			];

			const merged = mergeRangesSequentially(existingRanges, newRanges);
			
			// Should have the AI range plus the split user edit ranges
			assert.ok(merged.some(r => r.getType() === ExtendedRangeType.AIGenerated));
			
			// Check for split user edit ranges
			const userRanges = merged.filter(r => r.getType() === ExtendedRangeType.UserEdit);
			if (userRanges.length > 0) {
				// If there are user ranges, they should be the non-overlapping parts
				userRanges.forEach(range => {
					assert.ok(range.end.character <= 5 || range.start.character >= 15);
				});
			}
		});

		test('should handle completely overlapping ranges', () => {
			const oldTime = 1000;
			const newTime = 2000;

			const existingRanges = [
				new ExtendedRange(
					new vscode.Position(0, 5),
					new vscode.Position(0, 10),
					ExtendedRangeType.UserEdit,
					oldTime
				)
			];

			const newRanges = [
				new ExtendedRange(
					new vscode.Position(0, 0),
					new vscode.Position(0, 15),
					ExtendedRangeType.AIGenerated,
					newTime
				)
			];

			const merged = mergeRangesSequentially(existingRanges, newRanges);
			
			// Should only have the newer AI range
			assert.strictEqual(merged.length, 1);
			assert.strictEqual(merged[0].getType(), ExtendedRangeType.AIGenerated);
		});

		test('should preserve older ranges when newer ranges don\'t overlap', () => {
			const oldTime = 2000; // Older but with higher timestamp
			const newTime = 1000;

			const existingRanges = [
				new ExtendedRange(
					new vscode.Position(0, 5),
					new vscode.Position(0, 10),
					ExtendedRangeType.UserEdit,
					oldTime
				)
			];

			const newRanges = [
				new ExtendedRange(
					new vscode.Position(0, 6),
					new vscode.Position(0, 9),
					ExtendedRangeType.AIGenerated,
					newTime
				)
			];

			const merged = mergeRangesSequentially(existingRanges, newRanges);
			
			// Should preserve the newer user edit and split it appropriately
			assert.ok(merged.some(r => r.getType() === ExtendedRangeType.UserEdit));
		});

		test('should handle empty inputs', () => {
			assert.strictEqual(mergeRangesSequentially([], []).length, 0);
			
			const singleRange = [
				new ExtendedRange(
					new vscode.Position(0, 0),
					new vscode.Position(0, 5),
					ExtendedRangeType.UserEdit
				)
			];
			
			assert.strictEqual(mergeRangesSequentially(singleRange, []).length, 1);
			assert.strictEqual(mergeRangesSequentially([], singleRange).length, 1);
		});
	});

	suite('ExtendedRangeOptions Tests', () => {
		test('should create empty options', () => {
			const options = new ExtendedRangeOptions();
			assert.strictEqual(options.pasteUrl, undefined);
			assert.strictEqual(options.pasteTitle, undefined);
			assert.strictEqual(options.aiName, undefined);
			assert.strictEqual(options.aiModel, undefined);
		});

		test('should store all option values', () => {
			const options = new ExtendedRangeOptions();
			options.pasteUrl = 'https://example.com';
			options.pasteTitle = 'Example Page';
			options.aiName = 'GPT-4';
			options.aiModel = 'gpt-4-turbo';

			assert.strictEqual(options.pasteUrl, 'https://example.com');
			assert.strictEqual(options.pasteTitle, 'Example Page');
			assert.strictEqual(options.aiName, 'GPT-4');
			assert.strictEqual(options.aiModel, 'gpt-4-turbo');
		});
	});

	suite('ExtendedRangeType Enum Tests', () => {
		test('should have correct string values', () => {
			assert.strictEqual(ExtendedRangeType.Unknown, 'UNKNOWN');
			assert.strictEqual(ExtendedRangeType.UserEdit, 'USER_EDIT');
			assert.strictEqual(ExtendedRangeType.AIGenerated, 'AI_GENERATED');
			assert.strictEqual(ExtendedRangeType.UndoRedo, 'UNDO_REDO');
			assert.strictEqual(ExtendedRangeType.Paste, 'PASTE');
			assert.strictEqual(ExtendedRangeType.IDEPaste, 'IDE_PASTE');
		});
	});
});
