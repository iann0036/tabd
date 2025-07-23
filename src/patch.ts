import * as fs from 'fs/promises';
import * as fsSync from 'fs';
import * as path from 'path';
import * as os from 'os';

class ExtensionMetadata {
    name: string;
    displayName: string;
    publisher: string;

    constructor(data: any) {
        this.name = data.name || '';
        this.displayName = data.displayName || '';
        this.publisher = data.publisher || '';
    }
    
    getDisplayName(): string {
        return this.displayName || this.name;
    }
}

async function getExtensionMetadata(extensionDir: string): Promise<ExtensionMetadata> {
    const packageJsonPath = path.join(extensionDir, 'package.json');

    // Check if package.json exists
    try {
        await fs.access(packageJsonPath);
    } catch (err) {
        throw new Error(`package.json not found in ${extensionDir}`);
    }

    try {
        // Read and parse package.json
        const content = await fs.readFile(packageJsonPath, 'utf8');
        const data = JSON.parse(content);
        return new ExtensionMetadata(data);
    } catch (err) {
        const errorMessage = err instanceof Error ? err.message : 'Unknown error';
        throw new Error(`failed to read or parse package.json: ${errorMessage}`);
    }
}

function getVSCodeExtensionsPath(): string {
    const homeDir = os.homedir();
    const platform = os.platform();

    switch (platform) {
        case 'win32':
            return path.join(homeDir, '.vscode', 'extensions');
        case 'darwin':
            return path.join(homeDir, '.vscode', 'extensions');
        case 'linux':
            return path.join(homeDir, '.vscode', 'extensions');
        default:
            throw new Error(`unsupported operating system: ${platform}`);
    }
}

function isSupportedFile(filename: string): boolean {
    const ext = path.extname(filename).toLowerCase();
    return ['.js', '.ts', '.mjs', '.cjs', '.jsx', '.tsx'].includes(ext);
}

function extractFirstVariableFromParams(params: string): string {
    // Split by comma and take the first parameter
    const parts = params.split(',');
    if (parts.length === 0) {
        throw new Error('no parameters found');
    }

    // Clean up the first parameter (remove whitespace)
    const firstParam = parts[0].trim();

    // Extract variable name using regex
    const pattern = /^([a-zA-Z_$][a-zA-Z0-9_$]*)/;
    const matches = firstParam.match(pattern);

    if (!matches || matches.length < 2) {
        throw new Error(`could not extract variable name from parameter: ${firstParam}`);
    }

    return matches[1];
}

