import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import {
	deleteSubagentRecord,
	generateSubagentId,
	isValidSubagentName,
	listSubagents,
	reconcileStatus,
	resolveSubagent,
	saveSubagentRecord,
} from "../src/subagents.js";
import type { SubagentRecord } from "../src/types.js";

function makeRecord(overrides: Partial<SubagentRecord> = {}): SubagentRecord {
	return {
		id: "sub-123456",
		name: "sub-123456",
		sessionId: "sess-abcdef123456",
		model: "anthropic/claude-sonnet-4",
		thinkingLevel: "medium",
		mode: "readonly",
		tools: ["read", "grep", "find", "ls"],
		cwd: "/repo",
		effectiveCwd: "/repo",
		workspace: "inherit",
		status: "idle",
		turns: 1,
		toolCalls: 2,
		tokens: {
			input: 100,
			output: 50,
			cacheRead: 0,
			cacheWrite: 0,
			total: 150,
			cost: 0.002,
		},
		cost: 0.002,
		createdAt: "2026-11-24T10:00:00.000Z",
		updatedAt: "2026-11-24T10:05:00.000Z",
		...overrides,
	};
}

describe("subagents registry", () => {
	const rootTemp = mkdtempSync(join(os.tmpdir(), "agy-pi-subagents-test-"));

	after(() => {
		rmSync(rootTemp, { recursive: true, force: true });
	});

	describe("isValidSubagentName", () => {
		it("accepts valid subagent names up to 64 characters", () => {
			assert.equal(isValidSubagentName("a"), true);
			assert.equal(isValidSubagentName("worker-1"), true);
			assert.equal(isValidSubagentName("Agent_01.beta"), true);
			assert.equal(isValidSubagentName("a".repeat(64)), true);
		});

		it("rejects empty, invalid-start, invalid-character, or overlong names", () => {
			assert.equal(isValidSubagentName(""), false);
			assert.equal(isValidSubagentName("-worker"), false);
			assert.equal(isValidSubagentName(".worker"), false);
			assert.equal(isValidSubagentName("_worker"), false);
			assert.equal(isValidSubagentName("bad name"), false);
			assert.equal(isValidSubagentName("dir/worker"), false);
			assert.equal(isValidSubagentName("a".repeat(65)), false);
		});
	});

	describe("generateSubagentId", () => {
		it("derives readable IDs from prefix and sessionId or falls back cleanly", () => {
			assert.equal(
				generateSubagentId("Reviewer", "ab12-cd34-ef56"),
				"reviewer-ab12cd",
			);
			const randomId = generateSubagentId("!!!", "ab");
			assert.match(randomId, /^sub-[0-9a-f]{6}$/);

			const longId = generateSubagentId("x".repeat(80), "12345678");
			assert.ok(longId.length <= 64);
		});
	});

	describe("saveSubagentRecord and deleteSubagentRecord", () => {
		it("writes record JSON atomically without leftover tmp files and deletes cleanly", () => {
			const subagentsDir = join(rootTemp, "save-delete");
			const record = makeRecord({ id: "worker-alpha", name: "worker-alpha" });

			const filePath = saveSubagentRecord(record, subagentsDir);
			assert.equal(filePath, join(subagentsDir, "worker-alpha.json"));
			assert.equal(existsSync(filePath), true);
			assert.deepEqual(readdirSync(subagentsDir), ["worker-alpha.json"]);

			// Overwrite existing record cleanly
			saveSubagentRecord({ ...record, turns: 3 }, subagentsDir);
			const loaded = resolveSubagent("worker-alpha", subagentsDir);
			assert.equal(loaded.turns, 3);

			assert.equal(deleteSubagentRecord("worker-alpha", subagentsDir), true);
			assert.equal(existsSync(filePath), false);
			assert.equal(deleteSubagentRecord("worker-alpha", subagentsDir), false);
		});
	});

	describe("reconcileStatus", () => {
		it("keeps running status when process.pid is alive and transitions dead PIDs to idle or error", () => {
			const idleRecord = makeRecord({ status: "idle" });
			assert.deepEqual(reconcileStatus(idleRecord), idleRecord);

			const aliveRecord = makeRecord({ status: "running", pid: process.pid });
			assert.equal(reconcileStatus(aliveRecord).status, "running");
			assert.equal(reconcileStatus(aliveRecord).pid, process.pid);

			const deadPid = 999_999_999;
			const deadClean = reconcileStatus(makeRecord({ status: "running", pid: deadPid }));
			assert.equal(deadClean.status, "idle");
			assert.equal(deadClean.pid, undefined);

			const deadWithError = reconcileStatus(
				makeRecord({ status: "running", pid: deadPid, lastError: "Timed out" }),
			);
			assert.equal(deadWithError.status, "error");
			assert.equal(deadWithError.pid, undefined);
		});
	});

	describe("listSubagents", () => {
		it("sorts newest first, reconciles statuses, skips malformed files, and applies status and limit filters", () => {
			const subagentsDir = join(rootTemp, "list-filter");
			mkdirSync(subagentsDir, { recursive: true });

			writeFileSync(join(subagentsDir, "corrupt.json"), "{invalid json", "utf8");
			writeFileSync(join(subagentsDir, "ignored.txt"), "hello", "utf8");

			saveSubagentRecord(
				makeRecord({
					id: "oldest",
					name: "oldest",
					status: "idle",
					updatedAt: "2026-11-24T08:00:00.000Z",
				}),
				subagentsDir,
			);
			saveSubagentRecord(
				makeRecord({
					id: "live",
					name: "live",
					status: "running",
					pid: process.pid,
					updatedAt: "2026-11-24T09:00:00.000Z",
				}),
				subagentsDir,
			);
			saveSubagentRecord(
				makeRecord({
					id: "stale-running",
					name: "stale-running",
					status: "running",
					pid: 999_999_999,
					updatedAt: "2026-11-24T10:00:00.000Z",
				}),
				subagentsDir,
			);

			const all = listSubagents({ subagentsDir });
			assert.deepEqual(
				all.map((r) => `${r.id}:${r.status}`),
				["stale-running:idle", "live:running", "oldest:idle"],
			);

			const idleOnly = listSubagents({ subagentsDir, status: "idle", limit: 1 });
			assert.equal(idleOnly.length, 1);
			assert.equal(idleOnly[0].id, "stale-running");

			const runningOnly = listSubagents({ subagentsDir, status: "running" });
			assert.deepEqual(
				runningOnly.map((r) => r.id),
				["live"],
			);
		});
	});

	describe("resolveSubagent", () => {
		it("resolves by exact id, name, sessionId, and unique prefix, and errors on ambiguous or missing identifiers", () => {
			const subagentsDir = join(rootTemp, "resolve-cases");

			saveSubagentRecord(
				makeRecord({
					id: "alpha-111111",
					name: "worker-one",
					sessionId: "sess-1111-aaaa",
					updatedAt: "2026-11-24T10:00:00.000Z",
				}),
				subagentsDir,
			);
			saveSubagentRecord(
				makeRecord({
					id: "beta-222222",
					name: "dup-name",
					sessionId: "sess-2222-bbbb",
					updatedAt: "2026-11-24T10:01:00.000Z",
				}),
				subagentsDir,
			);
			saveSubagentRecord(
				makeRecord({
					id: "gamma-333333",
					name: "dup-name",
					sessionId: "sess-2222-cccc",
					updatedAt: "2026-11-24T10:02:00.000Z",
				}),
				subagentsDir,
			);

			assert.equal(resolveSubagent("alpha-111111", subagentsDir).id, "alpha-111111");
			assert.equal(resolveSubagent("worker-one", subagentsDir).id, "alpha-111111");
			assert.equal(resolveSubagent("sess-1111-aaaa", subagentsDir).id, "alpha-111111");
			assert.equal(resolveSubagent("alpha-", subagentsDir).id, "alpha-111111");
			assert.equal(resolveSubagent("sess-1111", subagentsDir).id, "alpha-111111");

			assert.throws(
				() => resolveSubagent("dup-name", subagentsDir),
				/Ambiguous subagent name "dup-name"/,
			);
			assert.throws(
				() => resolveSubagent("sess-2222", subagentsDir),
				/Ambiguous subagent identifier "sess-2222"/,
			);
			assert.throws(
				() => resolveSubagent("missing-id", subagentsDir),
				/Subagent "missing-id" not found/,
			);
			assert.throws(
				() => resolveSubagent("", subagentsDir),
				/Subagent "" not found/,
			);
		});
	});
});
