import * as vscode from 'vscode';
import { ExtendedRange, ExtendedRangeType } from './extendedRange';

const debugLogsOnDebugConsole = (
   changes: vscode.TextDocumentContentChangeEvent[],
   toUpdateRanges: ExtendedRange[],
   updatedRanges: ExtendedRange[]
): void => {
   console.log(`-------------------`);
   console.log(`-------------------`);

   console.log(`Change ranges`);
   for (const change of changes) {
      console.log(`    start: ${change.range.start.line} ${change.range.start.character}`);
      console.log(`    end: ${change.range.end.line} ${change.range.end.character}`);
      console.log(`    -----`);
   }

   console.log('To update ranges');
   for (const range of toUpdateRanges) {
      console.log(`    start: ${range.start.line} ${range.start.character}`);
      console.log(`    end: ${range.end.line} ${range.end.character}`);
      console.log(`    -----`);
   }

   console.log('Updated ranges');
   for (const range of updatedRanges) {
      console.log(`    start: ${range.start.line} ${range.start.character}`);
      console.log(`    end: ${range.end.line} ${range.end.character}`);
      console.log(`    -----`);
   }
};

const debugLogsOnExtensionChannel = (
   changes: vscode.TextDocumentContentChangeEvent[],
   toUpdateRanges: ExtendedRange[],
   updatedRanges: ExtendedRange[],
   outputChannel: vscode.OutputChannel
): void => {
   outputChannel.appendLine(`-------------------`);
   outputChannel.appendLine(`-------------------`);

   outputChannel.appendLine(`Change ranges`);
   for (const change of changes) {
      outputChannel.appendLine(
         `    start: ${change.range.start.line} ${change.range.start.character}`
      );
      outputChannel.appendLine(`    end: ${change.range.end.line} ${change.range.end.character}`);
      outputChannel.appendLine(`    -----`);
   }

   outputChannel.appendLine('To update ranges');
   for (const range of toUpdateRanges) {
      outputChannel.appendLine(`    start: ${range.start.line} ${range.start.character}`);
      outputChannel.appendLine(`    end: ${range.end.line} ${range.end.character}`);
      outputChannel.appendLine(`    -----`);
   }

   outputChannel.appendLine('Updated ranges');
   for (const range of updatedRanges) {
      outputChannel.appendLine(`    start: ${range.start.line} ${range.start.character}`);
      outputChannel.appendLine(`    end: ${range.end.line} ${range.end.character}`);
      outputChannel.appendLine(`    -----`);
   }
};

const getUpdatedPosition = (
   position: vscode.Position,
   change: vscode.TextDocumentContentChangeEvent
): vscode.Position => {
   let newLine = position.line;
   let newCharacter = position.character;

   // change before position-to-update
   if (change.range.end.isBeforeOrEqual(position)) {
      // change consisted in deletion
      if (!change.range.start.isEqual(change.range.end)) {
         // change range is also on the position-to-update's line
         if (change.range.end.line === newLine) {
            const characterDelta = change.range.end.character - change.range.start.character;
            newCharacter -= characterDelta;
         }

         const lineDelta = change.range.end.line - change.range.start.line;
         newLine -= lineDelta;
      }

      // change consisted in insertion
      if (change.text) {
         // insertion is on the same line as the position-to-update
         if (change.range.start.line === newLine) {
            // the insertion has at least one new line
            if (change.text.split('\n').length - 1 > 0) {
               newCharacter -= change.range.start.character;

               const index = change.text.lastIndexOf('\n');
               newCharacter += change.text.slice(index + 1, change.text.length).length;

               // the insertion has no new lines
            } else {
               newCharacter += change.text.length;
            }
         }

         newLine += change.text.split('\n').length - 1;
      }
   }

   return new vscode.Position(newLine, newCharacter);
};

type OnDeletion = "remove" | "shrink";
type OnAddition = "remove" | "extend" | "split";

interface UpdateOptions {
   onDeletion?: OnDeletion;
   onAddition?: OnAddition;
   debugConsole?: boolean;
   outputChannel?: vscode.OutputChannel;
}

