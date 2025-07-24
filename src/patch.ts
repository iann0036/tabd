import * as fs from 'fs/promises';
import * as fsSync from 'fs';
import * as path from 'path';
import * as os from 'os';
import { Parser, Language, Query } from 'web-tree-sitter';

class ExtensionMetadata {
    name: string;
    displayName: string;
    publisher: string;
    version?: string;

    constructor(data: any) {
        this.name = data.name || '';
        this.displayName = data.displayName || '';
        this.publisher = data.publisher || '';
        this.version = data.version || undefined;
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

function compareVersions(version1: string, version2: string): number {
    const v1parts = version1.split('.').map(Number);
    const v2parts = version2.split('.').map(Number);
    
    const maxLength = Math.max(v1parts.length, v2parts.length);
    
    for (let i = 0; i < maxLength; i++) {
        const v1part = v1parts[i] || 0;
        const v2part = v2parts[i] || 0;
        
        if (v1part > v2part) {
            return 1;
        }
        if (v1part < v2part) {
            return -1;
        }
    }
    
    return 0;
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

async function patchGitHubCopilotChat(filePath: string): Promise<void> {
    await Parser.init();
    const parser = new Parser();
    const JavaScript = await Language.load(path.join(__dirname, '..', 'node_modules', 'tree-sitter-javascript', 'tree-sitter-javascript.wasm'));
    parser.setLanguage(JavaScript);
    let sourceCode = await fs.readFile(filePath, 'utf8');
    const tree = parser.parse(sourceCode);

    let inserts = [];

    {
        // apply_patch tool
        const queryPattern = `
            (class_body
                member: (class_static_block
                    body: (statement_block
                        (expression_statement
                            (assignment_expression
                                left: (member_expression) @static_lhs
                                right: (string
                                    (string_fragment) @static_rhs
                                )
                            )
                            (#eq? @static_lhs "this.toolName")
                            (#eq? @static_rhs "apply_patch")
                        )
                    )
                )
                member: (method_definition
                    name: (property_identifier) @method_name
                    parameters: (formal_parameters
                        (identifier) @optionsarg
                        (identifier)
                    )
                    body: (statement_block
                        (try_statement
                            body: (statement_block
                                (for_in_statement
                                    left: (array_pattern
                                      (identifier) @arg2
                                      (identifier)
                                    )
                                    right: (identifier)
                                    body: (statement_block
                                        (if_statement
                                            alternative: (else_clause
                                                (statement_block
                                                    (lexical_declaration
                                                        (variable_declarator
                                                            name: (identifier) @arg1
                                                            value: (ternary_expression
                                                                
                                                            )
                                                        )
                                                    ) @on_before_after_this
                                                    (for_in_statement)
                                                ) @on_after_at_end_of_this
                                            )
                                        )
                                    )
                                )
                            )
                        )
                    )
                )
                (#eq? @method_name "invoke")
            ) @class
        `;
        if (!tree) {
            console.error('Failed to parse source code.');
            return;
        }
        
        const query = new Query(JavaScript, queryPattern);
        const matches = query.matches(tree.rootNode);
        for (const match of matches) {
            let index1 = 0;
            let index2 = 0;
            let arg1 = '';
            let arg2 = '';
            let optionsarg = '';

            for (const capture of match.captures) {
                const node = capture.node;
                const text = node.text || sourceCode.slice(node.startIndex, node.endIndex);
                if (capture.name === 'on_before_after_this') {
                    index1 = node.endIndex;
                }
                if (capture.name === 'on_after_at_end_of_this') {
                    index2 = node.endIndex - 1; // Adjust for the closing brace
                }
                if (capture.name === 'arg1') {
                    arg1 = text;
                }
                if (capture.name === 'arg2') {
                    arg2 = text;
                }
                if (capture.name === 'optionsarg') {
                    optionsarg = text;
                }
            }

            if (index1 === 0 || index2 === 0 || !arg1 || !arg2) {
                console.error('Failed to find required captures.');
                return;
            }

            inserts.push({
                contents: `/*tabd*/;require('vscode').commands.executeCommand("tabd._internal", JSON.stringify({
                    "insertText": ${arg1}.map(edit => edit.newText).join('\n'),
                    "filePath": ${arg2}.toString(),
                    "_extensionName": "GitHub Copilot Chat",
                    "_timestamp": new Date().getTime(),
                    "_modelId": ${optionsarg}.model?.id,
                    "_type": "onBeforeApplyPatchTool",
                }));/**/ `,
                offset: index1,
            });
            inserts.push({
                contents: `/*tabd*/,require('vscode').commands.executeCommand("tabd._internal", JSON.stringify({
                    "insertText": ${arg1}.map(edit => edit.newText).join('\n'),
                    "filePath": ${arg2}.toString(),
                    "_extensionName": "GitHub Copilot Chat",
                    "_timestamp": new Date().getTime(),
                    "_modelId": ${optionsarg}.model?.id,
                    "_type": "onAfterApplyPatchTool",
                }))/**/ `,
                offset: index2,
            });
        }
    }

    {
        // create_file tool
        const queryPattern = `
            (class_body
                member: (class_static_block
                    body: (statement_block
                        (expression_statement
                            (assignment_expression
                                left: (member_expression) @static_lhs
                                right: (string
                                    (string_fragment) @static_rhs
                                )
                            )
                            (#eq? @static_lhs "this.toolName")
                            (#eq? @static_rhs "create_file")
                        )
                    )
                )
                member: (method_definition
                    name: (property_identifier) @method_name
                    parameters: (formal_parameters
                        (identifier) @optionsarg
                        (identifier)
                    )
                    body: (statement_block
                        (if_statement
                            alternative: (else_clause
                                (statement_block
                                    (lexical_declaration
                                        (variable_declarator
                                            name: (identifier) @arg1
                                            value: (call_expression
                                                function: (identifier)
                                                arguments: (arguments
                                                    (member_expression
                                                        object: (member_expression
                                                            object: (identifier)
                                                            property: (property_identifier) @inputstr
                                                        )
                                                        property: (property_identifier) @contentstr
                                                    )
                                                    (member_expression
                                                        object: (identifier)
                                                        property: (property_identifier) @languageidstr
                                                    )
                                                    (member_expression
                                                        object: (member_expression
                                                            object: (identifier)
                                                            property: (property_identifier) @inputstr
                                                        )
                                                        property: (property_identifier) @filepathstr
                                                    )
                                                )
                                                (#eq? @inputstr "input")
                                                (#eq? @contentstr "content")
                                                (#eq? @filepathstr "filePath")
                                                (#eq? @languageidstr "languageId")
                                            )
                                        )
                                    )
                                    (return_statement
                                        (sequence_expression
                                            (await_expression)
                                            (call_expression)
                                            (new_expression) @on_after_before_this
                                        ) @on_before_before_this
                                    )
                                )
                            )
                        )
                    )
                )
                (#eq? @method_name "invoke")
            ) @class
        `;
        if (!tree) {
            console.error('Failed to parse source code.');
            return;
        }
        
        const query = new Query(JavaScript, queryPattern);
        const matches = query.matches(tree.rootNode);
        for (const match of matches) {
            let index1 = 0;
            let index2 = 0;
            let arg1 = '';
            let optionsarg = '';

            for (const capture of match.captures) {
                const node = capture.node;
                const text = node.text || sourceCode.slice(node.startIndex, node.endIndex);
                if (capture.name === 'on_before_before_this') {
                    index1 = node.startIndex;
                }
                if (capture.name === 'on_after_before_this') {
                    index2 = node.startIndex;
                }
                if (capture.name === 'arg1') {
                    arg1 = text;
                }
                if (capture.name === 'optionsarg') {
                    optionsarg = text;
                }
            }

            if (index1 === 0 || index2 === 0 || !arg1) {
                console.error('Failed to find required captures.');
                return;
            }

            inserts.push({
                contents: `/*tabd*/require('vscode').commands.executeCommand("tabd._internal", JSON.stringify({
                    "insertText": ${arg1},
                    "filePath": ${optionsarg}.input.filePath,
                    "_extensionName": "GitHub Copilot Chat",
                    "_timestamp": new Date().getTime(),
                    "_modelId": ${optionsarg}.model?.id,
                    "_type": "onBeforeCreateFileTool",
                })),/**/ `,
                offset: index1,
            });
            inserts.push({
                contents: `/*tabd*/require('vscode').commands.executeCommand("tabd._internal", JSON.stringify({
                    "insertText": ${arg1},
                    "filePath": ${optionsarg}.input.filePath,
                    "_extensionName": "GitHub Copilot Chat",
                    "_timestamp": new Date().getTime(),
                    "_modelId": ${optionsarg}.model?.id,
                    "_type": "onAfterCreateFileTool",
                })),/**/ `,
                offset: index2,
            });

            break;
        }
    }

    {
        // replace_string tool
        const queryPattern = `
            (class_body
                member: (class_static_block
                    body: (statement_block
                        (expression_statement
                            (assignment_expression
                                left: (member_expression) @static_lhs
                                right: (string
                                    (string_fragment) @static_rhs
                                )
                            )
                            (#eq? @static_lhs "this.toolName")
                            (#eq? @static_rhs "replace_string_in_file")
                        )
                    )
                )
                member: (method_definition
                    name: (property_identifier) @method_name
                    parameters: (formal_parameters
                        (identifier) @optionsarg
                        (identifier)
                    )
                    body: (statement_block
                        (if_statement
                            consequence: (statement_block
                                (lexical_declaration
                                    (variable_declarator
                                        name: (identifier) @arg3
                                        value: (call_expression)
                                    )
                                )
                                (try_statement
                                    body: (statement_block
                                        .
                                        (lexical_declaration
                                            (variable_declarator
                                                value: (await_expression
                                                    (call_expression
                                                        arguments: (arguments
                                                            (identifier)
                                                            (call_expression) @arg1
                                                            (call_expression) @arg2
                                                            (identifier)
                                                        )
                                                    )
                                                )
                                            )
                                        ) @on_before_before_this
                                        (if_statement
                                            condition: (parenthesized_expression
                                                (sequence_expression
                                                    (binary_expression) @on_after_before_this
                                                    .
                                                )
                                            )
                                        )
                                    )
                                )
                            )
                        )
                    )
                )
                (#eq? @method_name "invoke")
            ) @class
        `;
        if (!tree) {
            console.error('Failed to parse source code.');
            return;
        }
        
        const query = new Query(JavaScript, queryPattern);
        const matches = query.matches(tree.rootNode);
        for (const match of matches) {
            let index1 = 0;
            let index2 = 0;
            let arg1 = '';
            let arg2 = '';
            let arg3 = '';
            let optionsarg = '';

            for (const capture of match.captures) {
                const node = capture.node;
                const text = node.text || sourceCode.slice(node.startIndex, node.endIndex);
                if (capture.name === 'on_before_before_this') {
                    index1 = node.startIndex;
                }
                if (capture.name === 'on_after_before_this') {
                    index2 = node.startIndex;
                }
                if (capture.name === 'arg1') {
                    arg1 = text;
                }
                if (capture.name === 'arg2') {
                    arg2 = text;
                }
                if (capture.name === 'arg3') {
                    arg3 = text;
                }
                if (capture.name === 'optionsarg') {
                    optionsarg = text;
                }
            }

            if (index1 === 0 || index2 === 0 || !arg1 || !arg2) {
                console.error('Failed to find required captures.');
                return;
            }

            inserts.push({
                contents: `/*tabd*/;require('vscode').commands.executeCommand("tabd._internal", JSON.stringify({
                    "insertText": ${arg2},
                    "filePath": ${arg3},
                    "oldText": ${arg1},
                    "_extensionName": "GitHub Copilot Chat",
                    "_timestamp": new Date().getTime(),
                    "_modelId": ${optionsarg}.model?.id,
                    "_type": "onBeforeReplaceStringTool",
                }));/**/ `,
                offset: index1,
            });
            inserts.push({
                contents: `/*tabd*/require('vscode').commands.executeCommand("tabd._internal", JSON.stringify({
                    "insertText": ${arg2},
                    "filePath": ${arg3},
                    "oldText": ${arg1},
                    "_extensionName": "GitHub Copilot Chat",
                    "_timestamp": new Date().getTime(),
                    "_modelId": ${optionsarg}.model?.id,
                    "_type": "onAfterReplaceStringTool",
                })),/**/ `,
                offset: index2,
            });

            break;
        }
    }

    {
        // insert_edit tool
        const queryPattern = `
            (class_body
                member: (class_static_block
                    body: (statement_block
                        (expression_statement
                            (assignment_expression
                                left: (member_expression) @static_lhs
                                right: (string
                                    (string_fragment) @static_rhs
                                )
                            )
                            (#eq? @static_lhs "this.toolName")
                            (#eq? @static_rhs "insert_edit_into_file")
                        )
                    )
                )
                member: (method_definition
                    name: (property_identifier) @method_name
                    parameters: (formal_parameters
                        (identifier) @optionsarg
                        (identifier)
                    )
                    body: (statement_block
                        (expression_statement
                            (await_expression
                                (call_expression
                                    function: (member_expression
                                      object: (member_expression
                                        object: (this)
                                        property: (property_identifier) @toolsservicestr
                                      )
                                      property: (property_identifier) @invoketoolstr
                                    )
                                  (#eq? @toolsservicestr "toolsService")
                                  (#eq? @invoketoolstr "invokeTool")
                                )
                            )
                        ) @on_before_before_this @on_after_after_this
                    )
                )
                (#eq? @method_name "invoke")
            ) @class
        `;
        if (!tree) {
            console.error('Failed to parse source code.');
            return;
        }
        
        const query = new Query(JavaScript, queryPattern);
        const matches = query.matches(tree.rootNode);
        for (const match of matches) {
            let index1 = 0;
            let index2 = 0;
            let optionsarg = '';

            for (const capture of match.captures) {
                const node = capture.node;
                const text = node.text || sourceCode.slice(node.startIndex, node.endIndex);
                if (capture.name === 'on_before_before_this') {
                    index1 = node.startIndex;
                }
                if (capture.name === 'on_after_after_this') {
                    index2 = node.endIndex;
                }
                if (capture.name === 'optionsarg') {
                    optionsarg = text;
                }
            }

            if (index1 === 0 || index2 === 0) {
                console.error('Failed to find required captures.');
                return;
            }

            inserts.push({
                contents: `/*tabd*/;require('vscode').commands.executeCommand("tabd._internal", JSON.stringify({
                    "insertText": ${optionsarg}.input.code,
                    "oldText": require('fs').readFileSync(${optionsarg}.input.filePath, 'utf8'),
                    "filePath": ${optionsarg}.input.filePath,
                    "_extensionName": "GitHub Copilot Chat",
                    "_timestamp": new Date().getTime(),
                    "_modelId": ${optionsarg}.model?.id,
                    "_explanation": ${optionsarg}.input.explanation,
                    "_type": "onBeforeInsertEditTool",
                }));/**/ `,
                offset: index1,
            });
            inserts.push({
                contents: `/*tabd*/;require('vscode').commands.executeCommand("tabd._internal", JSON.stringify({
                    "insertText": ${optionsarg}.input.code,
                    "oldText": require('fs').readFileSync(${optionsarg}.input.filePath, 'utf8'),
                    "filePath": ${optionsarg}.input.filePath,
                    "_extensionName": "GitHub Copilot Chat",
                    "_timestamp": new Date().getTime(),
                    "_modelId": ${optionsarg}.model?.id,
                    "_explanation": ${optionsarg}.input.explanation,
                    "_type": "onAfterInsertEditTool",
                }));/**/ `,
                offset: index2,
            });
        }
    }

    if (inserts.length === 0) {
        console.log('No matches found for the query.');
        return;
    }

    // Sort inserts by offset in descending order to avoid index shifting issues
    inserts.sort((a, b) => b.offset - a.offset);

    // Trim newlines
    inserts.map(insert => { insert.contents = insert.contents.split("\n").map(s => s.trim()).join(' '); return insert; });

    // Apply the inserts to the source code
    for (const insert of inserts) {
        sourceCode = sourceCode.slice(0, insert.offset) + insert.contents + sourceCode.slice(insert.offset);
    }

    // Write the modified source code back to the file
    try {
        await fs.writeFile(filePath, sourceCode, 'utf8');
    } catch (error) {
        console.error(`Failed to write to file ${filePath}:`, error);
    }
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
        
        if (extensionMeta && extensionMeta.publisher.toLowerCase() === 'github' && extensionMeta.name.toLowerCase() === 'copilot-chat' && extensionMeta.version && compareVersions(extensionMeta.version, '0.30.0') >= 0 && filePath.endsWith('extension.js')) {
            // Special handling for GitHub Copilot Chat
            await patchGitHubCopilotChat(filePath);
            return; // TODO: allow continue with re-read in
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
