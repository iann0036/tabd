import { URI } from "vscode-uri";
import * as fs from "fs";
import * as path from "path";

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