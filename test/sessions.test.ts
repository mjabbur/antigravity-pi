import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { listAgyPiSessions, openOrCreateSession } from "../src/sessions.js";

function makeUserMessage(text: string, timestamp: number) {
	return {
		role: "user" as const,
		content: text,
		timestamp,
	};
}

describe("sessions", () => {
	const rootTemp = mkdtempSync(join(os.tmpdir(), "agy-pi-sessions-test-"));

	after(() => {
		rmSync(rootTemp, { recursive: true, force: true });
	});

	describe("openOrCreateSession", () => {
		it("creates a new persisted session, persists messages, and reopens by sessionId", () => {
			const sessionDir = join(rootTemp, "create-reopen");
			const cwdA = join(rootTemp, "repo-a");
			const cwdB = join(rootTemp, "repo-b");
			mkdirSync(cwdA, { recursive: true });
			mkdirSync(cwdB, { recursive: true });

			const created = openOrCreateSession({
				cwd: cwdA,
				noSession: false,
				sessionDir,
			});

			assert.equal(created.isPersisted(), true);
			const sessionId = created.getSessionId();
			const sessionFile = created.getSessionFile();
			assert.ok(sessionId.length > 0);
			assert.ok(sessionFile && sessionFile.startsWith(sessionDir));

			// SessionManager flushes to disk once a conversation message is appended.
			created.appendMessage(makeUserMessage("First persisted question", 1_700_000_001_000));
			assert.equal(existsSync(sessionFile), true);

			// Reopen by sessionId with same cwd
			const reopenedSameCwd = openOrCreateSession({
				cwd: cwdA,
				sessionId,
				noSession: false,
				sessionDir,
			});
			assert.equal(reopenedSameCwd.getSessionId(), sessionId);
			assert.equal(reopenedSameCwd.buildSessionContext().messages.length, 1);

			// Reopen by sessionId from a different cwd (exercises findSessionFileByIdInDir fallback)
			const reopenedOtherCwd = openOrCreateSession({
				cwd: cwdB,
				sessionId,
				noSession: false,
				sessionDir,
			});
			assert.equal(reopenedOtherCwd.getSessionId(), sessionId);
			assert.equal(reopenedOtherCwd.buildSessionContext().messages.length, 1);
		});

		it("reopens a session by direct .jsonl path", () => {
			const sessionDir = join(rootTemp, "direct-jsonl");
			const cwd = join(rootTemp, "repo-jsonl");
			mkdirSync(cwd, { recursive: true });

			const created = openOrCreateSession({
				cwd,
				noSession: false,
				sessionDir,
			});
			created.appendMessage(makeUserMessage("Direct file open", 1_700_000_002_000));
			const sessionFile = created.getSessionFile();
			assert.ok(sessionFile);

			const reopened = openOrCreateSession({
				cwd,
				sessionId: sessionFile,
				noSession: false,
				sessionDir,
			});
			assert.equal(reopened.getSessionId(), created.getSessionId());
			assert.equal(reopened.buildSessionContext().messages.length, 1);
		});

		it("creates an in-memory session when noSession is true without writing files", () => {
			const sessionDir = join(rootTemp, "no-session-dir");
			const cwd = join(rootTemp, "repo-mem");
			mkdirSync(cwd, { recursive: true });

			const mem = openOrCreateSession({
				cwd,
				noSession: true,
				sessionDir,
			});
			mem.appendMessage(makeUserMessage("Ephemeral prompt", 1_700_000_003_000));

			assert.equal(mem.isPersisted(), false);
			assert.equal(mem.getSessionFile(), undefined);
			assert.equal(existsSync(sessionDir), false);
		});

		it("throws when reopening a missing sessionId", () => {
			const sessionDir = join(rootTemp, "missing-id-dir");
			const cwd = join(rootTemp, "repo-missing");
			mkdirSync(cwd, { recursive: true });

			assert.throws(
				() =>
					openOrCreateSession({
						cwd,
						sessionId: "non-existent-session-id",
						noSession: false,
						sessionDir,
					}),
				/not found/,
			);
		});
	});

	describe("listAgyPiSessions", () => {
		it("returns [] when sessionDir does not exist or is empty", async () => {
			const nonExistent = join(rootTemp, "never-created-dir");
			assert.deepEqual(await listAgyPiSessions({ limit: 20, sessionDir: nonExistent }), []);

			const emptyDir = join(rootTemp, "empty-sessions-dir");
			mkdirSync(emptyDir, { recursive: true });
			assert.deepEqual(await listAgyPiSessions({ limit: 20, sessionDir: emptyDir }), []);
			assert.equal(readdirSync(emptyDir).length, 0);
		});

		it("lists persisted sessions across multiple different cwd values sorted newest first and respects limit", async () => {
			const sessionDir = join(rootTemp, "multi-cwd-sessions");
			const cwd1 = join(rootTemp, "proj-alpha");
			const cwd2 = join(rootTemp, "proj-beta");
			const cwd3 = join(rootTemp, "proj-gamma");
			mkdirSync(cwd1, { recursive: true });
			mkdirSync(cwd2, { recursive: true });
			mkdirSync(cwd3, { recursive: true });

			const s1 = openOrCreateSession({ cwd: cwd1, noSession: false, sessionDir });
			s1.appendMessage(makeUserMessage("Oldest prompt", 1_700_000_010_000));

			const s2 = openOrCreateSession({ cwd: cwd2, noSession: false, sessionDir });
			s2.appendMessage(makeUserMessage("Middle prompt", 1_700_000_020_000));
			s2.appendSessionInfo("Middle named");

			const s3 = openOrCreateSession({ cwd: cwd3, noSession: false, sessionDir });
			s3.appendMessage(makeUserMessage("Newest prompt", 1_700_000_030_000));

			const all = await listAgyPiSessions({ limit: 20, sessionDir });
			assert.equal(all.length, 3);
			assert.deepEqual(
				all.map((s) => s.id),
				[s3.getSessionId(), s2.getSessionId(), s1.getSessionId()],
			);
			assert.deepEqual(
				all.map((s) => s.cwd),
				[cwd3, cwd2, cwd1],
			);
			assert.equal(all[0].firstMessage, "Newest prompt");
			assert.equal(all[1].name, "Middle named");
			assert.equal(all[2].messageCount, 1);

			const limited = await listAgyPiSessions({ limit: 2, sessionDir });
			assert.equal(limited.length, 2);
			assert.deepEqual(
				limited.map((s) => s.id),
				[s3.getSessionId(), s2.getSessionId()],
			);
		});
	});
});
