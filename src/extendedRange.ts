import * as vscode from 'vscode';

export enum ExtendedRangeType {
    Unknown = "UNKNOWN",
    UserEdit = "USER_EDIT",
    AIGenerated = "AI_GENERATED",
    UndoRedo = "UNDO_REDO",
    Paste = "PASTE",
    IDEPaste = "IDE_PASTE",
}

export class ExtendedRangeOptions {
	pasteUrl?: string;
	pasteTitle?: string;
	aiName?: string;
	aiModel?: string;
	aiExplanation?: string;
	aiType?: string;
}

export class ExtendedRange extends vscode.Range {
    private creationTimestamp: number;
    private rangeType: ExtendedRangeType;
    private author: string;
	private options: ExtendedRangeOptions;

    constructor(
        start: vscode.Position,
        end: vscode.Position,
        rangeType: ExtendedRangeType = ExtendedRangeType.Unknown,
        creationTimestamp: number = Date.now(),
        author: string = '',
		options: ExtendedRangeOptions = {},
    ) {
        super(start, end);
        this.rangeType = rangeType;
        this.creationTimestamp = creationTimestamp;
        this.author = author;
		this.options = options;
    }

    getType(): ExtendedRangeType {
        return this.rangeType;
    }

    getCreationTimestamp(): number {
        return this.creationTimestamp;
    }

    getAuthor(): string {
        return this.author;
    }

	getPasteUrl(): string {
		return this.options.pasteUrl || '';
	}

	getPasteTitle(): string {
		return this.options.pasteTitle || '';
	}

	getAiName(): string {
		return this.options.aiName || '';
	}

	getAiModel(): string {
		return this.options.aiModel || '';
	}

	getAiExplanation(): string {
		return this.options.aiExplanation || '';
	}

	getAiType(): string {
		return this.options.aiType || '';
	}

	setType(type: ExtendedRangeType): void {
		this.rangeType = type;
	}

	setCreationTimestamp(timestamp: number): void {
		this.creationTimestamp = timestamp;
	}

	setAuthor(author: string): void {
		this.author = author;
	}

	getOptions(): ExtendedRangeOptions {
		return this.options;
	}
}

function deduplicateRanges(ranges: ExtendedRange[]): ExtendedRange[] {
    const uniqueRanges: ExtendedRange[] = [];
    
    for (const range of ranges) {
        // Check if an identical range already exists
        const isDuplicate = uniqueRanges.some(existing => 
            existing.start.isEqual(range.start) &&
            existing.end.isEqual(range.end) &&
            existing.getType() === range.getType() &&
            existing.getCreationTimestamp() === range.getCreationTimestamp() &&
            existing.getAuthor() === range.getAuthor() &&
			existing.getPasteUrl() === range.getPasteUrl() &&
			existing.getPasteTitle() === range.getPasteTitle() &&
			existing.getAiName() === range.getAiName() &&
			existing.getAiModel() === range.getAiModel() &&
			existing.getAiExplanation() === range.getAiExplanation()
        );
        
        if (!isDuplicate) {
            uniqueRanges.push(range);
        }
    }
    
    return uniqueRanges;
}

