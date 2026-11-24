import { resolve } from "node:path";
import { parseArgs, type ParseArgsConfig } from "node:util";
import { isValidSubagentName } from "./subagents.js";
import type {
	ParsedCommand,
	RunMode,
	SubagentStatus,
	ThinkingLevel,
	WorkspaceMode,
} from "./types.js";

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
export const VALID_WORKSPACE_MODES: readonly WorkspaceMode[] = ["inherit", "worktree"] as const;
export const VALID_SUBAGENT_STATUSES: readonly SubagentStatus[] = [
	"running",
	"idle",
	"error",
	"killed",
] as const;

export class CliUsageError extends Error {
	readonly exitCode = 2;

	constructor(message: string) {
		super(message);
		this.name = "CliUsageError";
	}
}

const HELP_HEADER = `agy-pi - CLI bridge over the Pi Coding Agent SDK

Usage:
  agy-pi <command> [options] [prompt]

Commands:
  models [query]           List available models with configured credentials
  ask [prompt]             Single-turn (or session-backed) model consultation
  run [prompt]             Autonomous tool-using agent session
  agents                   List declarative agent profiles
  send <target> [prompt]   Send a follow-up prompt to an existing subagent
  ls                       List tracked subagents (alias: subagents)
  diff <target>            Show git worktree diff for a subagent
  kill <target> | --all    Stop a subagent, clean up worktree, and remove registry entry
  sessions                 List recent agy-pi sessions

Global options:
  -h, --help               Show help
  -v, --version            Show version`;

const HELP_QUERY_OPTIONS = `models options:
  -p, --provider <id>      Filter by provider id
      --refresh            Refresh remote model catalogs before listing
      --json               Output JSON

ask options:
  -m, --model <spec>       Model spec (provider/id[:thinking] or pattern)
  -t, --thinking <level>   Thinking level (off|minimal|low|medium|high|xhigh|max)
  -s, --system <text>      System prompt
  -f, --file <path>        Attach file as context (repeatable)
      --session <id>       Resume session by id or .jsonl path
      --no-session         Do not persist session
      --timeout <sec>      Timeout in seconds
      --json               Output JSON
  -q, --quiet              Suppress progress logs on stderr`;

const HELP_AGENT_OPTIONS = `run options:
  -a, --agent <name>       Use a declarative agent profile
      --name <id>          Assign a stable subagent name
  -m, --model <spec>       Model spec (provider/id[:thinking] or pattern)
  -t, --thinking <level>   Thinking level (off|minimal|low|medium|high|xhigh|max)
      --mode <mode>        Tool mode: readonly (default) or coder
  -w, --workspace <mode>   Workspace mode: inherit (default) or worktree
      --tools <list>       Comma-separated tool allowlist
  -C, --cwd <dir>          Working directory (default: current directory)
  -s, --system <text>      Additional system prompt instructions
  -f, --file <path>        Attach file as context (repeatable)
      --project-agents     Discover project-local .pi/agents profiles
      --session <id>       Resume session by id or .jsonl path
      --no-session         Do not persist session or subagent record
      --timeout <sec>      Timeout in seconds
      --json               Output JSON
  -q, --quiet              Suppress progress logs on stderr`;

const HELP_SUBAGENT_OPTIONS = `agents options:
  -C, --cwd <dir>          Working directory for project agent lookup
      --project-agents     Include project-local .pi/agents profiles
      --json               Output JSON

send options:
  -m, --model <spec>       Override model spec
  -t, --thinking <level>   Override thinking level
  -f, --file <path>        Attach file as context (repeatable)
      --timeout <sec>      Timeout in seconds
      --json               Output JSON
  -q, --quiet              Suppress progress logs on stderr

ls options:
      --status <status>    Filter by status (running|idle|error|killed)
  -n, --limit <n>          Maximum subagents to list (default: 20)
      --json               Output JSON`;

const HELP_MGMT_OPTIONS = `diff options:
      --stat               Show diffstat and status only
      --json               Output JSON

kill options:
      --all                Kill all tracked subagents
      --force              Force SIGKILL and discard uncommitted worktree changes
      --delete-branch      Delete worktree branch even if it has commits
      --json               Output JSON

sessions options:
  -n, --limit <n>          Maximum sessions to list (default: 20)
      --json               Output JSON`;

export const HELP_TEXT = [
	HELP_HEADER,
	HELP_QUERY_OPTIONS,
	HELP_AGENT_OPTIONS,
	HELP_SUBAGENT_OPTIONS,
	HELP_MGMT_OPTIONS,
].join("\n\n");

