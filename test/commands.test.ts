import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
import { runAgentsCommand } from "../src/commands/agents.js";
import { runAskCommand } from "../src/commands/ask.js";
import { runDiffCommand } from "../src/commands/diff.js";
import { runKillCommand } from "../src/commands/kill.js";
import { runLsCommand } from "../src/commands/ls.js";
import { runModelsCommand } from "../src/commands/models.js";
import { runSendCommand } from "../src/commands/send.js";
import { runSessionsCommand } from "../src/commands/sessions.js";
import { formatJson, formatModelsText } from "../src/format.js";
import { ProgressLogger } from "../src/progress.js";
import { CliAbortError } from "../src/runtime.js";
import { openOrCreateSession } from "../src/sessions.js";
import { listSubagents, saveSubagentRecord } from "../src/subagents.js";
import type { SubagentRecord } from "../src/types.js";
import { createWorktree } from "../src/worktree.js";

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

	describe("runAgentsCommand", () => {
		it("discovers user agents and optionally includes project agents", async () => {
			const agentDir = join(tempRoot, "cmd-agents-dir");
			const projectDir = join(tempRoot, "cmd-agents-proj");
			mkdirSync(join(agentDir, "agents"), { recursive: true });
			mkdirSync(join(projectDir, ".pi", "agents"), { recursive: true });

			writeFileSync(
				join(agentDir, "agents", "user-agent.md"),
				["---", "name: user-agent", "description: User profile", "---", "Prompt."].join("\n"),
				"utf8",
			);
			writeFileSync(
				join(projectDir, ".pi", "agents", "proj-agent.md"),
				["---", "name: proj-agent", "description: Project profile", "---", "Prompt."].join("\n"),
				"utf8",
			);

			const userOnly = await runAgentsCommand(
				{ cwd: projectDir, projectAgents: false, json: false },
				{ agentDir },
			);
			assert.deepEqual(
				userOnly.map((a) => a.name),
				["user-agent"],
			);

			const withProject = await runAgentsCommand(
				{ cwd: projectDir, projectAgents: true, json: false },
				{ agentDir },
			);
			assert.deepEqual(
				withProject.map((a) => a.name),
				["proj-agent", "user-agent"],
			);
		});
	});

	describe("runLsCommand", () => {
		it("lists subagents filtered by status and limit", async () => {
			const subagentsDir = join(tempRoot, "cmd-ls-subagents");

			const makeSubagent = (overrides: Partial<SubagentRecord>): SubagentRecord => ({
				id: "sub-1",
				name: "sub-1",
				sessionId: "sess-1",
				model: "anthropic/claude-sonnet-4",
				thinkingLevel: "medium",
				mode: "readonly",
				tools: ["read"],
				cwd: tempRoot,
				effectiveCwd: tempRoot,
				workspace: "inherit",
				status: "idle",
				turns: 1,
				toolCalls: 0,
				tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: 0 },
				cost: 0,
				createdAt: "2026-11-24T10:00:00.000Z",
				updatedAt: "2026-11-24T10:00:00.000Z",
				...overrides,
			});

			saveSubagentRecord(
				makeSubagent({ id: "a", name: "a", status: "idle", updatedAt: "2026-11-24T10:00:00.000Z" }),
				subagentsDir,
			);
			saveSubagentRecord(
				makeSubagent({ id: "b", name: "b", status: "error", updatedAt: "2026-11-24T11:00:00.000Z" }),
				subagentsDir,
			);
			saveSubagentRecord(
				makeSubagent({ id: "c", name: "c", status: "idle", updatedAt: "2026-11-24T12:00:00.000Z" }),
				subagentsDir,
			);

			const all = await runLsCommand({ limit: 10, json: false }, { subagentsDir });
			assert.deepEqual(
				all.map((r) => r.id),
				["c", "b", "a"],
			);

			const idleLimited = await runLsCommand(
				{ status: "idle", limit: 1, json: false },
				{ subagentsDir },
			);
			assert.deepEqual(
				idleLimited.map((r) => r.id),
				["c"],
			);
		});
	});

	describe("runDiffCommand", () => {
		it("throws a clear error when subagent uses inherit workspace", async () => {
			const subagentsDir = join(tempRoot, "cmd-diff-inherit");
			saveSubagentRecord(
				{
					id: "inherit-worker",
					name: "inherit-worker",
					sessionId: "sess-inherit",
					model: "anthropic/claude-sonnet-4",
					thinkingLevel: "medium",
					mode: "readonly",
					tools: ["read"],
					cwd: tempRoot,
					effectiveCwd: tempRoot,
					workspace: "inherit",
					status: "idle",
					turns: 1,
					toolCalls: 0,
					tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: 0 },
					cost: 0,
					createdAt: "2026-11-24T10:00:00.000Z",
					updatedAt: "2026-11-24T10:00:00.000Z",
				},
				subagentsDir,
			);

			await assert.rejects(
				() => runDiffCommand({ target: "inherit-worker", statOnly: false, json: false }, { subagentsDir }),
				/uses workspace "inherit" and has no git worktree to diff/,
			);
		});

		it("returns worktree diff and respects statOnly for worktree subagents", async () => {
			const subagentsDir = join(tempRoot, "cmd-diff-worktree-subs");
			const repoDir = join(tempRoot, "cmd-diff-repo");
			const worktreesDir = join(tempRoot, "cmd-diff-worktrees");

			mkdirSync(repoDir, { recursive: true });
			execFileSync("git", ["-C", repoDir, "init"]);
			execFileSync("git", ["-C", repoDir, "config", "user.name", "Test User"]);
			execFileSync("git", ["-C", repoDir, "config", "user.email", "test@example.com"]);
			writeFileSync(join(repoDir, "file.txt"), "one\n", "utf8");
			execFileSync("git", ["-C", repoDir, "add", "."]);
			execFileSync("git", ["-C", repoDir, "commit", "-m", "init"]);

			const created = await createWorktree({ cwd: repoDir, slug: "diff-sub", worktreesDir });
			writeFileSync(join(created.worktree.path, "file.txt"), "two\n", "utf8");

			saveSubagentRecord(
				{
					id: "wt-worker",
					name: "wt-worker",
					sessionId: "sess-wt",
					model: "anthropic/claude-sonnet-4",
					thinkingLevel: "medium",
					mode: "coder",
					tools: ["read", "edit"],
					cwd: repoDir,
					effectiveCwd: created.effectiveCwd,
					workspace: "worktree",
					worktree: created.worktree,
					status: "idle",
					turns: 1,
					toolCalls: 1,
					tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: 0 },
					cost: 0,
					createdAt: "2026-11-24T10:00:00.000Z",
					updatedAt: "2026-11-24T10:00:00.000Z",
				},
				subagentsDir,
			);

			const full = await runDiffCommand(
				{ target: "wt-worker", statOnly: false, json: false },
				{ subagentsDir },
			);
			assert.equal(full.subagent, "wt-worker");
			assert.equal(full.workspace, "worktree");
			assert.equal(full.hasChanges, true);
			assert.match(full.diffStat, /file\.txt/);
			assert.match(full.diff, /\+two/);

			const statOnly = await runDiffCommand(
				{ target: "wt-worker", statOnly: true, json: false },
				{ subagentsDir },
			);
			assert.equal(statOnly.hasChanges, true);
			assert.match(statOnly.diffStat, /file\.txt/);
			assert.equal(statOnly.diff, "");
		});
	});

	describe("runKillCommand", () => {
		it("removes single subagent record and preserves its JSONL session file", async () => {
			const subagentsDir = join(tempRoot, "cmd-kill-single-subs");
			const sessionDir = join(tempRoot, "cmd-kill-single-sessions");
			const cwd = join(tempRoot, "cmd-kill-single-cwd");
			mkdirSync(cwd, { recursive: true });

			const session = openOrCreateSession({ cwd, noSession: false, sessionDir });
			session.appendMessage({ role: "user", content: "Keep this session", timestamp: 1_700_000_000_000 });
			const sessionFile = session.getSessionFile();
			assert.ok(sessionFile && existsSync(sessionFile));

			saveSubagentRecord(
				{
					id: "kill-one",
					name: "kill-one",
					sessionId: session.getSessionId(),
					sessionFile,
					model: "anthropic/claude-sonnet-4",
					thinkingLevel: "medium",
					mode: "readonly",
					tools: ["read"],
					cwd,
					effectiveCwd: cwd,
					workspace: "inherit",
					status: "idle",
					turns: 1,
					toolCalls: 0,
					tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: 0 },
					cost: 0,
					createdAt: "2026-11-24T10:00:00.000Z",
					updatedAt: "2026-11-24T10:00:00.000Z",
				},
				subagentsDir,
			);

			const killed = await runKillCommand(
				{ target: "kill-one", all: false, force: false, deleteBranch: false, json: false },
				{ subagentsDir },
			);
			assert.equal(killed.length, 1);
			assert.equal(killed[0].id, "kill-one");
			assert.equal(killed[0].sessionId, session.getSessionId());
			assert.deepEqual(listSubagents({ subagentsDir }), []);
			assert.equal(existsSync(sessionFile), true);
		});

		it("kills all subagents with --all and preserves all JSONL session files", async () => {
			const subagentsDir = join(tempRoot, "cmd-kill-all-subs");
			const sessionDir = join(tempRoot, "cmd-kill-all-sessions");
			const cwd = join(tempRoot, "cmd-kill-all-cwd");
			mkdirSync(cwd, { recursive: true });

			const sessionFiles: string[] = [];
			for (const id of ["sub-a", "sub-b"]) {
				const session = openOrCreateSession({ cwd, noSession: false, sessionDir });
				session.appendMessage({ role: "user", content: `Prompt for ${id}`, timestamp: 1_700_000_000_000 });
				const file = session.getSessionFile();
				assert.ok(file && existsSync(file));
				sessionFiles.push(file);

				saveSubagentRecord(
					{
						id,
						name: id,
						sessionId: session.getSessionId(),
						sessionFile: file,
						model: "anthropic/claude-sonnet-4",
						thinkingLevel: "medium",
						mode: "readonly",
						tools: ["read"],
						cwd,
						effectiveCwd: cwd,
						workspace: "inherit",
						status: "idle",
						turns: 1,
						toolCalls: 0,
						tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: 0 },
						cost: 0,
						createdAt: "2026-11-24T10:00:00.000Z",
						updatedAt: "2026-11-24T10:00:00.000Z",
					},
					subagentsDir,
				);
			}

			const results = await runKillCommand(
				{ all: true, force: false, deleteBranch: false, json: false },
				{ subagentsDir },
			);
			assert.equal(results.length, 2);
			assert.deepEqual(listSubagents({ subagentsDir }), []);
			for (const file of sessionFiles) {
				assert.equal(existsSync(file), true);
			}
		});
	});

	describe("runSendCommand", () => {
		it("rejects live running and killed subagents", async () => {
			const subagentsDir = join(tempRoot, "cmd-send-reject-subs");

			saveSubagentRecord(
				{
					id: "live-worker",
					name: "live-worker",
					sessionId: "sess-live",
					model: "anthropic/claude-sonnet-4",
					thinkingLevel: "medium",
					mode: "readonly",
					tools: ["read"],
					cwd: tempRoot,
					effectiveCwd: tempRoot,
					workspace: "inherit",
					pid: process.pid,
					status: "running",
					turns: 1,
					toolCalls: 0,
					tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: 0 },
					cost: 0,
					createdAt: "2026-11-24T10:00:00.000Z",
					updatedAt: "2026-11-24T10:00:00.000Z",
				},
				subagentsDir,
			);

			saveSubagentRecord(
				{
					id: "killed-worker",
					name: "killed-worker",
					sessionId: "sess-killed",
					model: "anthropic/claude-sonnet-4",
					thinkingLevel: "medium",
					mode: "readonly",
					tools: ["read"],
					cwd: tempRoot,
					effectiveCwd: tempRoot,
					workspace: "inherit",
					status: "killed",
					turns: 1,
					toolCalls: 0,
					tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: 0 },
					cost: 0,
					createdAt: "2026-11-24T10:00:00.000Z",
					updatedAt: "2026-11-24T10:00:00.000Z",
				},
				subagentsDir,
			);

			await assert.rejects(
				() =>
					runSendCommand(
						{
							target: "live-worker",
							files: [],
							json: false,
							quiet: true,
							prompt: "Continue",
						},
						{ subagentsDir },
					),
				/is currently running/,
			);

			await assert.rejects(
				() =>
					runSendCommand(
						{
							target: "killed-worker",
							files: [],
							json: false,
							quiet: true,
							prompt: "Continue",
						},
						{ subagentsDir },
					),
				/has been killed/,
			);
		});
	});
});
