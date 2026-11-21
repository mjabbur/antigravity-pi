import { statSync } from "node:fs";
import { resolve } from "node:path";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
	createAgentSession,
	DefaultResourceLoader,
	type ModelRuntime,
	type ResourceLoader,
	type SessionManager,
	type SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { ProgressLogger, summarizeToolArgs } from "../progress.js";
import { CliAbortError, initPiRuntime, resolveTargetModel } from "../runtime.js";
import { openOrCreateSession } from "../sessions.js";
import type { RunMode, RunResult, ThinkingLevel, ToolExecutionSummary } from "../types.js";

export interface RunCommandOptions {
	model?: string;
	thinking?: ThinkingLevel;
	mode: RunMode;
	cwd: string;
	system?: string;
	sessionId?: string;
	noSession: boolean;
	timeoutSec?: number;
	json: boolean;
	quiet: boolean;
	prompt: string;
}

export interface RunCommandDeps {
	modelRuntime?: ModelRuntime;
	settingsManager?: SettingsManager;
	sessionManager?: SessionManager;
	resourceLoader?: ResourceLoader;
	progress?: ProgressLogger;
	signal?: AbortSignal;
	sessionDir?: string;
	agentDir?: string;
}

const MODE_TOOLS: Record<RunMode, string[]> = {
	readonly: ["read", "grep", "find", "ls"],
	coder: ["read", "bash", "edit", "write", "grep", "find", "ls"],
};

function assertDirectoryExists(dirPath: string): void {
	let stats;
	try {
		stats = statSync(dirPath);
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		throw new Error(`Working directory does not exist: ${dirPath} (${detail})`);
	}
	if (!stats.isDirectory()) {
		throw new Error(`Working directory path is not a directory: ${dirPath}`);
	}
}

function extractAssistantText(message: AssistantMessage | undefined): string {
	if (!message) return "";
	return message.content
		.filter((block): block is Extract<AssistantMessage["content"][number], { type: "text" }> => block.type === "text")
		.map((block) => block.text)
		.join("");
}

