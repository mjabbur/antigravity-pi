import { resolveSubagent } from "../subagents.js";
import type { RunResult, ThinkingLevel } from "../types.js";
import { runAgentCommand, type RunCommandDeps } from "./run.js";

export interface SendCommandOptions {
	target: string;
	model?: string;
	thinking?: ThinkingLevel;
	files: string[];
	timeoutSec?: number;
	json: boolean;
	quiet: boolean;
	prompt: string;
}

export async function runSendCommand(
	options: SendCommandOptions,
	deps: RunCommandDeps = {},
): Promise<RunResult> {
	const record = resolveSubagent(options.target, deps.subagentsDir);

	if (record.status === "running") {
		throw new Error(
			`Subagent "${record.name}" (${record.id}) is currently running (pid=${record.pid ?? "unknown"}). Wait for it to finish or run 'agy-pi kill ${record.id}'.`,
		);
	}
	if (record.status === "killed") {
		throw new Error(`Subagent "${record.name}" (${record.id}) has been killed.`);
	}

	return runAgentCommand(
		{
			cwd: record.cwd,
			model: options.model ?? record.model,
			thinking: options.thinking ?? record.thinkingLevel,
			mode: record.mode,
			tools: record.tools,
			system: record.systemPrompt,
			workspace: record.workspace,
			files: options.files,
			sessionId: record.sessionFile ?? record.sessionId,
			noSession: false,
			timeoutSec: options.timeoutSec,
			json: options.json,
			quiet: options.quiet,
			prompt: options.prompt,
			existingSubagent: record,
		},
		deps,
	);
}
