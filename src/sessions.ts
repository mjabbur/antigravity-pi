import { existsSync, lstatSync, readdirSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import {
	ensurePrivateDir,
	getAgyPiCacheSubdir,
	isPathInsideDir,
	readNoFollowBounded,
	safeRealpath,
} from "./paths.js";
import type { SessionSummary } from "./types.js";

const SESSION_HEADER_READ_BYTES = 8 * 1024;

export function getDefaultAgyPiSessionDir(): string {
	return getAgyPiCacheSubdir("AGY_PI_SESSION_DIR", "sessions");
}

function readSessionFirstLine(filePath: string): string | undefined {
	const buf = readNoFollowBounded(filePath, SESSION_HEADER_READ_BYTES, true);
	if (!buf) return undefined;
	const content = buf.toString("utf8");
	const newlineIdx = content.indexOf("\n");
	const firstLine = (newlineIdx === -1 ? content : content.slice(0, newlineIdx)).trim();
	return firstLine.length > 0 ? firstLine : undefined;
}

function findSessionFileByIdInDir(sessionDir: string, sessionId: string): string | undefined {
	if (!existsSync(sessionDir)) return undefined;
	for (const entry of readdirSync(sessionDir)) {
		if (!entry.endsWith(".jsonl")) continue;
		const fullPath = join(sessionDir, entry);
		try {
			const firstLine = readSessionFirstLine(fullPath);
			if (!firstLine) continue;
			const header = JSON.parse(firstLine) as { type?: unknown; id?: unknown };
			if (header.type === "session" && header.id === sessionId) {
				return fullPath;
			}
		} catch {
			// Ignore malformed or unreadable session files during lookup.
		}
	}
	return undefined;
}

function assertValidSessionFileInDir(candidatePath: string, sessionDir: string): string {
	const resolvedSessionDir = resolve(sessionDir);
	const resolvedCandidate = resolve(candidatePath);
	if (!isPathInsideDir(resolvedCandidate, resolvedSessionDir)) {
		throw new Error(`Refusing to open session path outside ${resolvedSessionDir}.`);
	}
	let stat;
	try {
		stat = lstatSync(resolvedCandidate);
	} catch {
		throw new Error(`Session "${candidatePath}" not found in ${resolvedSessionDir}.`);
	}
	if (stat.isSymbolicLink() || !stat.isFile()) {
		throw new Error(`Refusing to open non-regular or symlinked session file "${candidatePath}".`);
	}
	if (!isPathInsideDir(safeRealpath(resolvedCandidate), safeRealpath(resolvedSessionDir))) {
		throw new Error(`Refusing to open session path escaping ${resolvedSessionDir}.`);
	}
	return resolvedCandidate;
}

function resolveExistingSessionPath(rawId: string, cwd: string, sessionDir: string): string {
	if (rawId.includes("\0")) {
		throw new Error("Invalid session identifier.");
	}
	if (rawId.endsWith(".jsonl") || rawId.includes("/") || rawId.includes("\\")) {
		const candidatePath = isAbsolute(rawId) ? resolve(rawId) : resolve(sessionDir, rawId);
		return assertValidSessionFileInDir(candidatePath, sessionDir);
	}
	if (rawId.includes("..") || rawId.trim().length === 0) {
		throw new Error(`Session "${rawId}" not found in ${sessionDir}.`);
	}
	const found =
		SessionManager.findById(cwd, rawId, sessionDir) ??
		findSessionFileByIdInDir(sessionDir, rawId);
	if (!found) {
		throw new Error(`Session "${rawId}" not found in ${sessionDir}.`);
	}
	return assertValidSessionFileInDir(found, sessionDir);
}

export function openOrCreateSession(options: {
	cwd: string;
	sessionId?: string;
	noSession: boolean;
	sessionDir?: string;
}): SessionManager {
	const cwd = resolve(options.cwd);
	if (options.noSession) {
		return SessionManager.inMemory(cwd);
	}

	const sessionDir = options.sessionDir ? resolve(options.sessionDir) : getDefaultAgyPiSessionDir();
	ensurePrivateDir(sessionDir);

	if (options.sessionId) {
		const sessionPath = resolveExistingSessionPath(options.sessionId, cwd, sessionDir);
		return SessionManager.open(sessionPath, sessionDir, cwd);
	}

	return SessionManager.create(cwd, sessionDir);
}

export async function listAgyPiSessions(options: {
	limit: number;
	sessionDir?: string;
}): Promise<SessionSummary[]> {
	const sessionDir = options.sessionDir ? resolve(options.sessionDir) : getDefaultAgyPiSessionDir();
	if (!existsSync(sessionDir)) {
		return [];
	}

	const sessions = await SessionManager.listAll(sessionDir);
	return sessions
		.slice()
		.sort((a, b) => b.modified.getTime() - a.modified.getTime())
		.slice(0, options.limit)
		.map((info) => ({
			id: info.id,
			path: info.path,
			cwd: info.cwd,
			...(info.name ? { name: info.name } : {}),
			created: info.created.toISOString(),
			modified: info.modified.toISOString(),
			messageCount: info.messageCount,
			firstMessage: info.firstMessage,
		}));
}
