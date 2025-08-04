import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execSync } from 'child_process';
import { ClipboardData } from './types';

async function createWindowsRegistryEntry(hostName: string, manifestPath: string, browser: string): Promise<void> {
    // Registry paths for different browsers
    const registryPaths: Record<string, string> = {
        'Chrome': 'HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts',
        'Chromium': 'HKCU\\Software\\Chromium\\NativeMessagingHosts',
        'Edge': 'HKCU\\Software\\Microsoft\\Edge\\NativeMessagingHosts',
        'Vivaldi': 'HKCU\\Software\\Vivaldi\\NativeMessagingHosts'
    };

    const registryPath = registryPaths[browser];
    if (!registryPath) {
        console.warn(`No registry path defined for browser: ${browser}`);
        return;
    }

    const fullRegistryPath = `${registryPath}\\${hostName}`;

    try {
        // Create the registry key and set the default value to the manifest path
        // Use REG ADD command to create the registry entry
        const regCommand = `reg add "${fullRegistryPath}" /ve /t REG_SZ /d "${manifestPath}" /f`;
        
        execSync(regCommand, {
            encoding: 'utf8',
            timeout: 10000,
        });

        console.debug(`Created registry entry for ${browser}: ${fullRegistryPath} -> ${manifestPath}`);
    } catch (error) {
        throw new Error(`Failed to create registry entry for ${browser}: ${error instanceof Error ? error.message : String(error)}`);
    }
}

export async function installNativeHost(): Promise<void> {
    const extensionContext = vscode.extensions.getExtension('iann0036.tabd');
    if (!extensionContext) {
        throw new Error('Extension context not found');
    }

    const extensionPath = extensionContext.extensionPath;
    const platform = os.platform();
    const arch = os.arch();

    // Determine the correct binary name
    let binaryName: string;
    if (platform === 'darwin') {
        binaryName = arch === 'arm64' ? 'tabd-native-host-darwin-arm64' : 'tabd-native-host-darwin-amd64';
    } else if (platform === 'linux') {
        if (arch === 'x64') {
            binaryName = 'tabd-native-host-linux-amd64';
        } else if (arch === 'arm64') {
            binaryName = 'tabd-native-host-linux-arm64';
        } else if (arch === 'arm') {
            binaryName = 'tabd-native-host-linux-arm';
        } else if (arch === 'ia32') {
            binaryName = 'tabd-native-host-linux-386';
        } else {
            throw new Error(`Unsupported Linux architecture: ${arch}`);
        }
    } else if (platform === 'win32') {
        if (arch === 'x64') {
            binaryName = 'tabd-native-host-windows-amd64.exe';
        } else if (arch === 'arm64') {
            binaryName = 'tabd-native-host-windows-arm64.exe';
        } else if (arch === 'ia32') {
            binaryName = 'tabd-native-host-windows-386.exe';
        } else {
            throw new Error(`Unsupported Windows architecture: ${arch}`);
        }
    } else if (platform === 'freebsd') {
        binaryName = arch === 'x64' ? 'tabd-native-host-freebsd-amd64' : 'tabd-native-host-freebsd-386';
    } else if (platform === 'netbsd') {
        binaryName = arch === 'x64' ? 'tabd-native-host-netbsd-amd64' : 'tabd-native-host-netbsd-386';
    } else if (platform === 'openbsd') {
        binaryName = arch === 'x64' ? 'tabd-native-host-openbsd-amd64' : 'tabd-native-host-openbsd-386';
    } else {
        throw new Error(`Unsupported operating system: ${platform}`);
    }

    const sourceBinaryPath = path.join(extensionPath, 'assets', 'nativehost', binaryName);
    
    // Check if source binary exists
    if (!fs.existsSync(sourceBinaryPath)) {
        throw new Error(`Binary not found: ${sourceBinaryPath}`);
    }

    const hostName = 'com.iann0036.tabd';

    // Determine the correct directories for native messaging hosts
    let nativeMessagingDirs: { dir: string; browser: string }[];

    if (platform === 'darwin') {
        // macOS
        nativeMessagingDirs = [
            { dir: path.join(os.homedir(), 'Library/Application Support/Google/Chrome/NativeMessagingHosts'), browser: 'Chrome' },
            { dir: path.join(os.homedir(), 'Library/Application Support/Chromium/NativeMessagingHosts'), browser: 'Chromium' },
            { dir: path.join(os.homedir(), 'Library/Application Support/Microsoft Edge/NativeMessagingHosts'), browser: 'Edge' },
            { dir: path.join(os.homedir(), 'Library/Application Support/Vivaldi/NativeMessagingHosts'), browser: 'Vivaldi' }
        ];
    } else if (platform === 'linux' || platform === 'freebsd' || platform === 'netbsd' || platform === 'openbsd') {
        // Linux and BSD systems
        nativeMessagingDirs = [
            { dir: path.join(os.homedir(), '.config/google-chrome/NativeMessagingHosts'), browser: 'Chrome' },
            { dir: path.join(os.homedir(), '.config/chromium/NativeMessagingHosts'), browser: 'Chromium' },
            { dir: path.join(os.homedir(), '.config/microsoft-edge/NativeMessagingHosts'), browser: 'Edge' },
            { dir: path.join(os.homedir(), '.config/vivaldi/NativeMessagingHosts'), browser: 'Vivaldi' }
        ];
    } else if (platform === 'win32') {
        // Windows
        nativeMessagingDirs = [
            { dir: path.join(os.homedir(), 'AppData/Local/Google/Chrome/User Data/NativeMessagingHosts'), browser: 'Chrome' },
            { dir: path.join(os.homedir(), 'AppData/Local/Chromium/User Data/NativeMessagingHosts'), browser: 'Chromium' },
            { dir: path.join(os.homedir(), 'AppData/Local/Microsoft/Edge/User Data/NativeMessagingHosts'), browser: 'Edge' },
            { dir: path.join(os.homedir(), 'AppData/Local/Vivaldi/User Data/NativeMessagingHosts'), browser: 'Vivaldi' }
        ];
    } else {
        throw new Error(`Unsupported operating system: ${platform}`);
    }

    // Use the source binary path directly instead of copying
    const targetBinaryPath = sourceBinaryPath;

    // Set executable permissions on Unix-like systems
    if (platform !== 'win32') {
        try {
            fs.chmodSync(targetBinaryPath, '755');
        } catch (error) {
            // Ignore permission errors since the binary might already have correct permissions
            console.warn(`Could not set executable permissions on ${targetBinaryPath}:`, error);
        }
    }

    // Create native messaging host manifest
    const manifestContent = {
        name: hostName,
        description: 'Browser helper for Tab\'d extension',
        path: targetBinaryPath,
        type: 'stdio',
        allowed_origins: [
            'chrome-extension://lemjjpeploikbpmkodmmkdjcjodboidn/'
        ]
    };

    // Install manifest for different browsers
    const installedBrowsers: string[] = [];
    for (const { dir, browser } of nativeMessagingDirs) {
        try {
            // Create directory if it doesn't exist
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }

            // Write manifest file
            const manifestPath = path.join(dir, `${hostName}.json`);
            fs.writeFileSync(manifestPath, JSON.stringify(manifestContent, null, 2));

            // On Windows, also create registry entries for Chrome-based browsers
            if (platform === 'win32') {
                try {
                    await createWindowsRegistryEntry(hostName, manifestPath, browser);
                } catch (regError) {
                    console.warn(`Failed to create registry entry for ${browser}:`, regError);
                }
            }

            installedBrowsers.push(browser);
        } catch (error) {
            console.warn(`Failed to install manifest for ${browser}:`, error);
        }
    }

    if (installedBrowsers.length > 0) {
        vscode.window.showInformationMessage(
            `Browser helper installed successfully for: ${installedBrowsers.join(', ')}`
        );
    } else {
        vscode.window.showWarningMessage(
            'Browser helper was installed, but no browser manifests could be created. You may need to manually configure browser permissions.'
        );
    }
}

