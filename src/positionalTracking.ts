import * as vscode from 'vscode';
import { ExtendedRange, ExtendedRangeType, ExtendedRangeOptions } from './extendedRange';
import * as fs from 'fs';
import { execSync } from 'child_process';

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
   reason: (vscode.TextDocumentChangeReason | ExtendedRangeType.Paste | ExtendedRangeType.IDEPaste | undefined),
   document: vscode.TextDocument
): ExtendedRange[] => {
   let toUpdateRanges: (ExtendedRange | null)[] = [...ranges];
   let additionalRanges: ExtendedRange[] = [];

   // Sort all changes in order so that the first one is the change that's the closest to
   // the end of the document, and the last one is the change that's the closest to
   // the begining of the document.
   let sortedChanges = [...changes].sort((change1, change2) =>
      change2.range.start.compareTo(change1.range.start)
   );

   // If the last change is a zero position, combine all changes into one
   if (
      sortedChanges.length > 0 &&
      sortedChanges[sortedChanges.length - 1].range.start.character === 0 &&
      sortedChanges[sortedChanges.length - 1].range.start.line === 0 &&
      sortedChanges[sortedChanges.length - 1].range.end.character === 0 &&
      sortedChanges[sortedChanges.length - 1].range.end.line === 0
   ) {
      let newText = sortedChanges
         .map(change => change.text)
         .join('');
      sortedChanges = [{
         range: new vscode.Range(
            new vscode.Position(0, 0),
            new vscode.Position(0, 0),
         ),
         text: newText,
         rangeOffset: 0,
         rangeLength: 0
      }];
   }

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
               break;
            }
         }
      }

      if (reason === ExtendedRangeType.Paste || reason === ExtendedRangeType.IDEPaste) {
         const options = new ExtendedRangeOptions();
         const pasteContent = change.text.trim();
         let recentPaste = {url: '', title: '', type: 'clipboard_copy', workspacePath: '', relativePath: ''};
         if (pasteContent.length > 0) {
            recentPaste = checkRecentPaste(pasteContent);
            if (recentPaste && recentPaste.type === 'ide_clipboard_copy') {
               reason = ExtendedRangeType.IDEPaste;
               const ideProps = resolveIDEPaste(recentPaste.workspacePath, recentPaste.relativePath);
               options.pasteUrl = ideProps.url || '';
               options.pasteTitle = ideProps.title || '';
            } else if (recentPaste) {
               options.pasteUrl = recentPaste.url || '';
               options.pasteTitle = recentPaste.title || '';
            }
         } else {
            options.pasteUrl = '';
            options.pasteTitle = '';
         }


         additionalRanges.push(new ExtendedRange(change.range.end, document.positionAt(document.offsetAt(change.range.start) + change.text.length), reason, Date.now(), '', options));
      } else if (reason === vscode.TextDocumentChangeReason.Undo || reason === vscode.TextDocumentChangeReason.Redo) {
         additionalRanges.push(new ExtendedRange(change.range.end, document.positionAt(document.offsetAt(change.range.start) + change.text.length), ExtendedRangeType.UndoRedo, Date.now()));
      } else if (change.text.trim().length <= 1) {
         additionalRanges.push(new ExtendedRange(change.range.end, document.positionAt(document.offsetAt(change.range.start) + change.text.length), ExtendedRangeType.UserEdit, Date.now()));
      } else {
         if (!change.range.start.isEqual(change.range.end)) { // TODO: and if the delta text matches
            isAI = true;
         }

         const options = new ExtendedRangeOptions();
         try {
            const aiData = fs.readFileSync(`${require('os').homedir()}/.tabd/latest_ai.json`, 'utf8');
            const aiInfo = JSON.parse(aiData);

            if (!aiInfo.range) {
               aiInfo.range = [change.range.start, change.range.end]; // TODO: should be whole document range
            }

            if (aiInfo.insertText.includes(change.text) &&
               change.range.start.line === aiInfo.range[0].line &&
               change.range.start.character === aiInfo.range[0].character &&
               change.range.end.line === aiInfo.range[1].line &&
               change.range.end.character === aiInfo.range[1].character &&
               aiInfo._timestamp > Date.now() - 2000
            ) {
               options.aiName = aiInfo._extensionName || 'unknown';
               options.aiModel = aiInfo._modelId || aiInfo.command.arguments[0].telemetry.properties.engineName || '';
               options.aiExplanation = aiInfo._explanation || '';
               options.aiType = aiInfo._type || '';
            }
         } catch (error) { }

         additionalRanges.push(new ExtendedRange(change.range.end, document.positionAt(document.offsetAt(change.range.start) + change.text.length), ExtendedRangeType.AIGenerated, Date.now(), '', options));
      }

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

                  additionalRanges.push(new ExtendedRange(newRangeStart, newRangeEnd, currentRange.getType(), currentRange.getCreationTimestamp(), currentRange.getAuthor(), currentRange.getOptions()));
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
                     toUpdateRanges[i] = new ExtendedRange(newRangeStart, newRangeEnd, currentRange.getType(), currentRange.getCreationTimestamp(), currentRange.getAuthor(), currentRange.getOptions());
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
                     new ExtendedRange(change.range.start, updatedRange.end, updatedRange.getType(), updatedRange.getCreationTimestamp(), updatedRange.getAuthor(), updatedRange.getOptions())
                  );
                  toUpdateRanges[i] = new ExtendedRange(updatedRange.start, change.range.start, updatedRange.getType(), updatedRange.getCreationTimestamp(), updatedRange.getAuthor(), updatedRange.getOptions());
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

         toUpdateRanges[i] = new ExtendedRange(updatedRangeStart, updatedRangeEnd, finalRange.getType(), finalRange.getCreationTimestamp(), finalRange.getAuthor(), finalRange.getOptions());
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

