import * as vscode from 'vscode';
import { ExtendedRange, ExtendedRangeType } from './extendedRange';

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
   pasteRanges: ExtendedRange[],
   changes: readonly vscode.TextDocumentContentChangeEvent[],
   options: UpdateOptions,
   reason: (vscode.TextDocumentChangeReason | ExtendedRangeType.Paste | undefined),
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
   if (options) {
      ({ onDeletion, onAddition } = options);
   }
   if (!onDeletion) {
      onDeletion = 'shrink';
   }
   if (!onAddition) {
      onAddition = 'extend';
   }

   for (const change of sortedChanges) {
      // Add new ranges
      let isAI = false;

      if (pasteRanges.length > 0) {
         for (const pasteRange of pasteRanges) {
            if (pasteRange.start.isEqual(change.range.start) && pasteRange.getCreationTimestamp() > Date.now() - 200) {
               reason = ExtendedRangeType.Paste;
            }
         }
      }

      if (reason === ExtendedRangeType.Paste) {
         additionalRanges.push(new ExtendedRange(change.range.end, document.positionAt(document.offsetAt(change.range.start) + change.text.length), ExtendedRangeType.Paste, Date.now()));
      } else if (reason === vscode.TextDocumentChangeReason.Undo || reason === vscode.TextDocumentChangeReason.Redo) {
         additionalRanges.push(new ExtendedRange(change.range.end, document.positionAt(document.offsetAt(change.range.start) + change.text.length), ExtendedRangeType.UndoRedo, Date.now()));
      } else if (change.text.trim().length <= 1) {
         additionalRanges.push(new ExtendedRange(change.range.end, document.positionAt(document.offsetAt(change.range.start) + change.text.length), ExtendedRangeType.UserEdit, Date.now()));
      } else {
         if (!change.range.start.isEqual(change.range.end)) { // TODO: and if the delta text matches
            isAI = true;
         }
         additionalRanges.push(new ExtendedRange(change.range.end, document.positionAt(document.offsetAt(change.range.start) + change.text.length), ExtendedRangeType.AIGenerated, Date.now()));
      }
      //

      for (let i = 0; i < toUpdateRanges.length; i++) {
         // ** onDeletion **
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
               if (isAI) {
                  let newRangeStart = currentRange.start;
                  let newRangeEnd = currentRange.end;

                  let aiChangeRangeStart = change.range.end;
                  let aiChangeRangeEnd = document.positionAt(document.offsetAt(change.range.start) + change.text.length);
                  let aiChangeRange = new vscode.Range(aiChangeRangeStart, aiChangeRangeEnd);

                  if (aiChangeRange.contains(currentRange.start)) {
                     newRangeStart = aiChangeRangeEnd;
                  }

                  if (aiChangeRange.contains(currentRange.end)) {
                     newRangeEnd = aiChangeRangeStart;
                  }

                  additionalRanges.push(new ExtendedRange(newRangeStart, newRangeEnd, currentRange.getType(), currentRange.getCreationTimestamp(), currentRange.getAuthor()));
                  toUpdateRanges[i] = null;
               } else if (onDeletion === 'remove') {
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
                     toUpdateRanges[i] = new ExtendedRange(newRangeStart, newRangeEnd, currentRange.getType(), currentRange.getCreationTimestamp(), currentRange.getAuthor());
                  }
               }
            }
         }

         // ** onAddition **
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
                     new ExtendedRange(change.range.start, updatedRange.end, updatedRange.getType(), updatedRange.getCreationTimestamp(), updatedRange.getAuthor())
                  );
                  toUpdateRanges[i] = new ExtendedRange(updatedRange.start, change.range.start, updatedRange.getType(), updatedRange.getCreationTimestamp(), updatedRange.getAuthor());
               }
            }
         }

         const finalRange = toUpdateRanges[i];
         if (!finalRange) {
            continue;
         }
         //

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

         toUpdateRanges[i] = new ExtendedRange(updatedRangeStart, updatedRangeEnd, finalRange.getType(), finalRange.getCreationTimestamp(), finalRange.getAuthor());
      }
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

   let updatedRanges = toUpdateRanges.filter((range): range is ExtendedRange => range !== null);

   // Add additional ranges
   if (additionalRanges.length > 0) {
     updatedRanges = updatedRanges.concat(additionalRanges);
   }

   return updatedRanges;
};

export { getUpdatedRanges, getUpdatedPosition };