const getUpdatedRanges = (
   ranges: ExtendedRange[],
   changes: readonly vscode.TextDocumentContentChangeEvent[],
   options: UpdateOptions,
   reason: (vscode.TextDocumentChangeReason | undefined),
   document: vscode.TextDocument
): ExtendedRange[] => {
   let toUpdateRanges: (ExtendedRange | null)[] = [...ranges];
   let additionalRanges: ExtendedRange[] = [];

   // Sort all changes in order so that the first one is the change that's the closest to
   // the end of the document, and the last one is the change that's the closest to
   // the begining of the document.
   const sortedChanges = [...changes].sort((change1, change2) =>
      change2.range.start.compareTo(change1.range.start)
   );

   let onDeletion: OnDeletion | undefined = undefined;
   let onAddition: OnAddition | undefined = undefined;
   let debugConsole: boolean | undefined = undefined;
   let outputChannel: vscode.OutputChannel | undefined = undefined;
   if (options) {
      ({ onDeletion, onAddition, debugConsole, outputChannel } = options);
   }
   if (!onDeletion) {
      onDeletion = 'shrink';
   }
   if (!onAddition) {
      onAddition = 'extend';
   }

   for (const change of sortedChanges) {
      for (let i = 0; i < toUpdateRanges.length; i++) {
         const currentRange = toUpdateRanges[i];
         if (!currentRange) {
            continue;
         }

         if (
            change.range.intersection(currentRange) &&
            !change.range.end.isEqual(currentRange.start) &&
            !change.range.start.isEqual(currentRange.end)
         ) {
            if (!change.range.start.isEqual(change.range.end)) {
               if (onDeletion === 'remove') {
                  toUpdateRanges[i] = null;
               } else if (onDeletion === 'shrink') {
                  let newRangeStart = currentRange.start;
                  let newRangeEnd = currentRange.end;

                  if (change.range.contains(currentRange.start)) {
                     newRangeStart = change.range.end;
                  }

                  if (change.range.contains(currentRange.end)) {
                     newRangeEnd = change.range.start;
                  }

                  if (newRangeEnd.isBefore(newRangeStart)) {
                     toUpdateRanges[i] = null;
                  } else {
                     toUpdateRanges[i] = new ExtendedRange(newRangeStart, newRangeEnd, currentRange.getType(), currentRange.getCreationTimestamp());
                  }
               }
            }
         }

         const updatedRange = toUpdateRanges[i];
         if (!updatedRange) {
            continue;
         }

         if (
            change.range.intersection(updatedRange) &&
            !change.range.end.isEqual(updatedRange.start) &&
            !change.range.start.isEqual(updatedRange.end)
         ) {
            if (change.text) {
               if (onAddition === 'remove') {
                  toUpdateRanges[i] = null;
               } else if (onAddition === 'split') {
                  toUpdateRanges.splice(
                     i + 1,
                     0,
                     new ExtendedRange(change.range.start, updatedRange.end, updatedRange.getType(), updatedRange.getCreationTimestamp())
                  );
                  toUpdateRanges[i] = new ExtendedRange(updatedRange.start, change.range.start, updatedRange.getType(), updatedRange.getCreationTimestamp());
               }
            }
         }

         const finalRange = toUpdateRanges[i];
         if (!finalRange) {
            continue;
         }

         const updatedRangeStart = getUpdatedPosition(finalRange.start, change);
         let updatedRangeEnd: vscode.Position;

         if (
            !finalRange.start.isEqual(finalRange.end) &&
            finalRange.end.isEqual(change.range.end)
         ) {
            updatedRangeEnd = finalRange.end;
         } else {
            updatedRangeEnd = getUpdatedPosition(finalRange.end, change);
         }

         toUpdateRanges[i] = new ExtendedRange(updatedRangeStart, updatedRangeEnd, finalRange.getType(), finalRange.getCreationTimestamp());
      }

      // Add new ranges
      if (!change.range.start.isEqual(change.range.end)) {
         // Preserve start to end range for overrides
         additionalRanges.push(new ExtendedRange(change.range.start, change.range.end, ExtendedRangeType.Unknown, Date.now()));
      }

      if (reason === vscode.TextDocumentChangeReason.Undo || reason === vscode.TextDocumentChangeReason.Redo) {
         additionalRanges.push(new ExtendedRange(change.range.end, document.positionAt(document.offsetAt(change.range.start) + change.text.length), ExtendedRangeType.UndoRedo, Date.now()));
         continue;
      }

      if (change.text.trim().length <= 1) {
         additionalRanges.push(new ExtendedRange(change.range.end, document.positionAt(document.offsetAt(change.range.start) + change.text.length), ExtendedRangeType.UserEdit, Date.now()));
         continue;
      }

      additionalRanges.push(new ExtendedRange(change.range.end, document.positionAt(document.offsetAt(change.range.start) + change.text.length), ExtendedRangeType.AIModification, Date.now()));
      //
   }

   // Add additional ranges to the toUpdateRanges (possibly prepend?)
   if (additionalRanges.length > 0) {
      toUpdateRanges = toUpdateRanges.concat(additionalRanges);
   }

   for (let i = 0; i < toUpdateRanges.length - 1; i++) {
      const rangeI = toUpdateRanges[i];
      if (!rangeI) {
         continue;
      }

      for (let j = i + 1; j < toUpdateRanges.length; j++) {
         const rangeJ = toUpdateRanges[j];
         if (!rangeJ) {
            continue;
         }

         if (
            rangeI.end.isEqual(rangeJ.start) ||
            rangeI.start.isEqual(rangeJ.end)
         ) {
            if (rangeJ.start.isEqual(rangeJ.end)) {
               toUpdateRanges[j] = null;
            } else if (rangeI.start.isEqual(rangeI.end)) {
               toUpdateRanges[i] = null;
            }
         }
      }
   }

   const updatedRanges = toUpdateRanges.filter((range): range is ExtendedRange => range !== null);

   // debugConsole && debugLogsOnDebugConsole(sortedChanges, ranges, updatedRanges);
   outputChannel && debugLogsOnExtensionChannel(sortedChanges, ranges, updatedRanges, outputChannel);

   return updatedRanges;
};

export { getUpdatedRanges, getUpdatedPosition };