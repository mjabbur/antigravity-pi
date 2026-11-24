import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, realpathSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { getAgyPiCacheSubdir } from "./paths.js";
import type { SubagentWorktreeInfo } from "./types.js";

const execFileAsync = promisify(execFile);
const MAX_GIT_OUTPUT_BYTES = 10 * 1024 * 1024;

export function getDefaultWorktreesDir(): string {
	return getAgyPiCacheSubdir("AGY_PI_WORKTREE_DIR", "worktrees");
}

export function sanitizeSlug(raw: string): string {
	const cleaned = raw
		.toLowerCase()
		.replace(/[^a-z0-9-_]+/g, "-")
		.replace(/-+/g, "-")
		.replace(/^[-_]+|[-_]+$/g, "")
		.slice(0, 48)
		.replace(/^[-_]+|[-_]+$/g, "");
	return cleaned.length > 0 ? cleaned : "subagent";
}

async function runGit(
	cwd: string,
	args: string[],
): Promise<{ stdout: string; stderr: string }> {
	return execFileAsync("git", ["-C", cwd, ...args], {
		encoding: "utf8",
		maxBuffer: MAX_GIT_OUTPUT_BYTES,
	});
}

async function gitRefExists(repoRoot: string, ref: string): Promise<boolean> {
	try {
		await runGit(repoRoot, ["show-ref", "--verify", "--quiet", ref]);
		return true;
	} catch {
		return false;
	}
}

function safeRealpath(targetPath: string): string {
	try {
		return realpathSync(targetPath);
	} catch {
		return resolve(targetPath);
	}
}

export async function createWorktree(options: {
	cwd: string;
	slug: string;
	worktreesDir?: string;
}): Promise<{ worktree: SubagentWorktreeInfo; effectiveCwd: string }> {
	const resolvedCwd = resolve(options.cwd);

	let repoRoot: string;
	try {
		const { stdout } = await runGit(resolvedCwd, ["rev-parse", "--show-toplevel"]);
		repoRoot = stdout.trim();
	} catch {
		throw new Error(
			`Cannot create git worktree: "${resolvedCwd}" is not inside a git repository.`,
		);
	}

	let baseCommit: string;
	try {
		const { stdout } = await runGit(repoRoot, ["rev-parse", "HEAD"]);
		baseCommit = stdout.trim();
	} catch {
		throw new Error(
			`Cannot create git worktree: git repository at "${repoRoot}" has no commits (HEAD is unborn).`,
		);
	}

	const relSubpath = relative(safeRealpath(repoRoot), safeRealpath(resolvedCwd));
	const worktreesBaseDir = options.worktreesDir
		? resolve(options.worktreesDir)
		: getDefaultWorktreesDir();
	mkdirSync(worktreesBaseDir, { recursive: true });

	const baseSlug = sanitizeSlug(options.slug);
	let worktreePath = "";
	let branch = "";

	for (let attempt = 0; attempt < 8; attempt++) {
		const suffix = attempt === 0 ? "" : `-${randomBytes(3).toString("hex")}`;
		const candidateSlug = `${baseSlug.slice(0, 48 - suffix.length)}${suffix}`;
		const candidatePath = join(worktreesBaseDir, candidateSlug);
		const candidateBranch = `agy-pi/${candidateSlug}`;

		if (
			!existsSync(candidatePath) &&
			!(await gitRefExists(repoRoot, `refs/heads/${candidateBranch}`))
		) {
			worktreePath = candidatePath;
			branch = candidateBranch;
			break;
		}
	}

	if (!worktreePath || !branch) {
		const fallbackSlug = `${baseSlug.slice(0, 39)}-${randomBytes(4).toString("hex")}`;
		worktreePath = join(worktreesBaseDir, fallbackSlug);
		branch = `agy-pi/${fallbackSlug}`;
	}

	try {
		await runGit(repoRoot, ["worktree", "add", "-b", branch, worktreePath, "HEAD"]);
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		throw new Error(`Failed to create git worktree at "${worktreePath}": ${detail}`);
	}

	const effectiveCwd =
		relSubpath && relSubpath !== "." && !relSubpath.startsWith("..")
			? join(worktreePath, relSubpath)
			: worktreePath;

	return {
		worktree: {
			repoRoot,
			path: worktreePath,
			branch,
			baseCommit,
		},
		effectiveCwd,
	};
}

