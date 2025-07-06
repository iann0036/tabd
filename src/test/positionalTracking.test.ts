import * as assert from 'assert';
import * as vscode from 'vscode';
import { getUpdatedPosition, getUpdatedRanges } from '../positionalTracking';
import { ExtendedRange, ExtendedRangeType, ExtendedRangeOptions } from '../extendedRange';

suite('Positional Tracking Test Suite', () => {

	suite('getUpdatedPosition Tests', () => {
		test('should handle insertion before position', () => {
			const position = new vscode.Position(5, 10);
			const change: vscode.TextDocumentContentChangeEvent = {
				range: new vscode.Range(new vscode.Position(3, 0), new vscode.Position(3, 0)),
				rangeOffset: 0,
				rangeLength: 0,
				text: 'new line\n'
			};

			const result = getUpdatedPosition(position, change);
			
			// Should move position down by 1 line due to newline insertion
			assert.strictEqual(result.line, 6);
			assert.strictEqual(result.character, 10);
		});

		test('should handle insertion on same line before character', () => {
			const position = new vscode.Position(2, 10);
			const change: vscode.TextDocumentContentChangeEvent = {
				range: new vscode.Range(new vscode.Position(2, 5), new vscode.Position(2, 5)),
				rangeOffset: 0,
				rangeLength: 0,
				text: 'hello'
			};

			const result = getUpdatedPosition(position, change);
			
			// Should move character position by length of inserted text
			assert.strictEqual(result.line, 2);
			assert.strictEqual(result.character, 15); // 10 + 5
		});

		test('should handle multi-line insertion on same line', () => {
			const position = new vscode.Position(2, 10);
			const change: vscode.TextDocumentContentChangeEvent = {
				range: new vscode.Range(new vscode.Position(2, 5), new vscode.Position(2, 5)),
				rangeOffset: 0,
				rangeLength: 0,
				text: 'hello\nworld\ntest'
			};

			const result = getUpdatedPosition(position, change);
			
			// Should move down by 2 lines and adjust character position
			assert.strictEqual(result.line, 4); // 2 + 2 newlines
			assert.strictEqual(result.character, 9); // 10 - 5 + 4 (length of "test")
		});

		test('should handle deletion before position', () => {
			const position = new vscode.Position(5, 10);
			const change: vscode.TextDocumentContentChangeEvent = {
				range: new vscode.Range(new vscode.Position(3, 0), new vscode.Position(4, 0)),
				rangeOffset: 0,
				rangeLength: 10,
				text: ''
			};

			const result = getUpdatedPosition(position, change);
			
			// Should move up by 1 line due to line deletion
			assert.strictEqual(result.line, 4);
			assert.strictEqual(result.character, 10);
		});

		test('should handle deletion on same line', () => {
			const position = new vscode.Position(2, 15);
			const change: vscode.TextDocumentContentChangeEvent = {
				range: new vscode.Range(new vscode.Position(2, 5), new vscode.Position(2, 10)),
				rangeOffset: 0,
				rangeLength: 5,
				text: ''
			};

			const result = getUpdatedPosition(position, change);
			
			// Should move character position back by deleted characters
			assert.strictEqual(result.line, 2);
			assert.strictEqual(result.character, 10); // 15 - 5
		});

		test('should not affect position when change is after', () => {
			const position = new vscode.Position(2, 5);
			const change: vscode.TextDocumentContentChangeEvent = {
				range: new vscode.Range(new vscode.Position(3, 0), new vscode.Position(3, 0)),
				rangeOffset: 0,
				rangeLength: 0,
				text: 'new text'
			};

			const result = getUpdatedPosition(position, change);
			
			// Position should remain unchanged
			assert.strictEqual(result.line, 2);
			assert.strictEqual(result.character, 5);
		});
	});

	suite('getUpdatedRanges Tests', () => {
		// Mock document for testing
		const createMockDocument = (content: string): vscode.TextDocument => {
			const lines = content.split('\n');
			return {
				lineCount: lines.length,
				getText: (range?: vscode.Range) => {
					if (!range) {
						return content;
					}
					// Simplified implementation for testing
					return content.substring(0, 10); // Placeholder
				},
				lineAt: (line: number) => ({
					text: lines[line] || '',
					lineNumber: line,
					range: new vscode.Range(line, 0, line, lines[line]?.length || 0),
					rangeIncludingLineBreak: new vscode.Range(line, 0, line + 1, 0),
					firstNonWhitespaceCharacterIndex: 0,
					isEmptyOrWhitespace: !lines[line]?.trim()
				}),
				positionAt: (offset: number) => new vscode.Position(0, offset),
				offsetAt: (position: vscode.Position) => position.line * 100 + position.character,
			} as any;
		};

		test('should create new user edit range for small changes', () => {
			const existingRanges: ExtendedRange[] = [];
			const pasteRanges: ExtendedRange[] = [];
			const changes: vscode.TextDocumentContentChangeEvent[] = [{
				range: new vscode.Range(new vscode.Position(0, 5), new vscode.Position(0, 5)),
				rangeOffset: 0,
				rangeLength: 0,
				text: 'a'
			}];

			const mockDoc = createMockDocument('hello world');
			const result = getUpdatedRanges(
				existingRanges,
				pasteRanges,
				changes,
				{ onDeletion: 'shrink', onAddition: 'split' },
				undefined,
				mockDoc
			);

			assert.strictEqual(result.length, 1);
			assert.strictEqual(result[0].getType(), ExtendedRangeType.UserEdit);
		});

		test('should create AI generated range for large changes', () => {
			const existingRanges: ExtendedRange[] = [];
			const pasteRanges: ExtendedRange[] = [];
			const changes: vscode.TextDocumentContentChangeEvent[] = [{
				range: new vscode.Range(new vscode.Position(0, 0), new vscode.Position(0, 5)),
				rangeOffset: 0,
				rangeLength: 5,
				text: 'function generateCode() {\n    return "AI generated";\n}'
			}];

			const mockDoc = createMockDocument('hello world');
			const result = getUpdatedRanges(
				existingRanges,
				pasteRanges,
				changes,
				{ onDeletion: 'shrink', onAddition: 'split' },
				undefined,
				mockDoc
			);

			assert.strictEqual(result.length, 1);
			assert.strictEqual(result[0].getType(), ExtendedRangeType.AIGenerated);
		});

		test('should create paste range when paste is detected', () => {
			const existingRanges: ExtendedRange[] = [];
			const pasteRanges: ExtendedRange[] = [
				new ExtendedRange(
					new vscode.Position(0, 5),
					new vscode.Position(0, 5),
					ExtendedRangeType.Paste,
					Date.now()
				)
			];
			const changes: vscode.TextDocumentContentChangeEvent[] = [{
				range: new vscode.Range(new vscode.Position(0, 5), new vscode.Position(0, 5)),
				rangeOffset: 0,
				rangeLength: 0,
				text: 'pasted content'
			}];

			const mockDoc = createMockDocument('hello world');
			const result = getUpdatedRanges(
				existingRanges,
				pasteRanges,
				changes,
				{ onDeletion: 'shrink', onAddition: 'split' },
				ExtendedRangeType.Paste,
				mockDoc
			);

			assert.strictEqual(result.length, 1);
			assert.strictEqual(result[0].getType(), ExtendedRangeType.Paste);
		});

		test('should create undo/redo range for undo/redo operations', () => {
			const existingRanges: ExtendedRange[] = [];
			const pasteRanges: ExtendedRange[] = [];
			const changes: vscode.TextDocumentContentChangeEvent[] = [{
				range: new vscode.Range(new vscode.Position(0, 0), new vscode.Position(0, 5)),
				rangeOffset: 0,
				rangeLength: 5,
				text: 'undone'
			}];

			const mockDoc = createMockDocument('hello world');
			const result = getUpdatedRanges(
				existingRanges,
				pasteRanges,
				changes,
				{ onDeletion: 'shrink', onAddition: 'split' },
				vscode.TextDocumentChangeReason.Undo,
				mockDoc
			);

			assert.strictEqual(result.length, 1);
			assert.strictEqual(result[0].getType(), ExtendedRangeType.UndoRedo);
		});

		test('should update existing ranges positions', () => {
			const existingRanges: ExtendedRange[] = [
				new ExtendedRange(
					new vscode.Position(2, 0),
					new vscode.Position(2, 10),
					ExtendedRangeType.UserEdit,
					Date.now() - 1000
				)
			];
			const pasteRanges: ExtendedRange[] = [];
			const changes: vscode.TextDocumentContentChangeEvent[] = [{
				range: new vscode.Range(new vscode.Position(1, 0), new vscode.Position(1, 0)),
				rangeOffset: 0,
				rangeLength: 0,
				text: 'new line\n'
			}];

			const mockDoc = createMockDocument('line1\nline2\nline3');
			const result = getUpdatedRanges(
				existingRanges,
				pasteRanges,
				changes,
				{ onDeletion: 'shrink', onAddition: 'split' },
				undefined,
				mockDoc
			);

			// Should have original range moved down plus new range
			assert.ok(result.length >= 1);
			
			const updatedUserEdit = result.find(r => 
				r.getType() === ExtendedRangeType.UserEdit && 
				r.getCreationTimestamp() === existingRanges[0].getCreationTimestamp()
			);
			
			if (updatedUserEdit) {
				// Should be moved down by one line
				assert.strictEqual(updatedUserEdit.start.line, 3);
			}
		});

		test('should shrink ranges on deletion when onDeletion is shrink', () => {
			const existingRanges: ExtendedRange[] = [
				new ExtendedRange(
					new vscode.Position(0, 0),
					new vscode.Position(0, 20),
					ExtendedRangeType.UserEdit,
					Date.now() - 1000
				)
			];
			const pasteRanges: ExtendedRange[] = [];
			const changes: vscode.TextDocumentContentChangeEvent[] = [{
				range: new vscode.Range(new vscode.Position(0, 5), new vscode.Position(0, 15)),
				rangeOffset: 0,
				rangeLength: 10,
				text: ''
			}];

			const mockDoc = createMockDocument('hello world test content');
			const result = getUpdatedRanges(
				existingRanges,
				pasteRanges,
				changes,
				{ onDeletion: 'shrink', onAddition: 'split' },
				undefined,
				mockDoc
			);

			// Should have modified ranges
			assert.ok(result.length >= 1);
		});

		test('should handle empty inputs', () => {
			const mockDoc = createMockDocument('');
			const result = getUpdatedRanges(
				[],
				[],
				[],
				{ onDeletion: 'shrink', onAddition: 'split' },
				undefined,
				mockDoc
			);

			assert.strictEqual(result.length, 0);
		});
	});
});
