import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import {
	ensurePrivateDir,
	getAgyPiCacheSubdir,
	isPathInsideDir,
	safeRealpath,
} from "./paths.js";
import type { SubagentWorktreeInfo } from "./types.js";

const execFileAsync = promisify(execFile);
const MAX_GIT_OUTPUT_BYTES = 10 * 1024 * 1024;
const GIT_COMMIT_HASH_PATTERN = /^[0-9a-f]{40}([0-9a-f]{24})?$/i;
const MANAGED_WORKTREE_BRANCH_PATTERN = /^agy-pi\/[a-z0-9][a-z0-9._-]{0,80}$/;

export function isValidGitCommitHash(value: string): boolean {
	return GIT_COMMIT_HASH_PATTERN.test(value);
}

export function isManagedWorktreeBranch(branch: string): boolean {
	return MANAGED_WORKTREE_BRANCH_PATTERN.test(branch) && !branch.includes("..");
}

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
	return execFileAsync(
		"git",
		["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "-C", cwd, ...args],
		{
			encoding: "utf8",
			maxBuffer: MAX_GIT_OUTPUT_BYTES,
		},
	);
}

async function gitRefExists(repoRoot: string, ref: string): Promise<boolean> {
	try {
		await runGit(repoRoot, ["show-ref", "--verify", "--quiet", "--", ref]);
		return true;
	} catch {
		return false;
	}
}

function assertValidBaseCommit(baseCommit: string): void {
	if (!isValidGitCommitHash(baseCommit)) {
		throw new Error(`Invalid git baseCommit "${baseCommit}".`);
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
	assertValidBaseCommit(baseCommit);

	const relSubpath = relative(safeRealpath(repoRoot), safeRealpath(resolvedCwd));
	const worktreesBaseDir = options.worktreesDir
		? resolve(options.worktreesDir)
		: getDefaultWorktreesDir();
	ensurePrivateDir(worktreesBaseDir);

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
		await runGit(repoRoot, ["worktree", "add", "-b", branch, "--", worktreePath, "HEAD"]);
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

async function countCommitsBetween(
	cwd: string,
	baseCommit: string,
	targetRef: string,
	fallback: number,
): Promise<number> {
	try {
		const countRes = await runGit(cwd, ["rev-list", "--count", `${baseCommit}..${targetRef}`]);
		const parsed = Number.parseInt(countRes.stdout.trim(), 10);
		return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
	} catch {
		return fallback;
	}
}

export async function getWorktreeDiff(
	worktreePath: string,
	baseCommit?: string,
	options: { statOnly?: boolean } = {},
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
	if (baseCommit !== undefined) {
		assertValidBaseCommit(baseCommit);
	}

	const statusRes = await runGit(resolvedPath, ["status", "--short"]);
	const statusShort = statusRes.stdout.trimEnd();
	const commitsAhead = baseCommit ? await countCommitsBetween(resolvedPath, baseCommit, "HEAD", 0) : 0;

	const diffBaseArgs = ["diff", "--no-ext-diff", "--no-textconv"];
	const refArgs = baseCommit ? [baseCommit, "--"] : ["--"];
	const [statRes, diffRes] = await Promise.all([
		runGit(resolvedPath, [...diffBaseArgs, "--stat", ...refArgs]),
		options.statOnly
			? Promise.resolve({ stdout: "", stderr: "" })
			: runGit(resolvedPath, [...diffBaseArgs, ...refArgs]),
	]);

	const diffStat = statRes.stdout.trimEnd();
	const diff = options.statOnly ? "" : diffRes.stdout.trimEnd();
	const hasChanges =
		statusShort.trim().length > 0 ||
		diffStat.trim().length > 0 ||
		diff.trim().length > 0 ||
		commitsAhead > 0;

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
	worktreesDir?: string;
}): Promise<{
	removedWorktree?: string;
	deletedBranch?: string;
	preservedBranch?: string;
}> {
	const repoRoot = resolve(options.repoRoot);
	const worktreePath = resolve(options.worktreePath);
	const allowedWorktreesDir = safeRealpath(
		options.worktreesDir ? resolve(options.worktreesDir) : getDefaultWorktreesDir(),
	);
	const resolvedWorktreePath = safeRealpath(worktreePath);
	if (!isPathInsideDir(resolvedWorktreePath, allowedWorktreesDir)) {
		throw new Error(
			`Refusing to remove worktree "${worktreePath}" outside managed worktrees directory "${allowedWorktreesDir}".`,
		);
	}
	if (options.branch !== undefined && !isManagedWorktreeBranch(options.branch)) {
		throw new Error(`Refusing to operate on unmanaged worktree branch "${options.branch}".`);
	}
	if (options.baseCommit !== undefined) {
		assertValidBaseCommit(options.baseCommit);
	}

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
			? ["worktree", "remove", "--force", "--", worktreePath]
			: ["worktree", "remove", "--", worktreePath];
		await runGit(repoRoot, removeArgs);
		removedWorktree = worktreePath;
	}

	let deletedBranch: string | undefined;
	let preservedBranch: string | undefined;

	if (options.branch && (await gitRefExists(repoRoot, `refs/heads/${options.branch}`))) {
		const commitsAhead = options.baseCommit
			? await countCommitsBetween(repoRoot, options.baseCommit, options.branch, 1)
			: 1;

		if (options.deleteBranch === true || (options.baseCommit !== undefined && commitsAhead === 0)) {
			await runGit(repoRoot, ["branch", "-D", "--", options.branch]);
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