function getNativeBinaryPath(): string {
    const extensionContext = vscode.extensions.getExtension('iann0036.tabd');
    if (!extensionContext) {
        throw new Error('Extension context not found');
    }

    const extensionPath = extensionContext.extensionPath;
    const platform = os.platform();
    const arch = os.arch();

    // Determine the correct binary name
    let binaryName: string;
    if (platform === 'darwin') {
        binaryName = arch === 'arm64' ? 'tabd-native-host-darwin-arm64' : 'tabd-native-host-darwin-amd64';
    } else if (platform === 'linux') {
        if (arch === 'x64') {
            binaryName = 'tabd-native-host-linux-amd64';
        } else if (arch === 'arm64') {
            binaryName = 'tabd-native-host-linux-arm64';
        } else if (arch === 'arm') {
            binaryName = 'tabd-native-host-linux-arm';
        } else if (arch === 'ia32') {
            binaryName = 'tabd-native-host-linux-386';
        } else {
            throw new Error(`Unsupported Linux architecture: ${arch}`);
        }
    } else if (platform === 'win32') {
        if (arch === 'x64') {
            binaryName = 'tabd-native-host-windows-amd64.exe';
        } else if (arch === 'arm64') {
            binaryName = 'tabd-native-host-windows-arm64.exe';
        } else if (arch === 'ia32') {
            binaryName = 'tabd-native-host-windows-386.exe';
        } else {
            throw new Error(`Unsupported Windows architecture: ${arch}`);
        }
    } else if (platform === 'freebsd') {
        binaryName = arch === 'x64' ? 'tabd-native-host-freebsd-amd64' : 'tabd-native-host-freebsd-386';
    } else if (platform === 'netbsd') {
        binaryName = arch === 'x64' ? 'tabd-native-host-netbsd-amd64' : 'tabd-native-host-netbsd-386';
    } else if (platform === 'openbsd') {
        binaryName = arch === 'x64' ? 'tabd-native-host-openbsd-amd64' : 'tabd-native-host-openbsd-386';
    } else {
        throw new Error(`Unsupported operating system: ${platform}`);
    }

    return path.join(extensionPath, 'assets', 'nativehost', binaryName);
}

export function getClipboardContentsFromBrowserExtension(): ClipboardData {
    const binaryPath = getNativeBinaryPath();
    
    // Check if binary exists
    if (!fs.existsSync(binaryPath)) {
        throw new Error(`Native binary not found at: ${binaryPath}. Please install the browser helper first.`);
    }

    try {
        const result = execSync(`"${binaryPath}" getclipboard`, {
            encoding: 'utf8',
            timeout: 10000,
        });

        // Parse the JSON response
        return JSON.parse(result.trim());
    } catch (error) {
        if (error instanceof Error) {
            throw new Error(`Failed to get clipboard contents: ${error.message}`);
        } else {
            throw new Error(`Failed to get clipboard contents: ${String(error)}`);
        }
    }
}
