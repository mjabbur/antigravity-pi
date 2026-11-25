import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import {
	createWorktree,
	getWorktreeDiff,
	removeWorktree,
	sanitizeSlug,
} from "../src/worktree.js";

function git(cwd: string, args: string[]): string {
	return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
}

function initGitRepo(repoDir: string): string {
	mkdirSync(repoDir, { recursive: true });
	git(repoDir, ["init"]);
	git(repoDir, ["config", "user.name", "Test User"]);
	git(repoDir, ["config", "user.email", "test@example.com"]);
	writeFileSync(join(repoDir, "README.md"), "initial\n", "utf8");
	mkdirSync(join(repoDir, "packages", "app"), { recursive: true });
	writeFileSync(join(repoDir, "packages", "app", "index.ts"), "export const v = 1;\n", "utf8");
	git(repoDir, ["add", "."]);
	git(repoDir, ["commit", "-m", "initial commit"]);
	return git(repoDir, ["rev-parse", "HEAD"]);
}

describe("worktree", () => {
	const rootTemp = mkdtempSync(join(os.tmpdir(), "agy-pi-worktree-test-"));

	after(() => {
		rmSync(rootTemp, { recursive: true, force: true });
	});

	describe("sanitizeSlug", () => {
		it("normalizes slugs, strips invalid chars, truncates, and falls back to subagent", () => {
			assert.equal(sanitizeSlug("Feature/Add Auth!"), "feature-add-auth");
			assert.equal(sanitizeSlug("___my--slug___"), "my-slug");
			assert.equal(sanitizeSlug("!!!"), "subagent");
			assert.equal(sanitizeSlug(""), "subagent");
			assert.equal(sanitizeSlug("a".repeat(60)).length, 48);
		});
	});

	describe("createWorktree", () => {
		it("creates an isolated worktree and branch, preserves nested cwd subpath, and handles slug collisions", async () => {
			const repoDir = join(rootTemp, "repo-create");
			const worktreesDir = join(rootTemp, "worktrees-create");
			const headCommit = initGitRepo(repoDir);

			const nestedCwd = join(repoDir, "packages", "app");
			const first = await createWorktree({
				cwd: nestedCwd,
				slug: "worker",
				worktreesDir,
			});

			assert.equal(first.worktree.repoRoot, realpathSync(repoDir));
			assert.equal(first.worktree.branch, "agy-pi/worker");
			assert.equal(first.worktree.baseCommit, headCommit);
			assert.equal(existsSync(first.worktree.path), true);
			assert.equal(first.effectiveCwd, join(first.worktree.path, "packages", "app"));
			assert.equal(existsSync(join(first.effectiveCwd, "index.ts")), true);

			// Creating a second worktree with the same slug avoids collision
			const second = await createWorktree({
				cwd: repoDir,
				slug: "worker",
				worktreesDir,
			});

			assert.notEqual(second.worktree.path, first.worktree.path);
			assert.notEqual(second.worktree.branch, first.worktree.branch);
			assert.match(second.worktree.branch, /^agy-pi\/worker-[0-9a-f]{6}$/);
			assert.equal(existsSync(second.worktree.path), true);
		});

		it("throws when cwd is not a git repository or has an unborn HEAD", async () => {
			const nonGitDir = join(rootTemp, "non-git");
			const worktreesDir = join(rootTemp, "worktrees-errors");
			mkdirSync(nonGitDir, { recursive: true });

			await assert.rejects(
				() => createWorktree({ cwd: nonGitDir, slug: "test", worktreesDir }),
				/not inside a git repository/,
			);

			const unbornRepo = join(rootTemp, "unborn-repo");
			mkdirSync(unbornRepo, { recursive: true });
			git(unbornRepo, ["init"]);

			await assert.rejects(
				() => createWorktree({ cwd: unbornRepo, slug: "test", worktreesDir }),
				/no commits \(HEAD is unborn\)/,
			);
		});
	});

	describe("getWorktreeDiff", () => {
		it("detects clean state, uncommitted edits, and committed changes relative to baseCommit", async () => {
			const repoDir = join(rootTemp, "repo-diff");
			const worktreesDir = join(rootTemp, "worktrees-diff");
			initGitRepo(repoDir);

			const created = await createWorktree({
				cwd: repoDir,
				slug: "diff-worker",
				worktreesDir,
			});

			const clean = await getWorktreeDiff(created.worktree.path, created.worktree.baseCommit);
			assert.equal(clean.hasChanges, false);
			assert.equal(clean.commitsAhead, 0);
			assert.equal(clean.statusShort, "");
			assert.equal(clean.diffStat, "");
			assert.equal(clean.diff, "");

			// Uncommitted tracked edit + untracked file
			writeFileSync(join(created.worktree.path, "README.md"), "updated\n", "utf8");
			writeFileSync(join(created.worktree.path, "extra.txt"), "new file\n", "utf8");

			const dirty = await getWorktreeDiff(created.worktree.path, created.worktree.baseCommit);
			assert.equal(dirty.hasChanges, true);
			assert.equal(dirty.commitsAhead, 0);
			assert.match(dirty.statusShort, /M README\.md/);
			assert.match(dirty.statusShort, /\?\? extra\.txt/);
			assert.match(dirty.diffStat, /README\.md/);
			assert.match(dirty.diff, /\+updated/);

			// Commit the changes and verify commitsAhead > 0 relative to baseCommit
			git(created.worktree.path, ["add", "."]);
			git(created.worktree.path, ["commit", "-m", "worker commit"]);

			const committed = await getWorktreeDiff(created.worktree.path, created.worktree.baseCommit);
			assert.equal(committed.hasChanges, true);
			assert.equal(committed.commitsAhead, 1);
			assert.equal(committed.statusShort, "");
			assert.match(committed.diffStat, /extra\.txt/);
			assert.match(committed.diff, /\+new file/);
		});

		it("throws when the worktree directory does not exist", async () => {
			await assert.rejects(
				() => getWorktreeDiff(join(rootTemp, "missing-worktree-dir")),
				/Worktree directory does not exist/,
			);
		});
	});

	describe("removeWorktree", () => {
		it("refuses dirty worktree without force and removes it with force: true", async () => {
			const repoDir = join(rootTemp, "repo-remove-dirty");
			const worktreesDir = join(rootTemp, "worktrees-remove-dirty");
			initGitRepo(repoDir);

			const created = await createWorktree({
				cwd: repoDir,
				slug: "dirty-worker",
				worktreesDir,
			});
			writeFileSync(join(created.worktree.path, "README.md"), "dirty\n", "utf8");

			await assert.rejects(
				() =>
					removeWorktree({
						repoRoot: created.worktree.repoRoot,
						worktreePath: created.worktree.path,
						branch: created.worktree.branch,
						baseCommit: created.worktree.baseCommit,
						force: false,
						worktreesDir,
					}),
				/has uncommitted changes/,
			);
			assert.equal(existsSync(created.worktree.path), true);

			const forced = await removeWorktree({
				repoRoot: created.worktree.repoRoot,
				worktreePath: created.worktree.path,
				branch: created.worktree.branch,
				baseCommit: created.worktree.baseCommit,
				force: true,
				worktreesDir,
			});
			assert.equal(forced.removedWorktree, created.worktree.path);
			assert.equal(forced.deletedBranch, created.worktree.branch);
			assert.equal(existsSync(created.worktree.path), false);
		});

		it("deletes branch when commitsAhead === 0 or deleteBranch is true, and preserves branch when commitsAhead > 0 and !deleteBranch", async () => {
			const repoDir = join(rootTemp, "repo-remove-branches");
			const worktreesDir = join(rootTemp, "worktrees-remove-branches");
			initGitRepo(repoDir);

			// Case 1: 0 commits ahead -> branch automatically deleted
			const zeroAhead = await createWorktree({
				cwd: repoDir,
				slug: "zero-ahead",
				worktreesDir,
			});
			const resZero = await removeWorktree({
				repoRoot: zeroAhead.worktree.repoRoot,
				worktreePath: zeroAhead.worktree.path,
				branch: zeroAhead.worktree.branch,
				baseCommit: zeroAhead.worktree.baseCommit,
				worktreesDir,
			});
			assert.equal(resZero.deletedBranch, zeroAhead.worktree.branch);
			assert.equal(resZero.preservedBranch, undefined);

			// Case 2: commitsAhead > 0 and !deleteBranch -> branch preserved
			const oneAheadKeep = await createWorktree({
				cwd: repoDir,
				slug: "keep-branch",
				worktreesDir,
			});
			writeFileSync(join(oneAheadKeep.worktree.path, "kept.txt"), "keep\n", "utf8");
			git(oneAheadKeep.worktree.path, ["add", "kept.txt"]);
			git(oneAheadKeep.worktree.path, ["commit", "-m", "keep work"]);

			const resKeep = await removeWorktree({
				repoRoot: oneAheadKeep.worktree.repoRoot,
				worktreePath: oneAheadKeep.worktree.path,
				branch: oneAheadKeep.worktree.branch,
				baseCommit: oneAheadKeep.worktree.baseCommit,
				deleteBranch: false,
				worktreesDir,
			});
			assert.equal(resKeep.preservedBranch, oneAheadKeep.worktree.branch);
			assert.equal(resKeep.deletedBranch, undefined);
			assert.equal(
				git(repoDir, ["branch", "--list", oneAheadKeep.worktree.branch]),
				oneAheadKeep.worktree.branch,
			);

			// Case 3: commitsAhead > 0 and deleteBranch: true -> branch deleted
			const oneAheadDelete = await createWorktree({
				cwd: repoDir,
				slug: "delete-branch",
				worktreesDir,
			});
			writeFileSync(join(oneAheadDelete.worktree.path, "drop.txt"), "drop\n", "utf8");
			git(oneAheadDelete.worktree.path, ["add", "drop.txt"]);
			git(oneAheadDelete.worktree.path, ["commit", "-m", "drop work"]);

			const resDelete = await removeWorktree({
				repoRoot: oneAheadDelete.worktree.repoRoot,
				worktreePath: oneAheadDelete.worktree.path,
				branch: oneAheadDelete.worktree.branch,
				baseCommit: oneAheadDelete.worktree.baseCommit,
				deleteBranch: true,
				worktreesDir,
			});
			assert.equal(resDelete.deletedBranch, oneAheadDelete.worktree.branch);
			assert.equal(resDelete.preservedBranch, undefined);
			assert.equal(
				git(repoDir, ["branch", "--list", oneAheadDelete.worktree.branch]),
				"",
			);
		});
	});
});
