import { randomBytes } from "node:crypto";
import {
	closeSync,
	constants,
	existsSync,
	openSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	writeSync,
} from "node:fs";
import { join, resolve } from "node:path";
import {
	ensurePrivateDir,
	getAgyPiCacheSubdir,
	isPathInsideDir,
	readNoFollowBounded,
} from "./paths.js";
import { KNOWN_BUILTIN_TOOLS, type SubagentRecord, type SubagentStatus } from "./types.js";
import { isValidGitCommitHash } from "./worktree.js";

export const SUBAGENT_NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;
export const MAX_SUBAGENT_RECORD_BYTES = 256 * 1024;

const KNOWN_TOOL_SET = new Set<string>(KNOWN_BUILTIN_TOOLS);
const VALID_STATUS_SET = new Set<string>(["running", "idle", "error", "killed"]);

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
	if (!isValidSubagentName(record.id)) {
		throw new Error(`Invalid subagent ID "${record.id}".`);
	}
	const dir = resolveSubagentsDir(subagentsDir);
	ensurePrivateDir(dir);
	const targetPath = resolve(dir, `${record.id}.json`);
	if (!isPathInsideDir(targetPath, dir)) {
		throw new Error(`Invalid subagent record path for "${record.id}".`);
	}
	const tmpPath = join(
		dir,
		`.${record.id}.tmp.${process.pid}.${randomBytes(4).toString("hex")}`,
	);
	const payload = `${JSON.stringify(record, null, 2)}\n`;
	try {
		const fd = openSync(tmpPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
		try {
			writeSync(fd, payload, undefined, "utf8");
		} finally {
			closeSync(fd);
		}
		renameSync(tmpPath, targetPath);
	} catch (error) {
		rmSync(tmpPath, { force: true });
		throw error;
	}
	return targetPath;
}

/**
 * Reads the Linux /proc/<pid>/stat starttime (field 22) for PID reuse detection.
 */
export function readProcessStartTime(pid: number): string | undefined {
	if (!Number.isInteger(pid) || pid <= 0 || process.platform !== "linux") {
		return undefined;
	}
	try {
		const raw = readFileSync(`/proc/${pid}/stat`, "utf8");
		const lastParen = raw.lastIndexOf(")");
		if (lastParen === -1) {
			return undefined;
		}
		const fields = raw.slice(lastParen + 1).trim().split(/\s+/);
		const startTime = fields[19];
		return startTime && /^\d+$/.test(startTime) ? startTime : undefined;
	} catch {
		return undefined;
	}
}

function readProcessCmdline(pid: number): string | undefined {
	if (!Number.isInteger(pid) || pid <= 0 || process.platform !== "linux") {
		return undefined;
	}
	try {
		const raw = readFileSync(`/proc/${pid}/cmdline`, "utf8").replace(/\0/g, " ").trim();
		return raw.length > 0 ? raw : undefined;
	} catch {
		return undefined;
	}
}

export function isProcessAlive(pid: number): boolean {
	if (!Number.isInteger(pid) || pid <= 0) {
		return false;
	}
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

/**
 * Verifies that a PID is alive and belongs to an agy-pi subagent process before signaling.
 */
export function verifyProcessIdentity(pid: number, expectedStartTime?: string): boolean {
	if (!isProcessAlive(pid)) {
		return false;
	}
	if (process.platform !== "linux") {
		return true;
	}

	let matchedStartTime = false;
	if (expectedStartTime !== undefined) {
		const actualStartTime = readProcessStartTime(pid);
		if (actualStartTime === undefined || actualStartTime !== expectedStartTime) {
			return false;
		}
		matchedStartTime = true;
	}

	const cmdline = readProcessCmdline(pid);
	if (cmdline !== undefined) {
		return cmdline.includes("agy-pi") || cmdline.includes("cli.js");
	}

	return matchedStartTime;
}

export function reconcileStatus(record: SubagentRecord): SubagentRecord {
	if (record.status !== "running") {
		return record;
	}
	if (record.pid !== undefined && isProcessAlive(record.pid)) {
		if (record.pidStartTime === undefined || process.platform !== "linux") {
			return record;
		}
		const actualStartTime = readProcessStartTime(record.pid);
		if (actualStartTime === undefined || actualStartTime === record.pidStartTime) {
			return record;
		}
	}
	return {
		...record,
		status: record.lastError ? "error" : "idle",
		pid: undefined,
	};
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isValidWorktreeInfo(value: unknown): boolean {
	if (!isPlainObject(value)) return false;
	return (
		typeof value.repoRoot === "string" &&
		value.repoRoot.length > 0 &&
		typeof value.path === "string" &&
		value.path.length > 0 &&
		typeof value.branch === "string" &&
		value.branch.startsWith("agy-pi/") &&
		typeof value.baseCommit === "string" &&
		isValidGitCommitHash(value.baseCommit)
	);
}

function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.length > 0;
}

function hasValidSubagentIdentity(
	value: Record<string, unknown>,
	expectedFilename: string,
): boolean {
	return (
		typeof value.id === "string" &&
		isValidSubagentName(value.id) &&
		expectedFilename === `${value.id}.json` &&
		isNonEmptyString(value.name) &&
		isNonEmptyString(value.sessionId) &&
		!value.sessionId.includes("\0") &&
		isNonEmptyString(value.model)
	);
}

function hasValidExecutionFields(value: Record<string, unknown>): boolean {
	if (value.workspace !== "inherit" && value.workspace !== "worktree") return false;
	if (value.mode !== "readonly" && value.mode !== "coder") return false;
	if (
		!Array.isArray(value.tools) ||
		!value.tools.every((tool) => typeof tool === "string" && KNOWN_TOOL_SET.has(tool))
	) {
		return false;
	}
	return (
		typeof value.cwd === "string" &&
		typeof value.effectiveCwd === "string" &&
		typeof value.status === "string" &&
		VALID_STATUS_SET.has(value.status) &&
		typeof value.createdAt === "string" &&
		typeof value.updatedAt === "string"
	);
}

function isValidSubagentRecord(
	value: unknown,
	expectedFilename: string,
): value is SubagentRecord {
	if (!isPlainObject(value)) return false;
	if (!hasValidSubagentIdentity(value, expectedFilename)) return false;
	if (!hasValidExecutionFields(value)) return false;
	return value.worktree === undefined || isValidWorktreeInfo(value.worktree);
}

function readSubagentRecordFile(
	fullPath: string,
	expectedFilename: string,
): SubagentRecord | undefined {
	const buf = readNoFollowBounded(fullPath, MAX_SUBAGENT_RECORD_BYTES);
	if (!buf) return undefined;
	try {
		const parsed: unknown = JSON.parse(buf.toString("utf8"));
		if (!isValidSubagentRecord(parsed, expectedFilename)) {
			return undefined;
		}
		return reconcileStatus(parsed);
	} catch {
		return undefined;
	}
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
		const record = readSubagentRecordFile(fullPath, entry);
		if (record) {
			records.push(record);
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
	if (!isValidSubagentName(id)) {
		throw new Error(`Invalid subagent ID "${id}".`);
	}
	const dir = resolveSubagentsDir(subagentsDir);
	const targetPath = resolve(dir, `${id}.json`);
	if (!isPathInsideDir(targetPath, dir)) {
		throw new Error(`Refusing to delete subagent record outside "${dir}".`);
	}
	if (!existsSync(targetPath)) {
		return false;
	}
	rmSync(targetPath, { force: true });
	return true;
}
