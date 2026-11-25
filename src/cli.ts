#!/usr/bin/env node
import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { CliUsageError, HELP_TEXT, parseCliArgs } from "./args.js";
import { runAgentsCommand } from "./commands/agents.js";
import { runAskCommand } from "./commands/ask.js";
import { runDiffCommand } from "./commands/diff.js";
import { runKillCommand } from "./commands/kill.js";
import { runLsCommand } from "./commands/ls.js";
import { runModelsCommand } from "./commands/models.js";
import { runAgentCommand } from "./commands/run.js";
import { runSendCommand } from "./commands/send.js";
import { runSessionsCommand } from "./commands/sessions.js";
import { resolvePromptInput } from "./files.js";
import {
	formatAgentsText,
	formatAskText,
	formatDiffText,
	formatJson,
	formatKillText,
	formatModelsText,
	formatRunText,
	formatSessionsText,
	formatSubagentsText,
} from "./format.js";
import { ProgressLogger, stripTerminalControls } from "./progress.js";
import { CliAbortError, initPiRuntime, type PiRuntime } from "./runtime.js";
import type { ParsedCommand } from "./types.js";

interface AbortState {
	exitCode: number;
	reason?: string;
}

function readCliVersion(): string {
	for (const relativePath of ["../../package.json", "../package.json"]) {
		try {
			const raw = readFileSync(new URL(relativePath, import.meta.url), "utf8");
			const parsed = JSON.parse(raw) as { version?: unknown };
			if (typeof parsed.version === "string" && parsed.version.length > 0) {
				return parsed.version;
			}
		} catch {
			// Try next candidate path.
		}
	}
	return "0.0.0";
}

function writeStdout(text: string): void {
	process.stdout.write(text.endsWith("\n") ? text : `${text}\n`);
}

function writeStderr(text: string): void {
	process.stderr.write(text.endsWith("\n") ? text : `${text}\n`);
}

function wantsJsonOutput(argv: string[]): boolean {
	return argv.includes("--json");
}

function outputResult<T>(json: boolean, data: T, formatText: (value: T) => string): number {
	writeStdout(json ? formatJson(data) : formatText(data));
	return 0;
}

async function dispatchSimpleCommand(
	command: ParsedCommand,
	onRuntime: (runtime: PiRuntime) => void,
): Promise<number | undefined> {
	switch (command.kind) {
		case "help":
			writeStdout(HELP_TEXT);
			return 0;
		case "version":
			writeStdout(`agy-pi ${readCliVersion()}`);
			return 0;
		case "sessions":
			return outputResult(command.json, await runSessionsCommand(command), formatSessionsText);
		case "agents":
			return outputResult(command.json, await runAgentsCommand(command), formatAgentsText);
		case "ls":
			return outputResult(command.json, await runLsCommand(command), formatSubagentsText);
		case "diff":
			return outputResult(command.json, await runDiffCommand(command), formatDiffText);
		case "kill":
			return outputResult(command.json, await runKillCommand(command), formatKillText);
		case "models": {
			const runtime = await initPiRuntime({ refresh: command.refresh });
			onRuntime(runtime);
			const models = await runModelsCommand(command, { modelRuntime: runtime.modelRuntime });
			return outputResult(command.json, models, formatModelsText);
		}
		default:
			return undefined;
	}
}

async function dispatchExecutionCommand(
	command: Extract<ParsedCommand, { kind: "ask" | "run" | "send" }>,
	signal: AbortSignal,
	onRuntime: (runtime: PiRuntime) => void,
): Promise<number> {
	const prompt = await resolvePromptInput(command.prompt);
	const progress = new ProgressLogger({ quiet: command.quiet });

	if (command.kind === "ask") {
		const runtime = await initPiRuntime({ cwd: process.cwd() });
		onRuntime(runtime);
		const result = await runAskCommand(
			{ ...command, prompt },
			{
				modelRuntime: runtime.modelRuntime,
				settingsManager: runtime.settingsManager,
				progress,
				signal,
			},
		);
		return outputResult(command.json, result, formatAskText);
	}

	if (command.kind === "run") {
		const runtime = await initPiRuntime({ cwd: command.cwd });
		onRuntime(runtime);
		const result = await runAgentCommand(
			{ ...command, prompt },
			{
				modelRuntime: runtime.modelRuntime,
				settingsManager: runtime.settingsManager,
				agentDir: runtime.agentDir,
				progress,
				signal,
			},
		);
		return outputResult(command.json, result, formatRunText);
	}

	const result = await runSendCommand({ ...command, prompt }, { progress, signal });
	return outputResult(command.json, result, formatRunText);
}