function checkRecentPaste(content: string) {
   // Read from home directory file
   const homeDir = require('os').homedir();
   const recentPastesFile = `${homeDir}/.tabd/latest_clipboard.json`;
   /*
   {
   "type": "clipboard_copy|ide_clipboard_copy",
   "text": "sometext",
   "timestamp": 1751376150324,
   "url": "https://example.com",
   "title": "Example Domain"
   }
  */
   try {
      const data = require('fs').readFileSync(recentPastesFile, 'utf8');
      const recentPastes = JSON.parse(data);
      if ((recentPastes.type === 'clipboard_copy' || recentPastes.type === 'ide_clipboard_copy') && recentPastes.text.trim() === content && recentPastes.timestamp > Date.now() - 3600000) { // 1 hour
         return recentPastes;
      }
   } catch (error) {}
   return null;
}

function resolveIDEPaste(workspacePath: string, relativePath: string): { url: string, title: string } {
   // Get Git information for the document
   let gitUrl = '';
   let branchName = 'main';
   
   try {
      // Get the Git repository URL
      const remoteUrl = execSync('git config --get remote.origin.url', {
         cwd: workspacePath,
         encoding: 'utf8',
         timeout: 2000,
      }).trim();
      
      // Clean up the URL for display (remove .git suffix and convert SSH to HTTPS if needed)
      if (remoteUrl.startsWith('git@')) {
         // Convert SSH URL to HTTPS
         gitUrl = remoteUrl
            .replace(/^git@([^:]+):/, 'https://$1/')
            .replace(/\.git$/, '');
      } else if (remoteUrl.startsWith('https://')) {
         gitUrl = remoteUrl.replace(/\.git$/, '');
      } else {
         gitUrl = remoteUrl;
      }
      
      // Get the current branch name
      branchName = execSync('git rev-parse --abbrev-ref HEAD', {
         cwd: workspacePath,
         encoding: 'utf8',
         timeout: 2000,
      }).trim();
   } catch (gitError) {
      console.warn('Failed to get Git information:', gitError);
   }

   return { url: gitUrl, title: relativePath + (branchName === 'main' || branchName === 'master' ? '' : ` (on branch ${branchName})`) };
}

export { getUpdatedRanges, getUpdatedPosition };