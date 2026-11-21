import { resolve } from "node:path";
import { parseArgs, type ParseArgsConfig } from "node:util";
import type { ParsedCommand, RunMode, ThinkingLevel } from "./types.js";

export const VALID_THINKING_LEVELS: readonly ThinkingLevel[] = [
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
] as const;

export const VALID_RUN_MODES: readonly RunMode[] = ["readonly", "coder"] as const;

export class CliUsageError extends Error {
	readonly exitCode = 2;

	constructor(message: string) {
		super(message);
		this.name = "CliUsageError";
	}
}

export const HELP_TEXT = `agy-pi - CLI bridge over the Pi Coding Agent SDK

Usage:
  agy-pi <command> [options] [prompt]

Commands:
  models [query]     List available models with configured credentials
  ask [prompt]       Single-turn (or session-backed) model consultation
  run [prompt]       Autonomous tool-using agent session
  sessions           List recent agy-pi sessions

Global options:
  -h, --help         Show help
  -v, --version      Show version

models options:
  -p, --provider <id>  Filter by provider id
      --refresh        Refresh remote model catalogs before listing
      --json           Output JSON

ask options:
  -m, --model <spec>       Model spec (provider/id[:thinking] or pattern)
  -t, --thinking <level>   Thinking level (off|minimal|low|medium|high|xhigh|max)
  -s, --system <text>      System prompt
  -f, --file <path>        Attach file as context (repeatable)
      --session <id>       Resume session by id or .jsonl path
      --no-session         Do not persist session
      --timeout <sec>      Timeout in seconds
      --json               Output JSON
  -q, --quiet              Suppress progress logs on stderr

run options:
  -m, --model <spec>       Model spec (provider/id[:thinking] or pattern)
  -t, --thinking <level>   Thinking level (off|minimal|low|medium|high|xhigh|max)
      --mode <mode>        Tool mode: readonly (default) or coder
  -C, --cwd <dir>          Working directory (default: current directory)
  -s, --system <text>      Additional system prompt instructions
      --session <id>       Resume session by id or .jsonl path
      --no-session         Do not persist session
      --timeout <sec>      Timeout in seconds
      --json               Output JSON
  -q, --quiet              Suppress progress logs on stderr

sessions options:
  -n, --limit <n>          Maximum sessions to list (default: 20)
      --json               Output JSON`;

function validateThinking(value: string | undefined): ThinkingLevel | undefined {
	if (value === undefined) return undefined;
	if ((VALID_THINKING_LEVELS as readonly string[]).includes(value)) {
		return value as ThinkingLevel;
	}
	throw new CliUsageError(
		`Invalid thinking level "${value}". Expected one of: ${VALID_THINKING_LEVELS.join(", ")}.`,
	);
}

function validateMode(value: string | undefined): RunMode {
	if (value === undefined) return "readonly";
	if ((VALID_RUN_MODES as readonly string[]).includes(value)) {
		return value as RunMode;
	}
	throw new CliUsageError(`Invalid mode "${value}". Expected one of: ${VALID_RUN_MODES.join(", ")}.`);
}

function validatePositiveNumber(value: string | undefined, flagName: string): number | undefined {
	if (value === undefined) return undefined;
	const parsed = Number(value);
	if (!Number.isFinite(parsed) || parsed <= 0) {
		throw new CliUsageError(`Invalid ${flagName} "${value}". Expected a positive number.`);
	}
	return parsed;
}

function validatePositiveInt(value: string | undefined, flagName: string, defaultValue: number): number {
	if (value === undefined) return defaultValue;
	if (!/^\d+$/.test(value)) {
		throw new CliUsageError(`Invalid ${flagName} "${value}". Expected a positive integer.`);
	}
	const parsed = Number(value);
	if (!Number.isSafeInteger(parsed) || parsed <= 0) {
		throw new CliUsageError(`Invalid ${flagName} "${value}". Expected a positive integer.`);
	}
	return parsed;
}

function runParseArgs<const T extends ParseArgsConfig>(config: T): ReturnType<typeof parseArgs<T>> {
	try {
		return parseArgs(config);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new CliUsageError(message);
	}
}

