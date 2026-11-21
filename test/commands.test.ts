import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { after, describe, it } from "node:test";
import {
	type Api,
	type AssistantMessage,
	type AssistantMessageEventStream,
	type Context,
	createAssistantMessageEventStream,
	type Model,
	type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { type ModelRuntime, SettingsManager } from "@earendil-works/pi-coding-agent";
import { runAskCommand } from "../src/commands/ask.js";
import { runModelsCommand } from "../src/commands/models.js";
import { runSessionsCommand } from "../src/commands/sessions.js";
import { formatJson, formatModelsText } from "../src/format.js";
import { ProgressLogger } from "../src/progress.js";
import { CliAbortError } from "../src/runtime.js";
import { openOrCreateSession } from "../src/sessions.js";

function makeModel(overrides: Partial<Model<Api>> = {}): Model<Api> {
	return {
		id: "claude-sonnet-4",
		name: "Claude Sonnet 4",
		api: "anthropic-messages",
		provider: "anthropic",
		baseUrl: "https://api.anthropic.com",
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
		contextWindow: 200_000,
		maxTokens: 16_000,
		...overrides,
	};
}

function makeAssistantMessage(
	model: Model<Api>,
	overrides: Partial<AssistantMessage> = {},
): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "Hello!" }],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 100,
			output: 25,
			cacheRead: 10,
			cacheWrite: 0,
			totalTokens: 135,
			cost: { input: 0.0003, output: 0.000375, cacheRead: 0.000003, cacheWrite: 0, total: 0.000678 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
		...overrides,
	};
}

function createCaptureLogger(throttleMs = 0): { logger: ProgressLogger; stderrText: () => string } {
	const chunks: string[] = [];
	const stream = new Writable({
		write(chunk, _encoding, callback) {
			chunks.push(typeof chunk === "string" ? chunk : chunk.toString("utf8"));
			callback();
		},
	});
	return {
		logger: new ProgressLogger({ stream, throttleMs }),
		stderrText: () => chunks.join(""),
	};
}

