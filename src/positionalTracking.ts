import * as vscode from 'vscode';
import { ExtendedRange, ExtendedRangeType, ExtendedRangeOptions } from './extendedRange';
import { execSync } from 'child_process';
import { latestClipboardData } from './clipboard';
import { getClipboardContentsFromBrowserExtension } from './nativeHost';

let mostRecentInternalCommand: any = {
    value: { "_type": "initial" },
    document: null,
    changes: [],
};

const typeMap: { [key: string]: string } = {
    'onBeforeApplyPatchTool': 'applyPatch',
    'onBeforeCreateFileTool': 'createFile',
    'onBeforeInsertEditTool': 'insertEdit',
    'onBeforeReplaceStringTool': 'replaceString',
    'onAfterApplyPatchTool': 'applyPatch',
    'onAfterCreateFileTool': 'createFile',
    'onAfterInsertEditTool': 'insertEdit',
    'onAfterReplaceStringTool': 'replaceString',
    'inlineCompletion': 'inlineCompletion',
    'onBeforeApplyEdit': 'applyEdit',
    'onAfterApplyEdit': 'applyEdit',
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

const getUpdatedRanges = (
    ranges: ExtendedRange[],
    pasteRanges: ExtendedRange[],
    changes: readonly vscode.TextDocumentContentChangeEvent[],
    reason: (vscode.TextDocumentChangeReason | ExtendedRangeType.Paste | ExtendedRangeType.IDEPaste | ExtendedRangeType.AIGenerated | undefined),
    document: vscode.TextDocument
): ExtendedRange[] => {
    let toUpdateRanges: (ExtendedRange | null)[] = [...ranges];
    let additionalRanges: ExtendedRange[] = [];
    let clearMostRecentInternalCommandAtEnd = false;

    console.debug("getUpdatedRanges called with reason:", reason, "and changes:", JSON.stringify(changes), "and mostRecentInternalCommand:", mostRecentInternalCommand);
    
    // if all changes are at the start of the document, we need to reverse them - special case (required for insertFile GPT 4.1)
    if (
        changes.length > 1 &&
        changes[changes.length - 1].range.end.line === 0 &&
        changes[changes.length - 1].range.end.character === 0
    ) {
        changes = [{
            range: changes[0].range,
            rangeOffset: changes[0].rangeOffset,
            rangeLength: changes[0].rangeLength,
            text: changes.map(change => change.text).reverse().join(''),
        }];
    }

    let sortedChanges = [...changes].sort((change1, change2) =>
        change2.range.start.compareTo(change1.range.start)
    );

    console.log("Sorted changes:", sortedChanges);

    const aiInfo = mostRecentInternalCommand.value;

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
            if (pasteContent.length > 0) {
                const checkedPaste = checkRecentPaste(pasteContent);
                if (checkedPaste && checkedPaste.type === 'ide_clipboard_copy') {
                    reason = ExtendedRangeType.IDEPaste;
                    const ideProps = resolveIDEPaste(checkedPaste.workspacePath ?? '', checkedPaste.relativePath ?? '');
                    options.pasteUrl = ideProps.url || '';
                    options.pasteTitle = ideProps.title || '';
                } else if (checkedPaste && checkedPaste.type === 'clipboard_copy') {
                    options.pasteUrl = checkedPaste.url || '';
                    options.pasteTitle = checkedPaste.title || '';
                } else {
                    options.pasteUrl = '';
                    options.pasteTitle = '';
                }
            } else {
                options.pasteUrl = '';
                options.pasteTitle = '';
            }


            additionalRanges.push(new ExtendedRange(change.range.start, document.positionAt(document.offsetAt(change.range.start) + change.text.length), reason, Date.now(), '', options));
        } else if (reason === ExtendedRangeType.AIGenerated) { // e.g. onAfterInsertEditTool
            console.debug("Processing AI generated range:", aiInfo, change);
            const options = new ExtendedRangeOptions();

            options.aiName = aiInfo._extensionName || 'unknown';
            options.aiModel = aiInfo._modelId || '';
            if (!options.aiModel && aiInfo.command && aiInfo.command.arguments && aiInfo.command.arguments.length > 0 && aiInfo.command.arguments[0].telemetry && aiInfo.command.arguments[0].telemetry.properties && aiInfo.command.arguments[0].telemetry.properties.engineName) {
                options.aiModel = aiInfo.command.arguments[0].telemetry.properties.engineName;
            }
            options.aiExplanation = aiInfo._explanation || '';
            options.aiType = aiInfo._type ? (typeMap[aiInfo._type] || aiInfo._type) : '';

            additionalRanges.push(new ExtendedRange(change.range.start, document.positionAt(document.offsetAt(change.range.start) + change.text.length), ExtendedRangeType.AIGenerated, Date.now(), '', options));

            isAI = true;

            clearMostRecentInternalCommandAtEnd = true;
        } else if (reason === vscode.TextDocumentChangeReason.Undo || reason === vscode.TextDocumentChangeReason.Redo) {
            additionalRanges.push(new ExtendedRange(change.range.start, document.positionAt(document.offsetAt(change.range.start) + change.text.length), ExtendedRangeType.UndoRedo, Date.now()));
        } else if (change.text.trim().length <= 1 && aiInfo._type !== 'onBeforeInsertEditTool' && aiInfo._type !== 'onBeforeApplyPatchTool' && aiInfo._type !== 'onBeforeCreateFileTool' && aiInfo._type !== 'onBeforeReplaceStringTool' && aiInfo._type !== 'onAfterReplaceStringTool' && aiInfo._type !== 'onAfterApplyPatchTool' && aiInfo._type !== 'onBeforeApplyEdit' && aiInfo._type !== 'onAfterApplyEdit') {
            additionalRanges.push(new ExtendedRange(change.range.start, change.range.end, ExtendedRangeType.UserEdit, Date.now()));
        } else {
            let startPosition = change.range.start;
            const endPosition = document.positionAt(document.offsetAt(change.range.start) + change.text.length);

            const options = new ExtendedRangeOptions();
            try {
                if (aiInfo._type === 'onBeforeInsertEditTool' || aiInfo._type === 'onBeforeReplaceStringTool') {
                    if (!aiInfo.insertText || aiInfo.insertText.trim().length === 0) {
                        aiInfo.insertText = '';
                    }

                    if (!aiInfo.oldText) {
                        console.error(`AI insertText is set but oldText is not set, this is unexpected behavior for ${aiInfo._type}.`);
                        continue;
                    }

                    aiInfo.insertText = aiInfo.insertText.replaceAll("// ...existing code...", "").trim();

                    // calculate new range offsets
                    // TODO: could be more efficient
                    let useDefaultStartOffset = true;
                    let useDefaultEndOffset = true;
                    let startOffset = 0;
                    let endOffset = aiInfo.insertText.length;

                    while (aiInfo.oldText.indexOf(aiInfo.insertText.substring(0, startOffset + 1)) !== -1) {
                        startOffset++;
                        useDefaultStartOffset = false;
                        if (startOffset >= aiInfo.insertText.length) {
                            useDefaultStartOffset = true;
                            //console.error("AI insert text appears to have not changed, per startOffset");
                            break;
                        }
                    }
                    if (useDefaultStartOffset) {
                        startOffset = 0;
                    }

                    const offsetOldText = aiInfo.oldText.substring(aiInfo.oldText.indexOf(aiInfo.insertText.substring(0, startOffset)) + startOffset);
                    while (offsetOldText.lastIndexOf(aiInfo.insertText.substring(endOffset - 1), startOffset) !== -1) {
                        endOffset--;
                        useDefaultEndOffset = false;

                        if (endOffset <= 0) {
                            useDefaultEndOffset = true;
                            //console.error("AI insert text appears to have not changed, per endOffset");
                            break;
                        }
                    }
                    if (useDefaultEndOffset) {
                        endOffset = aiInfo.insertText.length;
                    }


                    mostRecentInternalCommand.document = document;
                    mostRecentInternalCommand.changes = [
                        {
                            range: new vscode.Range( // calculated to not delete anything (kind of)
                                document.positionAt(aiInfo.oldText.indexOf(aiInfo.insertText.substring(0, startOffset)) + startOffset),
                                document.positionAt(aiInfo.oldText.indexOf(aiInfo.insertText.substring(0, startOffset)) + startOffset),
                            ),
                            rangeOffset: 0, // unused
                            rangeLength: 0, // unused
                            text: aiInfo.insertText.substring(startOffset, endOffset),
                        }
                    ];
                    console.debug("Applied custom changes with string", aiInfo.insertText.substring(startOffset, endOffset));
                    continue;
                } else if (aiInfo._type === 'onBeforeApplyPatchTool' || aiInfo._type === 'onBeforeCreateFileTool') {
                    mostRecentInternalCommand.document = document; // TODO: verify this is what it was
                    mostRecentInternalCommand.changes = changes;
                    continue;
                }

                if (aiInfo.insertText && aiInfo.insertText.trim().includes(change.text.trim()) &&
                    (
                        aiInfo._timestamp > Date.now() - 2000 || (
                            aiInfo._type === "inlineCompletion" &&
                            aiInfo._timestamp > Date.now() - 300000 // 5 minutes
                        )
                    ) &&
                    (
                        aiInfo.range ? (
                            change.range.start.line === aiInfo.range[0].line &&
                            change.range.start.character === aiInfo.range[0].character
                        ) : (true)
                    )
                ) {
                    options.aiName = aiInfo._extensionName || 'unknown';
                    options.aiModel = aiInfo._modelId || '';
                    if (!options.aiModel && aiInfo.command && aiInfo.command.arguments && aiInfo.command.arguments.length > 0 && aiInfo.command.arguments[0].telemetry && aiInfo.command.arguments[0].telemetry.properties && aiInfo.command.arguments[0].telemetry.properties.engineName) {
                        options.aiModel = aiInfo.command.arguments[0].telemetry.properties.engineName;
                    }
                    options.aiExplanation = aiInfo._explanation || '';
                    options.aiType = aiInfo._type ? (typeMap[aiInfo._type] || aiInfo._type) : '';
                    isAI = true;

                    if (aiInfo._type === 'onAfterApplyEdit' || aiInfo._type === 'onAfterReplaceStringTool' || aiInfo._type === 'onAfterApplyPatchTool') { // use only once
                        clearMostRecentInternalCommandAtEnd = true;
                    }
                }
            } catch (error) {
                console.error("Error processing AI range:", error);
            }

            if (isAI) {
                additionalRanges.push(new ExtendedRange(startPosition, endPosition, ExtendedRangeType.AIGenerated, Date.now(), '', options));
            }
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
                    } else {
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
                    toUpdateRanges.splice(
                        i + 1,
                        0,
                        new ExtendedRange(change.range.start, updatedRange.end, updatedRange.getType(), updatedRange.getCreationTimestamp(), updatedRange.getAuthor(), updatedRange.getOptions())
                    );
                    toUpdateRanges[i] = new ExtendedRange(updatedRange.start, change.range.start, updatedRange.getType(), updatedRange.getCreationTimestamp(), updatedRange.getAuthor(), updatedRange.getOptions());
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

    if (clearMostRecentInternalCommandAtEnd) {
        mostRecentInternalCommand.value = { "_type": "initial" };
        mostRecentInternalCommand.document = null;
        mostRecentInternalCommand.changes = [];
    }

    return updatedRanges;
};

function checkRecentPaste(content: string) {
    try {
        const latestExtensionClipboard = getClipboardContentsFromBrowserExtension();
        if (latestExtensionClipboard && latestExtensionClipboard.text && latestExtensionClipboard.text.trim() === content) {
            latestClipboardData.type = 'clipboard_copy';
            latestClipboardData.text = latestExtensionClipboard.text;
            latestClipboardData.timestamp = latestExtensionClipboard.timestamp*1000 || Date.now();
            latestClipboardData.relativePath = undefined;
            latestClipboardData.workspacePath = undefined;
            latestClipboardData.url = latestExtensionClipboard.url;
            latestClipboardData.title = latestExtensionClipboard.title;
        }
    } catch (error) { }

    // Use the global clipboard data instead of reading from file
    if (!latestClipboardData) {
        return null;
    }

    // Check if the content matches and is recent (within 1 hour)
    if ((latestClipboardData.type === 'clipboard_copy' || latestClipboardData.type === 'ide_clipboard_copy') && 
        latestClipboardData.text.trim() === content && 
        latestClipboardData.timestamp > Date.now() - 3600000) { // 1 hour
        return latestClipboardData;
    }
    
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

export { getUpdatedRanges, getUpdatedPosition, mostRecentInternalCommand };