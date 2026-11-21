import assert from "node:assert/strict";
import { Writable } from "node:stream";
import { describe, it } from "node:test";
import {
	formatAskText,
	formatCost,
	formatJson,
	formatModelsText,
	formatRunText,
	formatSessionsText,
	formatTokens,
} from "../src/format.js";
import { ProgressLogger, summarizeToolArgs } from "../src/progress.js";
import type { AskResult, ModelSummary, RunResult, SessionSummary } from "../src/types.js";

function createCaptureStream(): { stream: Writable; output: () => string } {
	const chunks: string[] = [];
	const stream = new Writable({
		write(chunk, _encoding, callback) {
			chunks.push(typeof chunk === "string" ? chunk : chunk.toString("utf8"));
			callback();
		},
	});
	return {
		stream,
		output: () => chunks.join(""),
	};
}

describe("format helpers", () => {
	it("formats token counts across ranges", () => {
		assert.equal(formatTokens(0), "0");
		assert.equal(formatTokens(-10), "0");
		assert.equal(formatTokens(Number.NaN), "0");
		assert.equal(formatTokens(42), "42");
		assert.equal(formatTokens(999), "999");
		assert.equal(formatTokens(1000), "1k");
		assert.equal(formatTokens(1500), "1.5k");
		assert.equal(formatTokens(12_400), "12k");
		assert.equal(formatTokens(999_499), "999k");
		assert.equal(formatTokens(1_000_000), "1M");
		assert.equal(formatTokens(2_500_000), "2.5M");
	});

	it("formats costs accurately", () => {
		assert.equal(formatCost(0), "$0");
		assert.equal(formatCost(-0.5), "$0");
		assert.equal(formatCost(Number.NaN), "$0");
		assert.equal(formatCost(0.00124), "$0.0012");
		assert.equal(formatCost(0.0099), "$0.0099");
		assert.equal(formatCost(0.01), "$0.01");
		assert.equal(formatCost(1.236), "$1.24");
	});

	it("formats JSON with 2-space indentation", () => {
		const value = { ok: true, count: 2 };
		assert.equal(formatJson(value), JSON.stringify(value, null, 2));
	});

	it("formats models list in text mode", () => {
		assert.equal(formatModelsText([]), "No available models found.");

		const single: ModelSummary[] = [
			{
				provider: "anthropic",
				id: "claude-sonnet-4",
				name: "Claude Sonnet 4",
				reasoning: true,
				contextWindow: 200_000,
				maxTokens: 16_000,
				costInput: 3,
				costOutput: 15,
				inputModalities: ["text", "image"],
			},
		];
		assert.equal(
			formatModelsText(single),
			"anthropic/claude-sonnet-4  ctx=200k  thinking  price=$3/$15\n\n(1 model)",
		);

		const multiple: ModelSummary[] = [
			...single,
			{
				provider: "openai",
				id: "gpt-4o-mini",
				name: "GPT-4o mini",
				reasoning: false,
				contextWindow: 128_000,
				maxTokens: 16_384,
				costInput: 0.15,
				costOutput: 0.6,
				inputModalities: ["text"],
			},
		];
		assert.equal(
			formatModelsText(multiple),
			[
				"anthropic/claude-sonnet-4  ctx=200k  thinking  price=$3/$15",
				"openai/gpt-4o-mini  ctx=128k  standard  price=$0.15/$0.6",
				"",
				"(2 models)",
			].join("\n"),
		);
	});

	it("formats sessions list in text mode", () => {
		assert.equal(formatSessionsText([]), "No sessions found.");

		const longFirstMessage = `Line 1\nLine 2 ${"x".repeat(80)}`;
		const sessions: SessionSummary[] = [
			{
				id: "sess-1",
				path: "/tmp/s1.jsonl",
				cwd: "/repo/a",
				name: "Audit",
				created: "2026-11-21T10:00:00.000Z",
				modified: "2026-11-21T10:05:30.123Z",
				messageCount: 4,
				firstMessage: longFirstMessage,
			},
			{
				id: "sess-2",
				path: "/tmp/s2.jsonl",
				cwd: "/repo/b",
				created: "2026-11-21T09:00:00.000Z",
				modified: "2026-11-21T09:01:00.000Z",
				messageCount: 2,
				firstMessage: "Hello",
			},
		];

		const formatted = formatSessionsText(sessions);
		const lines = formatted.split("\n");
		assert.equal(lines.length, 2);
		assert.ok(lines[0].startsWith('sess-1  2026-11-21 10:05:30  msgs=4  cwd=/repo/a  "Audit — Line 1 Line 2 '));
		assert.equal(lines[1], 'sess-2  2026-11-21 09:01:00  msgs=2  cwd=/repo/b  "Hello"');
	});

	it("formats ask results with and without sessionId", () => {
		const base: AskResult = {
			text: "Looks clean.",
			provider: "openai",
			model: "gpt-5",
			thinkingLevel: "medium",
			stopReason: "stop",
			usage: {
				input: 1500,
				output: 250,
				cacheRead: 0,
				cacheWrite: 0,
				total: 1750,
				cost: 0.0045,
			},
			durationMs: 120,
		};

		assert.equal(
			formatAskText({ ...base, sessionId: "abc-123" }),
			"Looks clean.\n\n[agy-pi] session=abc-123 model=openai/gpt-5 thinking=medium tokens=1.5k/250 cost=$0.0045",
		);
		assert.equal(
			formatAskText(base),
			"Looks clean.\n\n[agy-pi] model=openai/gpt-5 thinking=medium tokens=1.5k/250 cost=$0.0045",
		);
	});

	it("formats run results with and without sessionId", () => {
		const base: RunResult = {
			text: "All tests pass.",
			provider: "anthropic",
			model: "claude-sonnet",
			thinkingLevel: "high",
			mode: "readonly",
			cwd: "/repo",
			toolsUsed: [],
			toolCallsCount: 3,
			turns: 2,
			usage: {
				input: 12_400,
				output: 800,
				cacheRead: 0,
				cacheWrite: 0,
				total: 13_200,
				cost: 0.123,
			},
			durationMs: 500,
		};

		assert.equal(
			formatRunText({ ...base, sessionId: "run-9" }),
			"All tests pass.\n\n[agy-pi] session=run-9 model=anthropic/claude-sonnet mode=readonly tools=3 tokens=12k/800 cost=$0.12",
		);
		assert.equal(
			formatRunText(base),
			"All tests pass.\n\n[agy-pi] model=anthropic/claude-sonnet mode=readonly tools=3 tokens=12k/800 cost=$0.12",
		);
	});
});

