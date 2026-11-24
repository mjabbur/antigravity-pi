import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { getAgyPiCacheSubdir } from "./paths.js";
import type { SessionSummary } from "./types.js";

export function getDefaultAgyPiSessionDir(): string {
	return getAgyPiCacheSubdir("AGY_PI_SESSION_DIR", "sessions");
}

function findSessionFileByIdInDir(sessionDir: string, sessionId: string): string | undefined {
	if (!existsSync(sessionDir)) return undefined;
	for (const entry of readdirSync(sessionDir)) {
		if (!entry.endsWith(".jsonl")) continue;
		const fullPath = join(sessionDir, entry);
		try {
			const content = readFileSync(fullPath, "utf8");
			const newlineIdx = content.indexOf("\n");
			const firstLine = (newlineIdx === -1 ? content : content.slice(0, newlineIdx)).trim();
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
	mkdirSync(sessionDir, { recursive: true });

	if (options.sessionId) {
		const candidatePath = resolve(cwd, options.sessionId);
		if (options.sessionId.endsWith(".jsonl") && existsSync(candidatePath) && statSync(candidatePath).isFile()) {
			return SessionManager.open(candidatePath, sessionDir, cwd);
		}
		const directPath = existsSync(options.sessionId) && statSync(options.sessionId).isFile()
			? resolve(options.sessionId)
			: undefined;
		if (directPath) {
			return SessionManager.open(directPath, sessionDir, cwd);
		}

		const found =
			SessionManager.findById(cwd, options.sessionId, sessionDir) ??
			findSessionFileByIdInDir(sessionDir, options.sessionId);
		if (!found) {
			throw new Error(`Session "${options.sessionId}" not found in ${sessionDir}.`);
		}
		return SessionManager.open(found, sessionDir, cwd);
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
