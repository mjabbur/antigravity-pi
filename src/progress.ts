import type { Writable } from "node:stream";

export interface ProgressLoggerOptions {
	stream?: Writable;
	quiet?: boolean;
	throttleMs?: number;
	now?: () => number;
}

const ANSI_ESCAPE_PATTERN =
	// eslint-disable-next-line no-control-regex
	/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x9d[^\x07\x9c]*[\x07\x9c]|\x1b\[[0-?]*[ -/]*[@-~]|\x9b[0-?]*[ -/]*[@-~]|\x1b[@-Z\\-_]|\x1b[ -/]+[@-~]/g;

// eslint-disable-next-line no-control-regex
const ALL_CONTROLS_PATTERN = /[\x00-\x1f\x7f-\x9f]/g;
// eslint-disable-next-line no-control-regex
const CONTROLS_EXCEPT_NL_TAB_PATTERN = /[\x00-\x08\x0b-\x1f\x7f-\x9f]/g;

const SAFE_COMMAND_TOKEN_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,60}$/;
const ENV_ASSIGNMENT_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*=/;

/**
 * Strips ANSI CSI/OSC escape sequences and C0/C1 control characters from terminal output.
 */
export function stripTerminalControls(
	text: string,
	options: { preserveNewlines?: boolean } = {},
): string {
	const withoutAnsi = text.replace(ANSI_ESCAPE_PATTERN, "");
	const controlPattern = options.preserveNewlines
		? CONTROLS_EXCEPT_NL_TAB_PATTERN
		: ALL_CONTROLS_PATTERN;
	return withoutAnsi.replace(controlPattern, "");
}

/**
 * Redacts common API keys, tokens, and bearer credentials from log strings.
 */
export function redactSecrets(text: string): string {
	return text
		.replace(/\bBearer\s+[A-Za-z0-9._\-+/=]{4,}/gi, "Bearer [REDACTED]")
		.replace(/\b(?:sk|pk)-[A-Za-z0-9_-]{8,}/g, "[REDACTED]")
		.replace(/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{10,}/g, "[REDACTED]")
		.replace(/\bAIza[0-9A-Za-z\-_]{16,}/g, "[REDACTED]")
		.replace(
			/\b(api[_-]?key|token|secret|password|authorization)(\s*[:=]\s*)(?:"[^"]*"|'[^']*'|\S+)/gi,
			"$1$2[REDACTED]",
		);
}

function collapseSingleLine(text: string): string {
	const normalized = stripTerminalControls(text.replace(/[\r\n\t]+/g, " "));
	return normalized.replace(/\s+/g, " ").trim();
}

function truncateText(text: string, maxLen: number): string {
	const single = redactSecrets(collapseSingleLine(text));
	if (single.length <= maxLen) return single;
	return `${single.slice(0, Math.max(0, maxLen - 3))}...`;
}

function summarizeShellCommand(command: string): string {
	const cleaned = collapseSingleLine(command);
	if (!cleaned) return "";

	const tokens = cleaned.split(/\s+/);
	let index = 0;
	while (index < tokens.length && ENV_ASSIGNMENT_PATTERN.test(tokens[index])) {
		index += 1;
	}
	if (index >= tokens.length) {
		return "[redacted]";
	}

	const summaryTokens: string[] = [];
	const executable = tokens[index];
	if (executable.startsWith("-") || /["'$`]/.test(executable)) {
		return "[redacted]";
	}
	summaryTokens.push(executable);

	const subcommand = tokens[index + 1];
	if (
		subcommand &&
		!subcommand.startsWith("-") &&
		!ENV_ASSIGNMENT_PATTERN.test(subcommand) &&
		SAFE_COMMAND_TOKEN_PATTERN.test(subcommand)
	) {
		summaryTokens.push(subcommand);
	}

	return truncateText(summaryTokens.join(" "), 80);
}

export class ProgressLogger {
	private readonly stream: Writable;
	private readonly quiet: boolean;
	private readonly throttleMs: number;
	private readonly now: () => number;
	private readonly startTime: number;
	private lastThrottledAt = Number.NEGATIVE_INFINITY;

	constructor(options: ProgressLoggerOptions = {}) {
		this.stream = options.stream ?? process.stderr;
		this.quiet = options.quiet ?? false;
		this.throttleMs = options.throttleMs ?? 3000;
		this.now = options.now ?? (() => Date.now());
		this.startTime = this.now();
	}

	private formatElapsed(): string {
		const totalSeconds = Math.max(0, Math.floor((this.now() - this.startTime) / 1000));
		const minutes = Math.floor(totalSeconds / 60);
		const seconds = totalSeconds % 60;
		return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
	}

	log(message: string): void {
		if (this.quiet) return;
		const clean = redactSecrets(collapseSingleLine(message));
		if (!clean) return;
		this.stream.write(`[agy-pi ${this.formatElapsed()}] ${clean}\n`);
	}

	logThrottled(message: string): void {
		if (this.quiet) return;
		const current = this.now();
		if (current - this.lastThrottledAt < this.throttleMs) {
			return;
		}
		this.lastThrottledAt = current;
		this.log(message);
	}
}

export function summarizeToolArgs(toolName: string, args: unknown): string {
	if (typeof args !== "object" || args === null || Array.isArray(args)) {
		if (args === undefined) return "";
		if (Array.isArray(args)) return `[array(${args.length})]`;
		return truncateText(String(args), 80);
	}

	const record = args as Record<string, unknown>;
	const str = (key: string): string | undefined =>
		typeof record[key] === "string" ? (record[key] as string) : undefined;
	const num = (key: string): number | undefined =>
		typeof record[key] === "number" ? (record[key] as number) : undefined;

	switch (toolName) {
		case "read": {
			const filePath = str("path") ?? str("file_path") ?? "";
			const offset = num("offset");
			const limit = num("limit");
			if (offset !== undefined && limit !== undefined) {
				return truncateText(`${filePath}:${offset}-${offset + limit - 1}`, 100);
			}
			if (offset !== undefined) {
				return truncateText(`${filePath}:${offset}`, 100);
			}
			return truncateText(filePath, 100);
		}
		case "edit":
		case "write": {
			const filePath = str("path") ?? str("file_path") ?? "";
			return truncateText(filePath, 100);
		}
		case "grep": {
			const pattern = str("pattern") ?? "";
			const targetPath = str("path");
			const base = targetPath ? `/${pattern}/ in ${targetPath}` : `/${pattern}/`;
			return truncateText(base, 100);
		}
		case "find": {
			const pattern = str("pattern") ?? "*";
			const targetPath = str("path");
			const base = targetPath ? `${pattern} in ${targetPath}` : pattern;
			return truncateText(base, 100);
		}
		case "ls": {
			return truncateText(str("path") ?? ".", 100);
		}
		case "bash":
		case "powershell": {
			return summarizeShellCommand(str("command") ?? "");
		}
		default: {
			const keys = Object.keys(record).sort((a, b) => a.localeCompare(b));
			return keys.length > 0 ? truncateText(`keys=[${keys.join(", ")}]`, 80) : "";
		}
	}
}
