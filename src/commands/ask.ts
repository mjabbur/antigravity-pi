import type { AssistantMessage, Context, UserMessage } from "@earendil-works/pi-ai";
import {
	convertToLlm,
	type ModelRuntime,
	type SessionManager,
	type SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { formatPromptWithFiles, loadAttachedFiles } from "../files.js";
import { ProgressLogger } from "../progress.js";
import { CliAbortError, initPiRuntime, resolveTargetModel } from "../runtime.js";
import { openOrCreateSession } from "../sessions.js";
import type { AskResult, ThinkingLevel } from "../types.js";

export interface AskCommandOptions {
	model?: string;
	thinking?: ThinkingLevel;
	system?: string;
	files: string[];
	sessionId?: string;
	noSession: boolean;
	timeoutSec?: number;
	json: boolean;
	quiet: boolean;
	prompt: string;
	cwd?: string;
}

export interface AskCommandDeps {
	modelRuntime?: ModelRuntime;
	settingsManager?: SettingsManager;
	sessionManager?: SessionManager;
	progress?: ProgressLogger;
	signal?: AbortSignal;
	sessionDir?: string;
	agentDir?: string;
}

function extractText(message: AssistantMessage): string {
	return message.content
		.filter((block): block is Extract<AssistantMessage["content"][number], { type: "text" }> => block.type === "text")
		.map((block) => block.text)
		.join("");
}

function extractThinking(message: AssistantMessage): string | undefined {
	const text = message.content
		.filter(
			(block): block is Extract<AssistantMessage["content"][number], { type: "thinking" }> =>
				block.type === "thinking",
		)
		.map((block) => block.thinking)
		.join("\n\n")
		.trim();
	return text.length > 0 ? text : undefined;
}

export async function runAskCommand(
	options: AskCommandOptions,
	deps: AskCommandDeps = {},
): Promise<AskResult> {
	const startedAt = Date.now();
	const cwd = options.cwd ?? process.cwd();
	const progress = deps.progress ?? new ProgressLogger({ quiet: options.quiet });

	if (deps.signal?.aborted) {
		throw new CliAbortError("Request aborted");
	}

	const attachedFiles =
		options.files.length > 0 ? await loadAttachedFiles(options.files, cwd) : [];
	if (attachedFiles.length > 0) {
		progress.log(`attached ${attachedFiles.length} file(s)`);
	}
	const fullPrompt = formatPromptWithFiles(options.prompt, attachedFiles);

	let modelRuntime = deps.modelRuntime;
	let settingsManager = deps.settingsManager;
	if (!modelRuntime || !settingsManager) {
		const runtime = await initPiRuntime({ cwd, agentDir: deps.agentDir });
		modelRuntime ??= runtime.modelRuntime;
		settingsManager ??= runtime.settingsManager;
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
		defaultThinking: "off",
		fallbackSessionModel: sessionContext.model,
	});
	if (warning) {
		progress.log(`warning: ${warning}`);
	}

	const historyMessages = convertToLlm(sessionContext.messages);
	const userMessage: UserMessage = {
		role: "user",
		content: fullPrompt,
		timestamp: Date.now(),
	};

	const context: Context = {
		...(options.system ? { systemPrompt: options.system } : {}),
		messages: [...historyMessages, userMessage],
	};

	progress.log(`ask ${model.provider}/${model.id} (thinking=${thinkingLevel})`);

	const stream = modelRuntime.streamSimple(model, context, {
		reasoning: thinkingLevel === "off" ? undefined : thinkingLevel,
		signal: deps.signal,
		sessionId: options.noSession ? undefined : sessionManager.getSessionId(),
	});

	let finalMessage: AssistantMessage | undefined;
	let thinkingChars = 0;
	let textChars = 0;

	for await (const event of stream) {
		switch (event.type) {
			case "thinking_start":
				progress.log("thinking...");
				break;
			case "thinking_delta":
				thinkingChars += event.delta.length;
				progress.logThrottled(`thinking (${thinkingChars} chars)`);
				break;
			case "text_start":
				progress.log("streaming response...");
				break;
			case "text_delta":
				textChars += event.delta.length;
				progress.logThrottled(`streaming (${textChars} chars)`);
				break;
			case "done":
				finalMessage = event.message;
				break;
			case "error":
				finalMessage = event.error;
				break;
		}
	}

	if (!finalMessage) {
		throw new Error("Model stream ended without a final assistant message.");
	}
	if (finalMessage.stopReason === "aborted") {
		throw new CliAbortError(finalMessage.errorMessage || "Request aborted");
	}
	if (finalMessage.stopReason === "error") {
		throw new Error(finalMessage.errorMessage || "Model request failed.");
	}

	if (!options.noSession) {
		if (
			!sessionContext.model ||
			sessionContext.model.provider !== model.provider ||
			sessionContext.model.modelId !== model.id
		) {
			sessionManager.appendModelChange(model.provider, model.id);
		}
		if (sessionContext.thinkingLevel !== thinkingLevel) {
			sessionManager.appendThinkingLevelChange(thinkingLevel);
		}
		sessionManager.appendMessage(userMessage);
		sessionManager.appendMessage(finalMessage);
	}

	const text = extractText(finalMessage);
	const thinking = extractThinking(finalMessage);

	progress.log("done");

	return {
		text,
		...(thinking ? { thinking } : {}),
		...(options.noSession
			? {}
			: {
					sessionId: sessionManager.getSessionId(),
					sessionFile: sessionManager.getSessionFile(),
			  }),
		provider: model.provider,
		model: model.id,
		thinkingLevel,
		stopReason: finalMessage.stopReason,
		usage: {
			input: finalMessage.usage.input,
			output: finalMessage.usage.output,
			cacheRead: finalMessage.usage.cacheRead,
			cacheWrite: finalMessage.usage.cacheWrite,
			total: finalMessage.usage.totalTokens,
			cost: finalMessage.usage.cost.total,
		},
		durationMs: Date.now() - startedAt,
	};
}
