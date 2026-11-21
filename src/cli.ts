#!/usr/bin/env node
import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { CliUsageError, HELP_TEXT, parseCliArgs } from "./args.js";
import { runAskCommand } from "./commands/ask.js";
import { runModelsCommand } from "./commands/models.js";
import { runAgentCommand } from "./commands/run.js";
import { runSessionsCommand } from "./commands/sessions.js";
import { resolvePromptInput } from "./files.js";
import {
	formatAskText,
	formatJson,
	formatModelsText,
	formatRunText,
	formatSessionsText,
} from "./format.js";
import { ProgressLogger } from "./progress.js";
import { CliAbortError, initPiRuntime, type PiRuntime } from "./runtime.js";

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

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
	let jsonErrorMode = wantsJsonOutput(argv);
	let runtime: PiRuntime | undefined;
	let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
	let abortExitCode = 130;
	let abortReason: string | undefined;

	const abortController = new AbortController();

	const handleSignal = (signalName: "SIGINT" | "SIGTERM") => {
		abortExitCode = signalName === "SIGINT" ? 130 : 143;
		abortReason = `Interrupted by ${signalName}`;
		abortController.abort(new CliAbortError(abortReason, abortExitCode));
	};

	const onSigint = () => handleSignal("SIGINT");
	const onSigterm = () => handleSignal("SIGTERM");
	process.on("SIGINT", onSigint);
	process.on("SIGTERM", onSigterm);

	try {
		const command = parseCliArgs(argv, process.cwd());

		if (command.kind === "help") {
			writeStdout(HELP_TEXT);
			return 0;
		}
		if (command.kind === "version") {
			writeStdout(`agy-pi ${readCliVersion()}`);
			return 0;
		}

		jsonErrorMode = command.json;

		if (command.kind === "sessions") {
			const sessions = await runSessionsCommand({
				limit: command.limit,
				json: command.json,
			});
			writeStdout(command.json ? formatJson(sessions) : formatSessionsText(sessions));
			return 0;
		}

		if (command.kind === "models") {
			runtime = await initPiRuntime({ refresh: command.refresh });
			const models = await runModelsCommand(
				{
					query: command.query,
					provider: command.provider,
					refresh: command.refresh,
					json: command.json,
				},
				{ modelRuntime: runtime.modelRuntime },
			);
			writeStdout(command.json ? formatJson(models) : formatModelsText(models));
			return 0;
		}

		if (command.timeoutSec !== undefined) {
			timeoutTimer = setTimeout(() => {
				abortExitCode = 124;
				abortReason = `Timed out after ${command.timeoutSec}s`;
				abortController.abort(new CliAbortError(abortReason, 124));
			}, Math.round(command.timeoutSec * 1000));
			timeoutTimer.unref();
		}

		if (command.kind === "ask") {
			const prompt = await resolvePromptInput(command.prompt);
			const progress = new ProgressLogger({ quiet: command.quiet });
			runtime = await initPiRuntime({ cwd: process.cwd() });

			const result = await runAskCommand(
				{ ...command, prompt },
				{
					modelRuntime: runtime.modelRuntime,
					settingsManager: runtime.settingsManager,
					progress,
					signal: abortController.signal,
				},
			);
			writeStdout(command.json ? formatJson(result) : formatAskText(result));
			return 0;
		}

		if (command.kind === "run") {
			const prompt = await resolvePromptInput(command.prompt);
			const progress = new ProgressLogger({ quiet: command.quiet });
			runtime = await initPiRuntime({ cwd: command.cwd });

			const result = await runAgentCommand(
				{ ...command, prompt },
				{
					modelRuntime: runtime.modelRuntime,
					settingsManager: runtime.settingsManager,
					agentDir: runtime.agentDir,
					progress,
					signal: abortController.signal,
				},
			);
			writeStdout(command.json ? formatJson(result) : formatRunText(result));
			return 0;
		}

		return 0;
	} catch (error) {
		const isUsage = error instanceof CliUsageError;
		const isAbort =
			error instanceof CliAbortError ||
			(error instanceof Error && error.name === "AbortError") ||
			abortController.signal.aborted;

		const exitCode = isUsage
			? error.exitCode
			: isAbort
				? error instanceof CliAbortError
					? error.exitCode
					: abortExitCode
				: 1;

		const message =
			isAbort && abortReason
				? abortReason
				: error instanceof Error
					? error.message
					: String(error);

		if (jsonErrorMode) {
			writeStdout(
				formatJson({
					error: {
						type: isUsage ? "usage_error" : isAbort ? "aborted" : "runtime_error",
						message,
						exitCode,
					},
				}),
			);
		} else {
			writeStderr(`Error: ${message}`);
		}
		return exitCode;
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
