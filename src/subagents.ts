import { randomBytes } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { getAgyPiCacheSubdir } from "./paths.js";
import type { SubagentRecord, SubagentStatus } from "./types.js";

export const SUBAGENT_NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;

export function getDefaultSubagentsDir(): string {
	return getAgyPiCacheSubdir("AGY_PI_SUBAGENTS_DIR", "subagents");
}

export function isValidSubagentName(name: string): boolean {
	return SUBAGENT_NAME_PATTERN.test(name);
}

export function generateSubagentId(prefix?: string, sessionId?: string): string {
	const rawPrefix = (prefix ?? "sub")
		.toLowerCase()
		.replace(/[^a-z0-9._-]+/g, "-")
		.replace(/^[^a-z0-9]+|[-_.]+$/g, "");
	const safePrefix = (rawPrefix.length > 0 ? rawPrefix : "sub").slice(0, 48);

	const sessionHex = sessionId
		? sessionId.replace(/[^a-zA-Z0-9]/g, "").slice(0, 6).toLowerCase()
		: "";
	const shortHex =
		sessionHex.length >= 4 ? sessionHex : randomBytes(3).toString("hex");

	return `${safePrefix}-${shortHex}`.slice(0, 64);
}

function resolveSubagentsDir(subagentsDir?: string): string {
	return subagentsDir ? resolve(subagentsDir) : getDefaultSubagentsDir();
}

export function saveSubagentRecord(
	record: SubagentRecord,
	subagentsDir?: string,
): string {
	const dir = resolveSubagentsDir(subagentsDir);
	mkdirSync(dir, { recursive: true });
	const targetPath = join(dir, `${record.id}.json`);
	const tmpPath = join(
		dir,
		`.${record.id}.tmp.${process.pid}.${randomBytes(4).toString("hex")}`,
	);
	writeFileSync(tmpPath, `${JSON.stringify(record, null, 2)}\n`, "utf8");
	renameSync(tmpPath, targetPath);
	return targetPath;
}

export function isProcessAlive(pid: number): boolean {
	if (!Number.isInteger(pid) || pid <= 0) {
		return false;
	}
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		const code = (error as NodeJS.ErrnoException | undefined)?.code;
		return code === "EPERM";
	}
}

export function reconcileStatus(record: SubagentRecord): SubagentRecord {
	if (record.status !== "running") {
		return record;
	}
	if (record.pid !== undefined && isProcessAlive(record.pid)) {
		return record;
	}
	return {
		...record,
		status: record.lastError ? "error" : "idle",
		pid: undefined,
	};
}

export function listSubagents(options: {
	subagentsDir?: string;
	status?: SubagentStatus;
	limit?: number;
} = {}): SubagentRecord[] {
	const dir = resolveSubagentsDir(options.subagentsDir);
	if (!existsSync(dir)) {
		return [];
	}

	let entries: string[];
	try {
		entries = readdirSync(dir);
	} catch {
		return [];
	}

	const records: SubagentRecord[] = [];
	for (const entry of entries) {
		if (!entry.endsWith(".json")) continue;
		const fullPath = join(dir, entry);
		try {
			const parsed = JSON.parse(readFileSync(fullPath, "utf8")) as SubagentRecord;
			if (!parsed || typeof parsed !== "object" || typeof parsed.id !== "string") {
				continue;
			}
			records.push(reconcileStatus(parsed));
		} catch {
			// Skip malformed or unreadable registry records.
		}
	}

	records.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));

	const filtered = options.status
		? records.filter((record) => record.status === options.status)
		: records;

	return options.limit !== undefined ? filtered.slice(0, options.limit) : filtered;
}

export function resolveSubagent(
	identifier: string,
	subagentsDir?: string,
): SubagentRecord {
	if (!identifier || identifier.trim().length === 0) {
		throw new Error(
			`Subagent "${identifier}" not found. Run 'agy-pi ls' to list subagents.`,
		);
	}

	const all = listSubagents({ subagentsDir });

	const byId = all.find((record) => record.id === identifier);
	if (byId) return byId;

	const byName = all.filter((record) => record.name === identifier);
	if (byName.length === 1) return byName[0];
	if (byName.length > 1) {
		throw new Error(
			`Ambiguous subagent name "${identifier}" matches multiple IDs: ${byName.map((r) => r.id).join(", ")}.`,
		);
	}

	const bySession = all.filter((record) => record.sessionId === identifier);
	if (bySession.length === 1) return bySession[0];
	if (bySession.length > 1) {
		throw new Error(
			`Ambiguous session ID "${identifier}" matches multiple subagents: ${bySession.map((r) => r.id).join(", ")}.`,
		);
	}

	const byPrefix = all.filter(
		(record) =>
			record.id.startsWith(identifier) ||
			record.sessionId.startsWith(identifier),
	);
	if (byPrefix.length === 1) return byPrefix[0];
	if (byPrefix.length > 1) {
		throw new Error(
			`Ambiguous subagent identifier "${identifier}" matches: ${byPrefix.map((r) => `${r.id} (session=${r.sessionId})`).join(", ")}.`,
		);
	}

	throw new Error(`Subagent "${identifier}" not found. Run 'agy-pi ls' to list subagents.`);
}

export function deleteSubagentRecord(id: string, subagentsDir?: string): boolean {
	const dir = resolveSubagentsDir(subagentsDir);
	const targetPath = join(dir, `${id}.json`);
	if (!existsSync(targetPath)) {
		return false;
	}
	rmSync(targetPath, { force: true });
	return true;
}