export function parseCliArgs(argv: string[], defaultCwd = process.cwd()): ParsedCommand {
	if (argv.length === 0) {
		return { kind: "help" };
	}

	const first = argv[0];
	if (first === "-h" || first === "--help" || first === "help") {
		return { kind: "help" };
	}
	if (first === "-v" || first === "--version" || first === "version") {
		return { kind: "version" };
	}
	if (first.startsWith("-")) {
		throw new CliUsageError(`Unknown option "${first}". Run 'agy-pi --help' for usage.`);
	}

	const rest = argv.slice(1);

	switch (first) {
		case "models": {
			const { values, positionals } = runParseArgs({
				args: rest,
				strict: true,
				allowPositionals: true,
				options: {
					provider: { type: "string", short: "p" },
					refresh: { type: "boolean", default: false },
					json: { type: "boolean", default: false },
					help: { type: "boolean", short: "h", default: false },
				},
			});
			if (values.help) return { kind: "help" };
			if (positionals.length > 1) {
				throw new CliUsageError("Too many arguments for 'models'. Expected at most one query string.");
			}
			return {
				kind: "models",
				query: positionals[0],
				provider: values.provider,
				refresh: values.refresh,
				json: values.json,
			};
		}

		case "sessions": {
			const { values, positionals } = runParseArgs({
				args: rest,
				strict: true,
				allowPositionals: true,
				options: {
					limit: { type: "string", short: "n" },
					json: { type: "boolean", default: false },
					help: { type: "boolean", short: "h", default: false },
				},
			});
			if (values.help) return { kind: "help" };
			if (positionals.length > 0) {
				throw new CliUsageError(`Unexpected positional argument "${positionals[0]}" for 'sessions'.`);
			}
			return {
				kind: "sessions",
				limit: validatePositiveInt(values.limit, "--limit", 20),
				json: values.json,
			};
		}

		case "ask": {
			const { values, positionals } = runParseArgs({
				args: rest,
				strict: true,
				allowPositionals: true,
				options: {
					model: { type: "string", short: "m" },
					thinking: { type: "string", short: "t" },
					system: { type: "string", short: "s" },
					file: { type: "string", short: "f", multiple: true, default: [] },
					session: { type: "string" },
					"no-session": { type: "boolean", default: false },
					timeout: { type: "string" },
					json: { type: "boolean", default: false },
					quiet: { type: "boolean", short: "q", default: false },
					help: { type: "boolean", short: "h", default: false },
				},
			});
			if (values.help) return { kind: "help" };
			if (values.session && values["no-session"]) {
				throw new CliUsageError("Cannot combine --session and --no-session.");
			}
			return {
				kind: "ask",
				model: values.model,
				thinking: validateThinking(values.thinking),
				system: values.system,
				files: values.file,
				sessionId: values.session,
				noSession: values["no-session"],
				timeoutSec: validatePositiveNumber(values.timeout, "--timeout"),
				json: values.json,
				quiet: values.quiet,
				prompt: positionals.length > 0 ? positionals.join(" ") : undefined,
			};
		}

		case "run": {
			const { values, positionals } = runParseArgs({
				args: rest,
				strict: true,
				allowPositionals: true,
				options: {
					model: { type: "string", short: "m" },
					thinking: { type: "string", short: "t" },
					mode: { type: "string" },
					cwd: { type: "string", short: "C" },
					system: { type: "string", short: "s" },
					session: { type: "string" },
					"no-session": { type: "boolean", default: false },
					timeout: { type: "string" },
					json: { type: "boolean", default: false },
					quiet: { type: "boolean", short: "q", default: false },
					help: { type: "boolean", short: "h", default: false },
				},
			});
			if (values.help) return { kind: "help" };
			if (values.session && values["no-session"]) {
				throw new CliUsageError("Cannot combine --session and --no-session.");
			}
			return {
				kind: "run",
				model: values.model,
				thinking: validateThinking(values.thinking),
				mode: validateMode(values.mode),
				cwd: values.cwd ? resolve(defaultCwd, values.cwd) : resolve(defaultCwd),
				system: values.system,
				sessionId: values.session,
				noSession: values["no-session"],
				timeoutSec: validatePositiveNumber(values.timeout, "--timeout"),
				json: values.json,
				quiet: values.quiet,
				prompt: positionals.length > 0 ? positionals.join(" ") : undefined,
			};
		}

		default:
			throw new CliUsageError(`Unknown command "${first}". Run 'agy-pi --help' for usage.`);
	}
}