async function dispatchCommand(
	command: ParsedCommand,
	signal: AbortSignal,
	onRuntime: (runtime: PiRuntime) => void,
): Promise<number> {
	const simpleExit = await dispatchSimpleCommand(command, onRuntime);
	if (simpleExit !== undefined) {
		return simpleExit;
	}
	return dispatchExecutionCommand(
		command as Extract<ParsedCommand, { kind: "ask" | "run" | "send" }>,
		signal,
		onRuntime,
	);
}

function resolveErrorExitCode(
	error: unknown,
	isUsage: boolean,
	isAbort: boolean,
	abortState: AbortState,
): number {
	if (isUsage) {
		return (error as CliUsageError).exitCode;
	}
	if (isAbort) {
		return error instanceof CliAbortError ? error.exitCode : abortState.exitCode;
	}
	return 1;
}

function formatCliError(
	error: unknown,
	aborted: boolean,
	abortState: AbortState,
	jsonErrorMode: boolean,
): number {
	const isUsage = error instanceof CliUsageError;
	const isAbort =
		error instanceof CliAbortError ||
		(error instanceof Error && error.name === "AbortError") ||
		aborted;

	const exitCode = resolveErrorExitCode(error, isUsage, isAbort, abortState);
	const rawMessage = error instanceof Error ? error.message : String(error);
	const message = stripTerminalControls(
		isAbort && abortState.reason ? abortState.reason : rawMessage,
	);

	if (jsonErrorMode) {
		const errorType = isUsage ? "usage_error" : isAbort ? "aborted" : "runtime_error";
		writeStdout(formatJson({ error: { type: errorType, message, exitCode } }));
	} else {
		writeStderr(`Error: ${message}`);
	}
	return exitCode;
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
	let jsonErrorMode = wantsJsonOutput(argv);
	let runtime: PiRuntime | undefined;
	let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
	const abortState: AbortState = { exitCode: 130 };
	const abortController = new AbortController();

	const handleSignal = (signalName: "SIGINT" | "SIGTERM") => {
		abortState.exitCode = signalName === "SIGINT" ? 130 : 143;
		abortState.reason = `Interrupted by ${signalName}`;
		abortController.abort(new CliAbortError(abortState.reason, abortState.exitCode));
	};

	const onSigint = () => handleSignal("SIGINT");
	const onSigterm = () => handleSignal("SIGTERM");
	process.on("SIGINT", onSigint);
	process.on("SIGTERM", onSigterm);

	try {
		const command = parseCliArgs(argv, process.cwd());
		if ("json" in command) {
			jsonErrorMode = command.json;
		}
		if ("timeoutSec" in command && command.timeoutSec !== undefined) {
			const timeoutSec = command.timeoutSec;
			timeoutTimer = setTimeout(() => {
				abortState.exitCode = 124;
				abortState.reason = `Timed out after ${timeoutSec}s`;
				abortController.abort(new CliAbortError(abortState.reason, 124));
			}, Math.round(timeoutSec * 1000));
			timeoutTimer.unref();
		}
		return await dispatchCommand(command, abortController.signal, (rt) => {
			runtime = rt;
		});
	} catch (error) {
		return formatCliError(error, abortController.signal.aborted, abortState, jsonErrorMode);
	} finally {
		if (timeoutTimer) {
			clearTimeout(timeoutTimer);
		}
		process.off("SIGINT", onSigint);
		process.off("SIGTERM", onSigterm);
		if (runtime) {
			await runtime.modelRuntime.settleCredentialWrites();
		}
	}
}

function isExecutedDirectly(): boolean {
	if (!process.argv[1]) return false;
	try {
		return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
	} catch {
		return false;
	}
}

if (isExecutedDirectly()) {
	main().then(
		(code) => {
			process.exitCode = code;
		},
		(error) => {
			const message = error instanceof Error ? error.message : String(error);
			writeStderr(`Error: ${message}`);
			process.exitCode = 1;
		},
	);
}