describe("commands", () => {
	const tempRoot = mkdtempSync(join(os.tmpdir(), "agy-pi-commands-test-"));

	after(() => {
		rmSync(tempRoot, { recursive: true, force: true });
	});

	describe("runModelsCommand", () => {
		const models: Model<Api>[] = [
			makeModel({ provider: "openai", id: "gpt-4o", name: "GPT-4o", reasoning: false }),
			makeModel({ provider: "anthropic", id: "claude-sonnet-4", name: "Claude Sonnet 4", reasoning: true }),
			makeModel({ provider: "anthropic", id: "claude-haiku-3", name: "Claude Haiku 3", reasoning: false }),
		];

		const mockRuntime = {
			async getAvailable(provider?: string) {
				return provider ? models.filter((m) => m.provider === provider) : models;
			},
		} as unknown as ModelRuntime;

		it("lists and sorts models and supports query and provider filtering", async () => {
			const all = await runModelsCommand({ refresh: false, json: false }, { modelRuntime: mockRuntime });
			assert.deepEqual(
				all.map((m) => `${m.provider}/${m.id}`),
				["anthropic/claude-haiku-3", "anthropic/claude-sonnet-4", "openai/gpt-4o"],
			);

			const byQuery = await runModelsCommand(
				{ query: "SONNET", refresh: false, json: false },
				{ modelRuntime: mockRuntime },
			);
			assert.deepEqual(
				byQuery.map((m) => `${m.provider}/${m.id}`),
				["anthropic/claude-sonnet-4"],
			);

			const byProvider = await runModelsCommand(
				{ provider: "openai", refresh: false, json: false },
				{ modelRuntime: mockRuntime },
			);
			assert.deepEqual(
				byProvider.map((m) => `${m.provider}/${m.id}`),
				["openai/gpt-4o"],
			);
		});

		it("formats runModelsCommand output cleanly as JSON and text", async () => {
			const result = await runModelsCommand(
				{ provider: "anthropic", refresh: false, json: true },
				{ modelRuntime: mockRuntime },
			);

			const jsonOutput = formatJson(result);
			const parsed = JSON.parse(jsonOutput) as Array<{ provider: string; id: string }>;
			assert.equal(parsed.length, 2);
			assert.equal(parsed[0].id, "claude-haiku-3");

			const textOutput = formatModelsText(result);
			assert.match(textOutput, /anthropic\/claude-haiku-3\s+ctx=200k\s+standard/);
			assert.match(textOutput, /anthropic\/claude-sonnet-4\s+ctx=200k\s+thinking/);
			assert.match(textOutput, /\(2 models\)/);
		});
	});

	describe("runSessionsCommand", () => {
		it("delegates to listAgyPiSessions with limit and sessionDir", async () => {
			const sessionDir = join(tempRoot, "cmd-sessions");
			const cwd = join(tempRoot, "cmd-sessions-cwd");
			mkdirSync(cwd, { recursive: true });

			const s = openOrCreateSession({ cwd, noSession: false, sessionDir });
			s.appendMessage({ role: "user", content: "Via command", timestamp: 1_700_000_000_000 });

			const listed = await runSessionsCommand({ limit: 10, json: true }, { sessionDir });
			assert.equal(listed.length, 1);
			assert.equal(listed[0].id, s.getSessionId());
			assert.equal(listed[0].firstMessage, "Via command");
		});
	});

	describe("runAskCommand", () => {
		it("streams thinking & text events, logs progress to stderr, attaches files, persists session, and supports multi-turn --session resume", async () => {
			const sessionDir = join(tempRoot, "ask-sessions");
			const cwd = join(tempRoot, "ask-cwd");
			mkdirSync(cwd, { recursive: true });
			writeFileSync(join(cwd, "note.txt"), "important context", "utf8");

			const model = makeModel();
			const alternateModel = makeModel({
				provider: "openai",
				id: "gpt-4o",
				name: "GPT-4o",
				api: "openai-responses",
			});
			const allModels = [model, alternateModel];
			const recordedCalls: Array<{
				model: Model<Api>;
				context: Context;
				options?: SimpleStreamOptions;
			}> = [];
			let turnIndex = 0;

			const mockModelRuntime = {
				getModels: () => allModels,
				getModel: (provider: string, id: string) =>
					allModels.find((m) => m.provider === provider && m.id === id),
				hasConfiguredAuth: (provider: string) =>
					provider === model.provider || provider === alternateModel.provider,
				getAvailable: async (provider?: string) =>
					provider ? allModels.filter((m) => m.provider === provider) : allModels,
				streamSimple(
					calledModel: Model<Api>,
					context: Context,
					options?: SimpleStreamOptions,
				): AssistantMessageEventStream {
					turnIndex += 1;
					const currentTurn = turnIndex;
					recordedCalls.push({ model: calledModel, context, options });

					const stream = createAssistantMessageEventStream();
					queueMicrotask(() => {
						const replyText = currentTurn === 1 ? "First answer." : "Second answer.";
						const thinkingText = currentTurn === 1 ? "Analyzing file..." : "Using history...";
						const finalMsg = makeAssistantMessage(calledModel, {
							content: [
								{ type: "thinking", thinking: thinkingText },
								{ type: "text", text: replyText },
							],
						});
						const emptyPartial = makeAssistantMessage(calledModel, { content: [] });

						stream.push({ type: "start", partial: emptyPartial });
						stream.push({ type: "thinking_start", contentIndex: 0, partial: emptyPartial });
						stream.push({
							type: "thinking_delta",
							contentIndex: 0,
							delta: thinkingText,
							partial: emptyPartial,
						});
						stream.push({ type: "text_start", contentIndex: 1, partial: emptyPartial });
						stream.push({
							type: "text_delta",
							contentIndex: 1,
							delta: replyText,
							partial: emptyPartial,
						});
						stream.push({ type: "done", reason: "stop", message: finalMsg });
					});
					return stream;
				},
			} as unknown as ModelRuntime;

			const settingsManager = SettingsManager.inMemory({
				defaultProvider: model.provider,
				defaultModel: model.id,
			});

			// Turn 1: explicitly use alternateModel (openai/gpt-4o) instead of settings default
			const log1 = createCaptureLogger(0);
			const turn1 = await runAskCommand(
				{
					model: "openai/gpt-4o",
					thinking: "high",
					system: "System prompt",
					files: ["note.txt"],
					noSession: false,
					json: false,
					quiet: false,
					prompt: "What is in note.txt?",
					cwd,
				},
				{
					modelRuntime: mockModelRuntime,
					settingsManager,
					progress: log1.logger,
					sessionDir,
				},
			);

			assert.equal(turn1.text, "First answer.");
			assert.equal(turn1.thinking, "Analyzing file...");
			assert.equal(turn1.provider, "openai");
			assert.equal(turn1.model, "gpt-4o");
			assert.equal(turn1.thinkingLevel, "high");
			assert.equal(turn1.stopReason, "stop");
			assert.ok(turn1.sessionId);
			assert.ok(turn1.sessionFile);
			assert.equal(turn1.usage.input, 100);
			assert.equal(turn1.usage.output, 25);

			const stderr1 = log1.stderrText();
			assert.match(stderr1, /attached 1 file\(s\)/);
			assert.match(stderr1, /ask openai\/gpt-4o \(thinking=high\)/);
			assert.match(stderr1, /thinking\.\.\./);
			assert.match(stderr1, /streaming response\.\.\./);
			assert.match(stderr1, /done/);

			assert.equal(recordedCalls[0].context.systemPrompt, "System prompt");
			assert.equal(recordedCalls[0].context.messages.length, 1);
			assert.match(String(recordedCalls[0].context.messages[0].content), /<file path=".*note\.txt">/);
			assert.equal(recordedCalls[0].options?.reasoning, "high");

			// Turn 2: multi-turn resume using --session <id> without --model (restores session model)
			const log2 = createCaptureLogger(0);
			const turn2 = await runAskCommand(
				{
					files: [],
					sessionId: turn1.sessionId,
					noSession: false,
					json: false,
					quiet: false,
					prompt: "Follow up question",
					cwd,
				},
				{
					modelRuntime: mockModelRuntime,
					settingsManager,
					progress: log2.logger,
					sessionDir,
				},
			);

			assert.equal(turn2.sessionId, turn1.sessionId);
			assert.equal(turn2.provider, "openai");
			assert.equal(turn2.model, "gpt-4o");
			assert.equal(turn2.text, "Second answer.");
			assert.equal(turn2.thinking, "Using history...");
			assert.equal(turn2.thinkingLevel, "off");
			// History from turn 1 (user + assistant) + turn 2 user message = 3 messages
			assert.equal(recordedCalls[1].context.messages.length, 3);
			assert.equal(recordedCalls[1].context.messages[1].role, "assistant");
			assert.equal(recordedCalls[1].context.messages[2].role, "user");
			assert.equal(recordedCalls[1].context.messages[2].content, "Follow up question");
		});

		it("handles stream 'error' event by throwing Error", async () => {
			const model = makeModel();
			const settingsManager = SettingsManager.inMemory({
				defaultProvider: model.provider,
				defaultModel: model.id,
			});

			const errorRuntime = {
				getModels: () => [model],
				getModel: (p: string, id: string) => (p === model.provider && id === model.id ? model : undefined),
				hasConfiguredAuth: () => true,
				getAvailable: async () => [model],
				streamSimple(calledModel: Model<Api>): AssistantMessageEventStream {
					const stream = createAssistantMessageEventStream();
					queueMicrotask(() => {
						stream.push({
							type: "error",
							reason: "error",
							error: makeAssistantMessage(calledModel, {
								stopReason: "error",
								errorMessage: "Rate limit exceeded",
							}),
						});
					});
					return stream;
				},
			} as unknown as ModelRuntime;

			await assert.rejects(
				() =>
					runAskCommand(
						{
							files: [],
							noSession: true,
							json: false,
							quiet: true,
							prompt: "Trigger error",
						},
						{ modelRuntime: errorRuntime, settingsManager },
					),
				/Rate limit exceeded/,
			);
		});

		it("handles stream 'aborted' event by throwing CliAbortError", async () => {
			const model = makeModel();
			const settingsManager = SettingsManager.inMemory({
				defaultProvider: model.provider,
				defaultModel: model.id,
			});

			const abortRuntime = {
				getModels: () => [model],
				getModel: (p: string, id: string) => (p === model.provider && id === model.id ? model : undefined),
				hasConfiguredAuth: () => true,
				getAvailable: async () => [model],
				streamSimple(calledModel: Model<Api>): AssistantMessageEventStream {
					const stream = createAssistantMessageEventStream();
					queueMicrotask(() => {
						stream.push({
							type: "error",
							reason: "aborted",
							error: makeAssistantMessage(calledModel, {
								stopReason: "aborted",
								errorMessage: "Stream aborted by upstream",
							}),
						});
					});
					return stream;
				},
			} as unknown as ModelRuntime;

			await assert.rejects(
				() =>
					runAskCommand(
						{
							files: [],
							noSession: true,
							json: false,
							quiet: true,
							prompt: "Trigger abort",
						},
						{ modelRuntime: abortRuntime, settingsManager },
					),
				(err: unknown) =>
					err instanceof CliAbortError &&
					err.exitCode === 130 &&
					/Stream aborted by upstream/.test(err.message),
			);
		});
	});
});