describe("ProgressLogger", () => {
	it("writes single-line elapsed-prefixed logs and skips blank messages", () => {
		let nowMs = 10_000;
		const { stream, output } = createCaptureStream();
		const logger = new ProgressLogger({ stream, now: () => nowMs });

		logger.log("  hello\n   world  ");
		logger.log("   \n\t  ");
		nowMs += 65_000;
		logger.log("done");

		assert.equal(
			output(),
			"[agy-pi 00:00] hello world\n[agy-pi 01:05] done\n",
		);
	});

	it("suppresses all output when quiet is true", () => {
		let nowMs = 0;
		const { stream, output } = createCaptureStream();
		const logger = new ProgressLogger({ stream, quiet: true, now: () => nowMs });

		logger.log("starting");
		logger.logThrottled("streaming");
		nowMs += 10_000;
		logger.logThrottled("still streaming");

		assert.equal(output(), "");
	});

	it("throttles logThrottled calls within throttleMs", () => {
		let nowMs = 1_000;
		const { stream, output } = createCaptureStream();
		const logger = new ProgressLogger({ stream, throttleMs: 3000, now: () => nowMs });

		logger.logThrottled("first");
		nowMs += 1000;
		logger.logThrottled("dropped-1");
		nowMs += 1999;
		logger.logThrottled("dropped-2");
		nowMs += 1;
		logger.logThrottled("second");

		assert.equal(
			output(),
			"[agy-pi 00:00] first\n[agy-pi 00:03] second\n",
		);
	});
});

describe("summarizeToolArgs", () => {
	it("summarizes known tool arguments", () => {
		assert.equal(summarizeToolArgs("read", { path: "src/cli.ts" }), "src/cli.ts");
		assert.equal(summarizeToolArgs("read", { file_path: "src/cli.ts", offset: 10 }), "src/cli.ts:10");
		assert.equal(
			summarizeToolArgs("read", { path: "src/cli.ts", offset: 10, limit: 20 }),
			"src/cli.ts:10-29",
		);
		assert.equal(summarizeToolArgs("edit", { path: "src/args.ts" }), "src/args.ts");
		assert.equal(summarizeToolArgs("write", { file_path: "test/a.ts" }), "test/a.ts");
		assert.equal(summarizeToolArgs("grep", { pattern: "CliUsageError" }), "/CliUsageError/");
		assert.equal(
			summarizeToolArgs("grep", { pattern: "foo", path: "src" }),
			"/foo/ in src",
		);
		assert.equal(summarizeToolArgs("find", { pattern: "*.ts", path: "src" }), "*.ts in src");
		assert.equal(summarizeToolArgs("find", {}), "*");
		assert.equal(summarizeToolArgs("ls", {}), ".");
		assert.equal(summarizeToolArgs("ls", { path: "src/commands" }), "src/commands");
		assert.equal(summarizeToolArgs("bash", { command: "npm\n  test" }), "npm test");
	});

	it("summarizes unknown tool objects and non-object values", () => {
		assert.equal(summarizeToolArgs("custom", { a: 1, b: "ok" }), '{"a":1,"b":"ok"}');
		assert.equal(summarizeToolArgs("custom", { long: "x".repeat(120) }).length, 80);
		assert.ok(summarizeToolArgs("custom", { long: "x".repeat(120) }).endsWith("..."));
		assert.equal(summarizeToolArgs("custom", undefined), "");
		assert.equal(summarizeToolArgs("custom", null), "null");
		assert.equal(summarizeToolArgs("custom", "raw"), "raw");
	});
});
