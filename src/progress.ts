import type { Writable } from "node:stream";

export interface ProgressLoggerOptions {
	stream?: Writable;
	quiet?: boolean;
	throttleMs?: number;
	now?: () => number;
}

function collapseSingleLine(text: string): string {
	return text.replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim();
}

function truncateText(text: string, maxLen: number): string {
	const single = collapseSingleLine(text);
	if (single.length <= maxLen) return single;
	return `${single.slice(0, Math.max(0, maxLen - 3))}...`;
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
		const clean = collapseSingleLine(message);
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
		return args === undefined ? "" : truncateText(String(args), 80);
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
		case "bash": {
			return truncateText(str("command") ?? "", 80);
		}
		default: {
			try {
				return truncateText(JSON.stringify(record), 80);
			} catch {
				return "";
			}
		}
	}
}
