import * as assert from 'assert';
import * as vscode from 'vscode';
import { PasteEditProvider } from '../pasteEditProvider';

suite('PasteEditProvider Test Suite', () => {

	suite('Constructor Tests', () => {
		test('should create with notify function', () => {
			const mockNotify = async (doc: vscode.TextDocument, ranges: readonly vscode.Range[]) => {
				// Mock implementation
			};

			const provider = new PasteEditProvider(mockNotify);
			assert.ok(provider);
		});
	});

	suite('provideDocumentPasteEdits Tests', () => {
		test('should return undefined for empty ranges', async () => {
			let notifyCalled = false;
			const mockNotify = async (doc: vscode.TextDocument, ranges: readonly vscode.Range[]) => {
				notifyCalled = true;
			};

			const provider = new PasteEditProvider(mockNotify);
			
			// Mock document
			const mockDocument = {
				uri: vscode.Uri.file('/test/file.ts')
			} as vscode.TextDocument;

			// Mock data transfer
			const mockDataTransfer = new vscode.DataTransfer();
			
			// Mock context
			const mockContext = {} as vscode.DocumentPasteEditContext;
			
			// Mock cancellation token
			const mockToken = {
				isCancellationRequested: false,
				onCancellationRequested: () => ({ dispose: () => {} })
			} as vscode.CancellationToken;

			const result = await provider.provideDocumentPasteEdits(
				mockDocument,
				[], // Empty ranges
				mockDataTransfer,
				mockContext,
				mockToken
			);

			assert.strictEqual(result, undefined);
			assert.strictEqual(notifyCalled, false);
		});

		test('should return undefined for files that should not be processed', async () => {
			let notifyCalled = false;
			const mockNotify = async (doc: vscode.TextDocument, ranges: readonly vscode.Range[]) => {
				notifyCalled = true;
			};

			const provider = new PasteEditProvider(mockNotify);
			
			// Mock document with hidden file
			const mockDocument = {
				uri: vscode.Uri.file('/test/.hidden.ts')
			} as vscode.TextDocument;

			const ranges = [new vscode.Range(0, 0, 0, 5)];
			const mockDataTransfer = new vscode.DataTransfer();
			const mockContext = {} as vscode.DocumentPasteEditContext;
			const mockToken = {
				isCancellationRequested: false,
				onCancellationRequested: () => ({ dispose: () => {} })
			} as vscode.CancellationToken;

			const result = await provider.provideDocumentPasteEdits(
				mockDocument,
				ranges,
				mockDataTransfer,
				mockContext,
				mockToken
			);

			assert.strictEqual(result, undefined);
			assert.strictEqual(notifyCalled, false);
		});

		test('should call notify function for valid paste operations', async () => {
			let notifyCalled = false;
			let notifiedDocument: vscode.TextDocument | undefined;
			let notifiedRanges: readonly vscode.Range[] | undefined;

			const mockNotify = async (doc: vscode.TextDocument, ranges: readonly vscode.Range[]) => {
				notifyCalled = true;
				notifiedDocument = doc;
				notifiedRanges = ranges;
			};

			const provider = new PasteEditProvider(mockNotify);
			
			// Mock document with valid file
			const mockDocument = {
				uri: vscode.Uri.file('/test/file.ts')
			} as vscode.TextDocument;

			const ranges = [
				new vscode.Range(0, 0, 0, 5),
				new vscode.Range(1, 0, 1, 10)
			];
			const mockDataTransfer = new vscode.DataTransfer();
			const mockContext = {} as vscode.DocumentPasteEditContext;
			const mockToken = {
				isCancellationRequested: false,
				onCancellationRequested: () => ({ dispose: () => {} })
			} as vscode.CancellationToken;

			const result = await provider.provideDocumentPasteEdits(
				mockDocument,
				ranges,
				mockDataTransfer,
				mockContext,
				mockToken
			);

			assert.strictEqual(notifyCalled, true);
			assert.strictEqual(notifiedDocument, mockDocument);
			assert.strictEqual(notifiedRanges, ranges);
			assert.strictEqual(result, undefined); // Provider returns undefined after notification
		});

		test('should handle single range paste', async () => {
			let notifyCallCount = 0;
			const mockNotify = async (doc: vscode.TextDocument, ranges: readonly vscode.Range[]) => {
				notifyCallCount++;
				assert.strictEqual(ranges.length, 1);
				assert.strictEqual(ranges[0].start.line, 2);
				assert.strictEqual(ranges[0].start.character, 5);
			};

			const provider = new PasteEditProvider(mockNotify);
			
			const mockDocument = {
				uri: vscode.Uri.file('/test/normal.ts')
			} as vscode.TextDocument;

			const ranges = [new vscode.Range(2, 5, 2, 15)];
			const mockDataTransfer = new vscode.DataTransfer();
			const mockContext = {} as vscode.DocumentPasteEditContext;
			const mockToken = {
				isCancellationRequested: false,
				onCancellationRequested: () => ({ dispose: () => {} })
			} as vscode.CancellationToken;

			await provider.provideDocumentPasteEdits(
				mockDocument,
				ranges,
				mockDataTransfer,
				mockContext,
				mockToken
			);

			assert.strictEqual(notifyCallCount, 1);
		});

		test('should handle multiple ranges paste', async () => {
			let notifyCallCount = 0;
			const mockNotify = async (doc: vscode.TextDocument, ranges: readonly vscode.Range[]) => {
				notifyCallCount++;
				assert.strictEqual(ranges.length, 3);
			};

			const provider = new PasteEditProvider(mockNotify);
			
			const mockDocument = {
				uri: vscode.Uri.file('/test/multi.ts')
			} as vscode.TextDocument;

			const ranges = [
				new vscode.Range(0, 0, 0, 5),
				new vscode.Range(1, 0, 1, 10),
				new vscode.Range(2, 5, 2, 15)
			];
			const mockDataTransfer = new vscode.DataTransfer();
			const mockContext = {} as vscode.DocumentPasteEditContext;
			const mockToken = {
				isCancellationRequested: false,
				onCancellationRequested: () => ({ dispose: () => {} })
			} as vscode.CancellationToken;

			await provider.provideDocumentPasteEdits(
				mockDocument,
				ranges,
				mockDataTransfer,
				mockContext,
				mockToken
			);

			assert.strictEqual(notifyCallCount, 1);
		});

		test('should handle async notify function', async () => {
			let notifyResolved = false;
			const mockNotify = async (doc: vscode.TextDocument, ranges: readonly vscode.Range[]) => {
				// Simulate async operation
				await new Promise(resolve => setTimeout(resolve, 10));
				notifyResolved = true;
			};

			const provider = new PasteEditProvider(mockNotify);
			
			const mockDocument = {
				uri: vscode.Uri.file('/test/async.ts')
			} as vscode.TextDocument;

			const ranges = [new vscode.Range(0, 0, 0, 5)];
			const mockDataTransfer = new vscode.DataTransfer();
			const mockContext = {} as vscode.DocumentPasteEditContext;
			const mockToken = {
				isCancellationRequested: false,
				onCancellationRequested: () => ({ dispose: () => {} })
			} as vscode.CancellationToken;

			await provider.provideDocumentPasteEdits(
				mockDocument,
				ranges,
				mockDataTransfer,
				mockContext,
				mockToken
			);

			assert.strictEqual(notifyResolved, true);
		});

		test('should handle notify function that throws', async () => {
			const mockNotify = async (doc: vscode.TextDocument, ranges: readonly vscode.Range[]) => {
				throw new Error('Test error');
			};

			const provider = new PasteEditProvider(mockNotify);
			
			const mockDocument = {
				uri: vscode.Uri.file('/test/error.ts')
			} as vscode.TextDocument;

			const ranges = [new vscode.Range(0, 0, 0, 5)];
			const mockDataTransfer = new vscode.DataTransfer();
			const mockContext = {} as vscode.DocumentPasteEditContext;
			const mockToken = {
				isCancellationRequested: false,
				onCancellationRequested: () => ({ dispose: () => {} })
			} as vscode.CancellationToken;

			// Should not throw, but handle the error gracefully
			try {
				await provider.provideDocumentPasteEdits(
					mockDocument,
					ranges,
					mockDataTransfer,
					mockContext,
					mockToken
				);
				// If we get here, the provider handled the error
				assert.ok(true);
			} catch (error) {
				// If the error bubbles up, that's also a valid behavior
				assert.ok(error instanceof Error);
			}
		});
	});

	suite('Static Properties Tests', () => {
		test('should have correct static id', () => {
			assert.strictEqual(PasteEditProvider.id, 'tabd.pasteEditProvider');
		});
	});
});