export async function runAgentCommand(
	options: RunCommandOptions,
	deps: RunCommandDeps = {},
): Promise<RunResult> {
	const startedAt = Date.now();
	const cwd = resolve(options.cwd);
	assertDirectoryExists(cwd);

	const progress = deps.progress ?? new ProgressLogger({ quiet: options.quiet });
	if (deps.signal?.aborted) {
		throw new CliAbortError("Run aborted");
	}

	let modelRuntime = deps.modelRuntime;
	let settingsManager = deps.settingsManager;
	let agentDir = deps.agentDir;

	if (!modelRuntime || !settingsManager || !agentDir) {
		const runtime = await initPiRuntime({ cwd, agentDir: deps.agentDir });
		modelRuntime ??= runtime.modelRuntime;
		settingsManager ??= runtime.settingsManager;
		agentDir ??= runtime.agentDir;
	}

	const sessionManager =
		deps.sessionManager ??
		openOrCreateSession({
			cwd,
			sessionId: options.sessionId,
			noSession: options.noSession,
			sessionDir: deps.sessionDir,
		});

	const sessionContext = sessionManager.buildSessionContext();
	const { model, thinkingLevel, warning } = await resolveTargetModel({
		modelRuntime,
		settingsManager,
		modelSpec: options.model,
		thinking: options.thinking,
		defaultThinking: "medium",
		fallbackSessionModel: sessionContext.model,
	});
	if (warning) {
		progress.log(`warning: ${warning}`);
	}

	let resourceLoader = deps.resourceLoader;
	if (!resourceLoader) {
		const loader = new DefaultResourceLoader({
			cwd,
			agentDir,
			settingsManager,
			noExtensions: true,
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
			appendSystemPrompt: options.system ? [options.system] : undefined,
		});
		await loader.reload();
		resourceLoader = loader;
	}

	const tools = MODE_TOOLS[options.mode];
	const { session } = await createAgentSession({
		cwd,
		agentDir,
		modelRuntime,
		model,
		thinkingLevel,
		tools,
		resourceLoader,
		sessionManager,
		settingsManager,
	});

	const toolsUsed: ToolExecutionSummary[] = [];
	const pendingArgs = new Map<string, string>();
	let turns = 0;
	let lastAssistant: AssistantMessage | undefined;
	let textChars = 0;
	let thinkingChars = 0;
	let wasAborted = false;

	const usageTotals = {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		total: 0,
		cost: 0,
	};

	const unsubscribe = session.subscribe((event) => {
		switch (event.type) {
			case "turn_start":
				turns += 1;
				textChars = 0;
				thinkingChars = 0;
				progress.log(`turn ${turns} started`);
				break;

			case "message_update": {
				const sub = event.assistantMessageEvent;
				if (sub.type === "thinking_delta") {
					thinkingChars += sub.delta.length;
					progress.logThrottled(`turn ${turns} thinking (${thinkingChars} chars)`);
				} else if (sub.type === "text_delta") {
					textChars += sub.delta.length;
					progress.logThrottled(`turn ${turns} streaming (${textChars} chars)`);
				}
				break;
			}

			case "message_end":
				if (event.message.role === "assistant") {
					const msg = event.message as AssistantMessage;
					lastAssistant = msg;
					usageTotals.input += msg.usage.input;
					usageTotals.output += msg.usage.output;
					usageTotals.cacheRead += msg.usage.cacheRead;
					usageTotals.cacheWrite += msg.usage.cacheWrite;
					usageTotals.total += msg.usage.totalTokens;
					usageTotals.cost += msg.usage.cost.total;
				}
				break;

			case "tool_execution_start": {
				const argsSummary = summarizeToolArgs(event.toolName, event.args);
				pendingArgs.set(event.toolCallId, argsSummary);
				progress.log(
					argsSummary
						? `tool ${event.toolName}: ${argsSummary}`
						: `tool ${event.toolName}`,
				);
				break;
			}

			case "tool_execution_end": {
				const argsSummary = pendingArgs.get(event.toolCallId) ?? "";
				pendingArgs.delete(event.toolCallId);
				toolsUsed.push({
					toolCallId: event.toolCallId,
					toolName: event.toolName,
					argsSummary,
					isError: event.isError,
					...(event.durationMs !== undefined ? { durationMs: event.durationMs } : {}),
				});
				const status = event.isError ? "error" : "ok";
				const timing =
					event.durationMs !== undefined ? ` (${Math.round(event.durationMs)}ms)` : "";
				progress.log(`tool ${event.toolName} ${status}${timing}`);
				break;
			}

			case "auto_retry_start":
				progress.log(
					`retrying (${event.attempt}/${event.maxAttempts}): ${event.errorMessage}`,
				);
				break;

			case "compaction_start":
				progress.log(`compacting context (${event.reason})`);
				break;
		}
	});

	const onAbort = () => {
		wasAborted = true;
		progress.log("aborting...");
		void session.abort();
	};

	if (deps.signal) {
		if (deps.signal.aborted) {
			onAbort();
		} else {
			deps.signal.addEventListener("abort", onAbort, { once: true });
		}
	}

	try {
		progress.log(
			`run ${model.provider}/${model.id} (mode=${options.mode}, thinking=${thinkingLevel})`,
		);
		await session.prompt(options.prompt);
		await session.waitForIdle();

		const finalAssistant =
			lastAssistant ??
			([...session.messages]
				.reverse()
				.find((msg): msg is AssistantMessage => msg.role === "assistant"));

		if (wasAborted || deps.signal?.aborted || finalAssistant?.stopReason === "aborted") {
			throw new CliAbortError(finalAssistant?.errorMessage || "Run aborted");
		}
		if (finalAssistant?.stopReason === "error") {
			throw new Error(finalAssistant.errorMessage || "Agent run failed.");
		}

		const text = session.getLastAssistantText() ?? extractAssistantText(finalAssistant);
		progress.log(`done (${turns} turn${turns === 1 ? "" : "s"}, ${toolsUsed.length} tool call${toolsUsed.length === 1 ? "" : "s"})`);

		return {
			text,
			...(options.noSession
				? {}
				: {
						sessionId: sessionManager.getSessionId(),
						sessionFile: sessionManager.getSessionFile(),
				  }),
			provider: model.provider,
			model: model.id,
			thinkingLevel,
			mode: options.mode,
			cwd,
			toolsUsed,
			toolCallsCount: toolsUsed.length,
			turns,
			usage: usageTotals,
			durationMs: Date.now() - startedAt,
		};
	} finally {
		deps.signal?.removeEventListener("abort", onAbort);
		unsubscribe();
		session.dispose();
	}
}
