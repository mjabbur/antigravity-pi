import { existsSync, statSync } from "node:fs";
import os from "node:os";
import { join, resolve } from "node:path";

/**
 * Resolves a cache subdirectory for agy-pi, honoring an environment variable override when non-empty.
 */
export function getAgyPiCacheSubdir(envVar: string, subdir: string): string {
	const override = process.env[envVar];
	if (override && override.length > 0) {
		return resolve(override);
	}
	const cacheHome = process.env.XDG_CACHE_HOME || join(os.homedir(), ".cache");
	return join(cacheHome, "agy-pi", subdir);
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