export function mergeUserEdits(userEdits: ExtendedRange[]): ExtendedRange[] {
	// Filter only USER_EDIT ranges and sort by position
	const userEditRanges = userEdits
		.filter(range => range.getType() === ExtendedRangeType.UserEdit)
		.sort((a, b) => {
			if (a.start.line !== b.start.line) {
				return a.start.line - b.start.line;
			}
			return a.start.character - b.start.character;
		});

	if (userEditRanges.length <= 1) {
		return userEdits; // Nothing to merge
	}

	const mergedRanges: ExtendedRange[] = [];
	const nonUserEdits = userEdits.filter(range => range.getType() !== ExtendedRangeType.UserEdit);
	
	let currentGroup: ExtendedRange[] = [userEditRanges[0]];

	for (let i = 1; i < userEditRanges.length; i++) {
		const current = userEditRanges[i];
		const previous = currentGroup[currentGroup.length - 1];

		// Check if ranges are adjacent (previous.end equals current.start)
		const areAdjacent = previous.end.isEqual(current.start);
		
		// Check if timestamp difference is less than 60 seconds (60000 ms)
		const timeDiff = Math.abs(current.getCreationTimestamp() - previous.getCreationTimestamp());
		const withinTimeLimit = timeDiff < 60000;

		if (areAdjacent && withinTimeLimit) {
			// Add to current group
			currentGroup.push(current);
		} else {
			// Process current group and start a new one
			if (currentGroup.length > 1) {
				// Merge the group
				const earliestTimestamp = Math.min(...currentGroup.map(r => r.getCreationTimestamp()));
				const mergedRange = new ExtendedRange(
					currentGroup[0].start,
					currentGroup[currentGroup.length - 1].end,
					ExtendedRangeType.UserEdit,
					earliestTimestamp,
					currentGroup[0].getAuthor(),
					currentGroup[0].getOptions()
				);
				mergedRanges.push(mergedRange);
			} else {
				// Single range, add as is
				mergedRanges.push(currentGroup[0]);
			}
			
			// Start new group
			currentGroup = [current];
		}
	}

	// Process the last group
	if (currentGroup.length > 1) {
		const earliestTimestamp = Math.min(...currentGroup.map(r => r.getCreationTimestamp()));
		const mergedRange = new ExtendedRange(
			currentGroup[0].start,
			currentGroup[currentGroup.length - 1].end,
			ExtendedRangeType.UserEdit,
			earliestTimestamp,
			currentGroup[0].getAuthor(),
			currentGroup[0].getOptions()
		);
		mergedRanges.push(mergedRange);
	} else if (currentGroup.length === 1) {
		mergedRanges.push(currentGroup[0]);
	}

	// Return all ranges (merged user edits + non-user edits)
	return [...mergedRanges, ...nonUserEdits];
}