export async function getWorktreeDiff(
	worktreePath: string,
	baseCommit?: string,
): Promise<{
	statusShort: string;
	diffStat: string;
	diff: string;
	hasChanges: boolean;
	commitsAhead: number;
}> {
	const resolvedPath = resolve(worktreePath);
	if (!existsSync(resolvedPath)) {
		throw new Error(`Worktree directory does not exist: ${resolvedPath}`);
	}

	const statusRes = await runGit(resolvedPath, ["status", "--short"]);
	const statusShort = statusRes.stdout.trimEnd();

	let commitsAhead = 0;
	if (baseCommit) {
		try {
			const countRes = await runGit(resolvedPath, [
				"rev-list",
				"--count",
				`${baseCommit}..HEAD`,
			]);
			const parsed = Number.parseInt(countRes.stdout.trim(), 10);
			if (Number.isFinite(parsed) && parsed >= 0) {
				commitsAhead = parsed;
			}
		} catch {
			commitsAhead = 0;
		}
	}

	const diffArgsBase = baseCommit ? [baseCommit] : [];
	const [statRes, diffRes] = await Promise.all([
		runGit(resolvedPath, ["diff", "--stat", ...diffArgsBase]),
		runGit(resolvedPath, ["diff", ...diffArgsBase]),
	]);

	const diffStat = statRes.stdout.trimEnd();
	const diff = diffRes.stdout.trimEnd();
	const hasChanges =
		statusShort.trim().length > 0 || diff.trim().length > 0 || commitsAhead > 0;

	return {
		statusShort,
		diffStat,
		diff,
		hasChanges,
		commitsAhead,
	};
}

export async function removeWorktree(options: {
	repoRoot: string;
	worktreePath: string;
	branch?: string;
	baseCommit?: string;
	force?: boolean;
	deleteBranch?: boolean;
}): Promise<{
	removedWorktree?: string;
	deletedBranch?: string;
	preservedBranch?: string;
}> {
	const repoRoot = resolve(options.repoRoot);
	const worktreePath = resolve(options.worktreePath);
	const force = options.force === true;

	let removedWorktree: string | undefined;

	if (existsSync(worktreePath)) {
		const statusRes = await runGit(worktreePath, ["status", "--porcelain"]);
		if (statusRes.stdout.trim().length > 0 && !force) {
			throw new Error(
				`Worktree "${worktreePath}" has uncommitted changes. Inspect with 'agy-pi diff' or pass --force to discard.`,
			);
		}
		const removeArgs = force
			? ["worktree", "remove", "--force", worktreePath]
			: ["worktree", "remove", worktreePath];
		await runGit(repoRoot, removeArgs);
		removedWorktree = worktreePath;
	} else {
		try {
			await runGit(repoRoot, ["worktree", "prune"]);
		} catch {
			// Ignore prune errors if repoRoot is unavailable or already clean.
		}
	}

	let deletedBranch: string | undefined;
	let preservedBranch: string | undefined;

	if (options.branch && (await gitRefExists(repoRoot, `refs/heads/${options.branch}`))) {
		let commitsAhead = 1;
		if (options.baseCommit) {
			try {
				const countRes = await runGit(repoRoot, [
					"rev-list",
					"--count",
					`${options.baseCommit}..${options.branch}`,
				]);
				const parsed = Number.parseInt(countRes.stdout.trim(), 10);
				if (Number.isFinite(parsed) && parsed >= 0) {
					commitsAhead = parsed;
				}
			} catch {
				commitsAhead = 1;
			}
		}

		if (options.deleteBranch === true || (options.baseCommit !== undefined && commitsAhead === 0)) {
			await runGit(repoRoot, ["branch", "-D", options.branch]);
			deletedBranch = options.branch;
		} else {
			preservedBranch = options.branch;
		}
	}

	return {
		...(removedWorktree ? { removedWorktree } : {}),
		...(deletedBranch ? { deletedBranch } : {}),
		...(preservedBranch ? { preservedBranch } : {}),
	};
}