function validateEnum<T extends string>(
	raw: string | undefined,
	allowed: readonly T[],
	flagName: string,
): T | undefined {
	if (raw === undefined) return undefined;
	if ((allowed as readonly string[]).includes(raw)) {
		return raw as T;
	}
	throw new CliUsageError(
		`Invalid ${flagName} "${raw}". Expected one of: ${allowed.join(", ")}.`,
	);
}

function validateTools(value: string | undefined): string[] | undefined {
	if (value === undefined) return undefined;
	const parts = value.split(",").map((part) => part.trim());
	if (parts.length === 0 || parts.some((part) => part.length === 0)) {
		throw new CliUsageError(
			`Invalid --tools "${value}". Expected non-empty comma-separated tool names.`,
		);
	}
	const deduped: string[] = [];
	const seen = new Set<string>();
	for (const part of parts) {
		if (!seen.has(part)) {
			seen.add(part);
			deduped.push(part);
		}
	}
	return deduped;
}

function validateSubagentName(value: string | undefined): string | undefined {
	if (value === undefined) return undefined;
	if (!isValidSubagentName(value)) {
		throw new CliUsageError(
			`Invalid --name "${value}". Must start with alphanumeric and contain at most 64 [a-zA-Z0-9._-] characters.`,
		);
	}
	return value;
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

function parseModelsArgs(rest: string[]): ParsedCommand {
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

function parseSessionsArgs(rest: string[]): ParsedCommand {
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

function parseAgentsArgs(rest: string[], defaultCwd: string): ParsedCommand {
	const { values, positionals } = runParseArgs({
		args: rest,
		strict: true,
		allowPositionals: true,
		options: {
			cwd: { type: "string", short: "C" },
			"project-agents": { type: "boolean", default: false },
			json: { type: "boolean", default: false },
			help: { type: "boolean", short: "h", default: false },
		},
	});
	if (values.help) return { kind: "help" };
	if (positionals.length > 0) {
		throw new CliUsageError(`Unexpected positional argument "${positionals[0]}" for 'agents'.`);
	}
	return {
		kind: "agents",
		cwd: values.cwd ? resolve(defaultCwd, values.cwd) : resolve(defaultCwd),
		projectAgents: values["project-agents"],
		json: values.json,
	};
}

function parseAskArgs(rest: string[]): ParsedCommand {
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
		thinking: validateEnum(values.thinking, VALID_THINKING_LEVELS, "thinking level"),
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

function parseRunArgs(rest: string[], defaultCwd: string): ParsedCommand {
	const { values, positionals } = runParseArgs({
		args: rest,
		strict: true,
		allowPositionals: true,
		options: {
			agent: { type: "string", short: "a" },
			name: { type: "string" },
			model: { type: "string", short: "m" },
			thinking: { type: "string", short: "t" },
			mode: { type: "string" },
			workspace: { type: "string", short: "w" },
			tools: { type: "string" },
			cwd: { type: "string", short: "C" },
			system: { type: "string", short: "s" },
			file: { type: "string", short: "f", multiple: true, default: [] },
			"project-agents": { type: "boolean", default: false },
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
		agent: values.agent,
		name: validateSubagentName(values.name),
		model: values.model,
		thinking: validateEnum(values.thinking, VALID_THINKING_LEVELS, "thinking level"),
		mode: validateEnum(values.mode, VALID_RUN_MODES, "mode") ?? "readonly",
		modeExplicit: values.mode !== undefined,
		workspace: validateEnum(values.workspace, VALID_WORKSPACE_MODES, "workspace"),
		tools: validateTools(values.tools),
		cwd: values.cwd ? resolve(defaultCwd, values.cwd) : resolve(defaultCwd),
		system: values.system,
		files: values.file,
		projectAgents: values["project-agents"],
		sessionId: values.session,
		noSession: values["no-session"],
		timeoutSec: validatePositiveNumber(values.timeout, "--timeout"),
		json: values.json,
		quiet: values.quiet,
		prompt: positionals.length > 0 ? positionals.join(" ") : undefined,
	};
}

function parseSendArgs(rest: string[]): ParsedCommand {
	const { values, positionals } = runParseArgs({
		args: rest,
		strict: true,
		allowPositionals: true,
		options: {
			model: { type: "string", short: "m" },
			thinking: { type: "string", short: "t" },
			file: { type: "string", short: "f", multiple: true, default: [] },
			timeout: { type: "string" },
			json: { type: "boolean", default: false },
			quiet: { type: "boolean", short: "q", default: false },
			help: { type: "boolean", short: "h", default: false },
		},
	});
	if (values.help) return { kind: "help" };
	if (positionals.length === 0) {
		throw new CliUsageError(
			"Subagent target is required. Usage: agy-pi send <name|id> [prompt]",
		);
	}
	const [target, ...promptParts] = positionals;
	return {
		kind: "send",
		target,
		model: values.model,
		thinking: validateEnum(values.thinking, VALID_THINKING_LEVELS, "thinking level"),
		files: values.file,
		timeoutSec: validatePositiveNumber(values.timeout, "--timeout"),
		json: values.json,
		quiet: values.quiet,
		prompt: promptParts.length > 0 ? promptParts.join(" ") : undefined,
	};
}

function parseLsArgs(rest: string[], commandName: string): ParsedCommand {
	const { values, positionals } = runParseArgs({
		args: rest,
		strict: true,
		allowPositionals: true,
		options: {
			status: { type: "string" },
			limit: { type: "string", short: "n" },
			json: { type: "boolean", default: false },
			help: { type: "boolean", short: "h", default: false },
		},
	});
	if (values.help) return { kind: "help" };
	if (positionals.length > 0) {
		throw new CliUsageError(
			`Unexpected positional argument "${positionals[0]}" for '${commandName}'.`,
		);
	}
	return {
		kind: "ls",
		status: validateEnum(values.status, VALID_SUBAGENT_STATUSES, "status"),
		limit: validatePositiveInt(values.limit, "--limit", 20),
		json: values.json,
	};
}

function parseDiffArgs(rest: string[]): ParsedCommand {
	const { values, positionals } = runParseArgs({
		args: rest,
		strict: true,
		allowPositionals: true,
		options: {
			stat: { type: "boolean", default: false },
			json: { type: "boolean", default: false },
			help: { type: "boolean", short: "h", default: false },
		},
	});
	if (values.help) return { kind: "help" };
	if (positionals.length === 0) {
		throw new CliUsageError("Subagent target is required. Usage: agy-pi diff <name|id>");
	}
	if (positionals.length > 1) {
		throw new CliUsageError("Too many arguments for 'diff'. Expected <name|id>.");
	}
	return {
		kind: "diff",
		target: positionals[0],
		statOnly: values.stat,
		json: values.json,
	};
}

function parseKillArgs(rest: string[]): ParsedCommand {
	const { values, positionals } = runParseArgs({
		args: rest,
		strict: true,
		allowPositionals: true,
		options: {
			all: { type: "boolean", default: false },
			force: { type: "boolean", default: false },
			"delete-branch": { type: "boolean", default: false },
			json: { type: "boolean", default: false },
			help: { type: "boolean", short: "h", default: false },
		},
	});
	if (values.help) return { kind: "help" };
	if (values.all && positionals.length > 0) {
		throw new CliUsageError("Cannot combine a subagent target with --all.");
	}
	if (!values.all && positionals.length === 0) {
		throw new CliUsageError(
			"Subagent target or --all is required. Usage: agy-pi kill <name|id> | --all",
		);
	}
	if (positionals.length > 1) {
		throw new CliUsageError("Too many arguments for 'kill'. Expected at most one <name|id>.");
	}
	return {
		kind: "kill",
		target: positionals[0],
		all: values.all,
		force: values.force,
		deleteBranch: values["delete-branch"],
		json: values.json,
	};
}

type CommandParser = (rest: string[], defaultCwd: string, commandName: string) => ParsedCommand;

const COMMAND_PARSERS: Record<string, CommandParser> = {
	models: (rest) => parseModelsArgs(rest),
	sessions: (rest) => parseSessionsArgs(rest),
	agents: (rest, defaultCwd) => parseAgentsArgs(rest, defaultCwd),
	ask: (rest) => parseAskArgs(rest),
	run: (rest, defaultCwd) => parseRunArgs(rest, defaultCwd),
	send: (rest) => parseSendArgs(rest),
	ls: (rest, _defaultCwd, name) => parseLsArgs(rest, name),
	subagents: (rest, _defaultCwd, name) => parseLsArgs(rest, name),
	diff: (rest) => parseDiffArgs(rest),
	kill: (rest) => parseKillArgs(rest),
};

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

	const parser = COMMAND_PARSERS[first];
	if (!parser) {
		throw new CliUsageError(`Unknown command "${first}". Run 'agy-pi --help' for usage.`);
	}
	return parser(argv.slice(1), defaultCwd, first);
}