export function mergeRangesSequentially(existingRanges: ExtendedRange[], newRanges: ExtendedRange[]): ExtendedRange[] {
	// Start with existing ranges
	let mergedRanges: ExtendedRange[] = [...existingRanges];
	
	// Process each new range
	for (const newRange of newRanges) {
		const rangesToProcess: ExtendedRange[] = [];
		const indicesToRemove: number[] = [];
		
		// Find all ranges that overlap with the new range
		for (let i = 0; i < mergedRanges.length; i++) {
			const existingRange = mergedRanges[i];
			
			// Check if ranges overlap
			if (existingRange.start.isBefore(newRange.end) && newRange.start.isBefore(existingRange.end)) {
				rangesToProcess.push(existingRange);
				indicesToRemove.push(i);
			}
		}
		
		// Remove overlapping ranges (in reverse order to maintain indices)
		for (let i = indicesToRemove.length - 1; i >= 0; i--) {
			mergedRanges.splice(indicesToRemove[i], 1);
		}
		
		if (rangesToProcess.length === 0) {
			// No overlap, just add the new range
			mergedRanges.push(newRange);
		} else {
			// Collect all resulting ranges from processing overlaps
			const resultingRanges: ExtendedRange[] = [];
			let shouldAddNewRange = true;
			
			// Handle overlaps based on timestamps
			for (const existingRange of rangesToProcess) {
				if (newRange.getCreationTimestamp() > existingRange.getCreationTimestamp()) {
					// New range is newer, so it takes precedence
					// Check if we need to split the existing range
					
					// If new range is completely contained within existing range, split the existing range
					if (existingRange.start.isBefore(newRange.start) && newRange.end.isBefore(existingRange.end)) {
						// Split into two parts: before and after the new range
						const beforeRange = new ExtendedRange(
							existingRange.start,
							newRange.start,
							existingRange.getType(),
							existingRange.getCreationTimestamp(),
							existingRange.getAuthor(),
							existingRange.getOptions(),
						);
						const afterRange = new ExtendedRange(
							newRange.end,
							existingRange.end,
							existingRange.getType(),
							existingRange.getCreationTimestamp(),
							existingRange.getAuthor(),
							existingRange.getOptions(),
						);
						
						// Only add non-empty ranges
						if (!beforeRange.start.isEqual(beforeRange.end)) {
							resultingRanges.push(beforeRange);
						}
						if (!afterRange.start.isEqual(afterRange.end)) {
							resultingRanges.push(afterRange);
						}
					}
					// If existing range partially overlaps with new range, keep the non-overlapping parts
					else {
						// Keep the part before the new range starts
						if (existingRange.start.isBefore(newRange.start)) {
							const beforeRange = new ExtendedRange(
								existingRange.start,
								newRange.start,
								existingRange.getType(),
								existingRange.getCreationTimestamp(),
								existingRange.getAuthor(),
								existingRange.getOptions(),
							);
							if (!beforeRange.start.isEqual(beforeRange.end)) {
								resultingRanges.push(beforeRange);
							}
						}
						
						// Keep the part after the new range ends
						if (newRange.end.isBefore(existingRange.end)) {
							const afterRange = new ExtendedRange(
								newRange.end,
								existingRange.end,
								existingRange.getType(),
								existingRange.getCreationTimestamp(),
								existingRange.getAuthor(),
								existingRange.getOptions(),
							);
							if (!afterRange.start.isEqual(afterRange.end)) {
								resultingRanges.push(afterRange);
							}
						}
					}
				} else {
					// Existing range is newer, so it takes precedence
					shouldAddNewRange = false;
					
					// If existing range is completely contained within new range, split the new range
					if (newRange.start.isBefore(existingRange.start) && existingRange.end.isBefore(newRange.end)) {
						// Split into two parts: before and after the existing range
						const beforeRange = new ExtendedRange(
							newRange.start,
							existingRange.start,
							newRange.getType(),
							newRange.getCreationTimestamp(),
							newRange.getAuthor(),
							newRange.getOptions(),
						);
						const afterRange = new ExtendedRange(
							existingRange.end,
							newRange.end,
							newRange.getType(),
							newRange.getCreationTimestamp(),
							newRange.getAuthor(),
							newRange.getOptions(),
						);
						
						// Only add non-empty ranges
						if (!beforeRange.start.isEqual(beforeRange.end)) {
							resultingRanges.push(beforeRange);
						}
						if (!afterRange.start.isEqual(afterRange.end)) {
							resultingRanges.push(afterRange);
						}
					}
					// If new range partially overlaps with existing range, keep the non-overlapping parts
					else {
						// Keep the part of new range before the existing range starts
						if (newRange.start.isBefore(existingRange.start)) {
							const beforeRange = new ExtendedRange(
								newRange.start,
								existingRange.start,
								newRange.getType(),
								newRange.getCreationTimestamp(),
								newRange.getAuthor(),
								newRange.getOptions(),
							);
							if (!beforeRange.start.isEqual(beforeRange.end)) {
								resultingRanges.push(beforeRange);
							}
						}
						
						// Keep the part of new range after the existing range ends
						if (existingRange.end.isBefore(newRange.end)) {
							const afterRange = new ExtendedRange(
								existingRange.end,
								newRange.end,
								newRange.getType(),
								newRange.getCreationTimestamp(),
								newRange.getAuthor(),
								newRange.getOptions(),
							);
							if (!afterRange.start.isEqual(afterRange.end)) {
								resultingRanges.push(afterRange);
							}
						}
					}
					
					// Always keep the existing range since it's newer
					resultingRanges.push(existingRange);
				}
			}
			
			// Add all resulting ranges to merged ranges
			mergedRanges.push(...resultingRanges);
			
			// Add the new range if it wasn't superseded by any existing range
			if (shouldAddNewRange) {
				mergedRanges.push(newRange);
			}
		}
	}
	
	// Remove duplicates and sort the final ranges by position
	const uniqueRanges = deduplicateRanges(mergedRanges);
	uniqueRanges.sort((a, b) => {
		if (a.start.line !== b.start.line) {
			return a.start.line - b.start.line;
		}
		return a.start.character - b.start.character;
	});
	
	return uniqueRanges;
}