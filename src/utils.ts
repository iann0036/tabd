import { URI } from "vscode-uri";
import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";

export const isWin = process.platform.startsWith("win");

export function fsPath(uri: URI, { useRealCasing = false }: { useRealCasing?: boolean; } = {}): string {
	// tslint:disable-next-line:disallow-fspath
	let newPath = typeof uri === "string" ? uri : uri.fsPath;

	if (useRealCasing) {
		const realPath = fs.existsSync(newPath) && fs.realpathSync.native(newPath);
		// Since realpathSync.native will resolve symlinks, only do anything if the paths differ
		// _only_ by case.
		// when there was no symlink (eg. the lowercase version of both paths match).
		if (realPath && realPath.toLowerCase() === newPath.toLowerCase() && realPath !== newPath) {
			console.warn(`Rewriting path:\n  ${newPath}\nto:\n  ${realPath} because the casing appears incorrect`);
			newPath = realPath;
		}
	}

	newPath = forceWindowsDriveLetterToUppercase(newPath);

	return newPath;
}

function forceWindowsDriveLetterToUppercase<T extends string | undefined>(p: T): string | (undefined extends T ? undefined : never) {
	if (typeof p !== "string") {
		return undefined as (undefined extends T ? undefined : never);
	}

	if (p && isWin && path.isAbsolute(p) && p.startsWith(p.charAt(0).toLowerCase())) {
		return p.substr(0, 1).toUpperCase() + p.substr(1);
	}

	return p;
}

function makeid(length: number): string {
    var result           = '';
    var characters       = 'abcdefghijklmnopqrstuvwxyz0123456789';
    var charactersLength = characters.length;
    for ( var i = 0; i < length; i++ ) {
        result += characters.charAt(Math.floor(Math.random() * charactersLength));
    }
    return result;
}

function getCurrentDateTimeReverse() {
	const now = new Date();

	// Get date components
	const year = now.getFullYear();
	const month = String(now.getMonth() + 1).padStart(2, '0'); // Months are 0-indexed
	const day = String(now.getDate()).padStart(2, '0');

	// Get time components
	const hours = String(now.getHours()).padStart(2, '0');
	const minutes = String(now.getMinutes()).padStart(2, '0');
	const seconds = String(now.getSeconds()).padStart(2, '0');

	// Combine into the desired format
	return `${year}${month}${day}${hours}${minutes}${seconds}`;
}

export function uniqueFileName(): string {
	const dateTime = getCurrentDateTimeReverse();
	const randomId = makeid(6);
	const fileName = `${dateTime}-${randomId}.json`;
	
	return fileName;
}

export function shouldProcessFile(uri: URI): boolean {
	const relativePath = vscode.workspace.asRelativePath(uri, false);
	const parsedPath = path.parse(relativePath);
	
	// Check if the file itself starts with a dot
	if (parsedPath.name.startsWith('.')) {
		return false;
	}
	
	// Check if any directory in the path starts with a dot
	const pathParts = parsedPath.dir.split(path.sep);
	for (const part of pathParts) {
		if (part.startsWith('.') && part !== '') {
			return false;
		}
	}
	
	return true;
}