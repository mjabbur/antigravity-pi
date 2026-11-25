import {
	closeSync,
	constants,
	existsSync,
	fstatSync,
	lstatSync,
	mkdirSync,
	openSync,
	readSync,
	realpathSync,
	statSync,
} from "node:fs";
import os from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";

/**
 * Resolves a cache subdirectory for agy-pi, honoring an absolute environment variable override when non-empty.
 */
export function getAgyPiCacheSubdir(envVar: string, subdir: string): string {
	const override = process.env[envVar];
	if (override !== undefined && override.length > 0) {
		if (!isAbsolute(override)) {
			throw new Error(`Environment variable ${envVar} must be an absolute path, got "${override}".`);
		}
		return resolve(override);
	}
	const xdgCacheHome = process.env.XDG_CACHE_HOME;
	if (xdgCacheHome !== undefined && xdgCacheHome.length > 0 && !isAbsolute(xdgCacheHome)) {
		throw new Error(
			`Environment variable XDG_CACHE_HOME must be an absolute path, got "${xdgCacheHome}".`,
		);
	}
	const cacheHome =
		xdgCacheHome && xdgCacheHome.length > 0 ? resolve(xdgCacheHome) : join(os.homedir(), ".cache");
	return join(cacheHome, "agy-pi", subdir);
}

/**
 * Creates a directory recursively with private (0o700) permissions.
 */
export function ensurePrivateDir(dirPath: string): void {
	mkdirSync(dirPath, { recursive: true, mode: 0o700 });
}

/**
 * Returns true if targetPath is strictly contained inside parentDir.
 */
export function isPathInsideDir(targetPath: string, parentDir: string): boolean {
	const rel = relative(parentDir, targetPath);
	return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

/**
 * Resolves a path via realpathSync, falling back to path.resolve if the target does not exist yet.
 */
export function safeRealpath(targetPath: string): string {
	try {
		return realpathSync(targetPath);
	} catch {
		return resolve(targetPath);
	}
}

function readFdBounded(fd: number, maxBytes: number, stopOnNewline: boolean): Buffer | undefined {
	const fdStat = fstatSync(fd);
	if (!fdStat.isFile() || (!stopOnNewline && fdStat.size > maxBytes)) {
		return undefined;
	}
	const limit = stopOnNewline ? maxBytes : maxBytes + 1;
	const buffer = Buffer.allocUnsafe(limit);
	let bytesRead = 0;
	while (bytesRead < buffer.length) {
		const chunk = readSync(fd, buffer, bytesRead, buffer.length - bytesRead, null);
		if (chunk === 0) break;
		bytesRead += chunk;
		if (stopOnNewline && buffer.subarray(0, bytesRead).includes(0x0a)) {
			break;
		}
	}
	if (!stopOnNewline && bytesRead > maxBytes) {
		return undefined;
	}
	return buffer.subarray(0, bytesRead);
}

/**
 * Reads up to maxBytes from a non-symlink regular file, optionally stopping after the first newline.
 * Returns undefined if the path is missing, a symlink, not a regular file, or exceeds maxBytes (when !stopOnNewline).
 */
export function readNoFollowBounded(
	filePath: string,
	maxBytes: number,
	stopOnNewline = false,
): Buffer | undefined {
	try {
		const stat = lstatSync(filePath);
		if (stat.isSymbolicLink() || !stat.isFile()) {
			return undefined;
		}
		if (!stopOnNewline && stat.size > maxBytes) {
			return undefined;
		}
		const fd = openSync(filePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
		try {
			return readFdBounded(fd, maxBytes, stopOnNewline);
		} finally {
			closeSync(fd);
		}
	} catch {
		return undefined;
	}
}

/**
 * Returns true if the given path exists and refers to a directory.
 */
export function isDirectoryPath(dirPath: string): boolean {
	try {
		return existsSync(dirPath) && statSync(dirPath).isDirectory();
	} catch {
		return false;
	}
}