async function patchFile(filePath: string, extensionMeta: ExtensionMetadata | null): Promise<void> {
    try {
        const content = await fs.readFile(filePath, 'utf8');
        const originalContent = content;

        // Check if patch is already present
        if (originalContent.includes('/*tabd*/')) {
            //console.debug(`Patch already exists in ${filePath}, skipping`);
            return;
        }

        // Pattern to find the function call with opening brace - handle minified code
        const functionPattern = /(?:handleDidPartiallyAcceptCompletionItem|handleDidShowCompletionItem)\s*\(([^)]*)\)\s*\{/g;

        // Find all matches with their positions
        const matches = [];
        let match;
        while ((match = functionPattern.exec(originalContent)) !== null) {
            matches.push({
                fullMatch: match[0],
                params: match[1],
                start: match.index,
                end: match.index + match[0].length
            });
        }

        if (matches.length === 0) {
            return; // No matches found
        }

        let newContent = originalContent;
        let patchCount = 0;

        // Process matches from end to beginning to avoid position shifts
        for (let i = matches.length - 1; i >= 0; i--) {
            const matchInfo = matches[i];

            // Skip if already patched (check if patch code is in the immediate vicinity)
            const contextStart = matchInfo.start;
            const contextEnd = Math.min(matchInfo.end + 200, originalContent.length);
            const context = originalContent.slice(contextStart, contextEnd);
            
            if (context.includes('/*tabd*/')) {
                console.log(`Function already patched in ${filePath}, skipping`);
                continue;
            }

            // Extract the first variable from the parameters
            let firstVar: string;
            try {
                firstVar = extractFirstVariableFromParams(matchInfo.params);
            } catch (err) {
                const errorMessage = err instanceof Error ? err.message : 'Unknown error';
                console.debug(`Warning: Could not extract variable from parameters '${matchInfo.params}' in ${filePath}: ${errorMessage}`);
                continue;
            }

            // Create the patch code with error handling and fallbacks
            let extensionName = 'unknown';
            if (extensionMeta) {
                // Escape single quotes in extension name to prevent JavaScript syntax errors
                extensionName = extensionMeta.getDisplayName().replace(/'/g, "\\'");
            }

            // Create an enhanced data object that includes both the original data and extension metadata
            const patchCode = `/*tabd*/try{require('vscode').commands.executeCommand('tabd._internal',JSON.stringify({...${firstVar},'_extensionName':'${extensionName}','_timestamp':new Date().getTime(),'_type':'inlineCompletion'}));}catch(e){}`;

            // Find the opening brace position within the match
            const bracePos = matchInfo.fullMatch.indexOf('{');
            if (bracePos === -1) {
                continue;
            }

            // Create the patched version
            const beforeBrace = matchInfo.fullMatch.slice(0, bracePos + 1);
            const afterBrace = matchInfo.fullMatch.slice(bracePos + 1);
            const patchedMatch = beforeBrace + patchCode + afterBrace;

            // Replace in the content using position-based replacement
            newContent = newContent.slice(0, matchInfo.start) + patchedMatch + newContent.slice(matchInfo.end);
            patchCount++;
        }

        if (patchCount > 0) {
            console.debug(`Patched ${patchCount} function(s) in ${filePath}`);
            await fs.writeFile(filePath, newContent, 'utf8');
        }
    } catch (err) {
        const errorMessage = err instanceof Error ? err.message : 'Unknown error';
        throw new Error(`failed to process file ${filePath}: ${errorMessage}`);
    }
}

async function walkDirectory(dir: string, callback: (filePath: string) => Promise<void>): Promise<void> {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    
    for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        
        if (entry.isDirectory()) {
            try {
                await walkDirectory(fullPath, callback);
            } catch (err) {
                const errorMessage = err instanceof Error ? err.message : 'Unknown error';
                console.debug(`Warning: Error walking directory ${fullPath}: ${errorMessage}`);
            }
        } else if (entry.isFile()) {
            try {
                await callback(fullPath);
            } catch (err) {
                const errorMessage = err instanceof Error ? err.message : 'Unknown error';
                console.debug(`Warning: Error processing file ${fullPath}: ${errorMessage}`);
            }
        }
    }
}

async function walkExtensions(extensionsPath: string): Promise<void> {
    try {
        const entries = await fs.readdir(extensionsPath, { withFileTypes: true });
        
        for (const entry of entries) {
            if (!entry.isDirectory()) {
                continue;
            }

            const extensionDir = path.join(extensionsPath, entry.name);

            // Try to get extension metadata
            let extensionMeta: ExtensionMetadata | null = null;
            try {
                extensionMeta = await getExtensionMetadata(extensionDir);
            } catch (err) {
                // If we can't get metadata, still try to patch files but with null metadata
                const errorMessage = err instanceof Error ? err.message : 'Unknown error';
                console.debug(`Warning: Could not read extension metadata for ${entry.name}: ${errorMessage}`);
            }

            // Walk through all files in this extension directory
            await walkDirectory(extensionDir, async (filePath: string) => {
                // Check if this is a supported file type
                if (!isSupportedFile(filePath)) {
                    return;
                }

                // Process the file with extension metadata
                try {
                    await patchFile(filePath, extensionMeta);
                } catch (err) {
                    const errorMessage = err instanceof Error ? err.message : 'Unknown error';
                    console.warn(`Warning: Error processing ${filePath}: ${errorMessage}`);
                }
            });
        }
    } catch (err) {
        const errorMessage = err instanceof Error ? err.message : 'Unknown error';
        throw new Error(`failed to read extensions directory: ${errorMessage}`);
    }
}

export async function patchExtensions(): Promise<void> {
    try {
        // Get the VS Code extensions path
        const extensionsPath = getVSCodeExtensionsPath();

        // Check if the extensions directory exists
        try {
            await fs.access(extensionsPath);
        } catch (err) {
            console.debug(`Error: VS Code extensions directory does not exist: ${extensionsPath}`);
        }

        // Walk through all extensions and patch files
        await walkExtensions(extensionsPath);
    } catch (err) {
        const errorMessage = err instanceof Error ? err.message : 'Unknown error';
        console.debug(`Error: ${errorMessage}`);
    }
}
