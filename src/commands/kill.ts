import {
	deleteSubagentRecord,
	isProcessAlive,
	listSubagents,
	resolveSubagent,
} from "../subagents.js";
import type { KillSubagentResult, SubagentRecord } from "../types.js";
import { removeWorktree } from "../worktree.js";

export interface KillCommandOptions {
	target?: string;
	all: boolean;
	force: boolean;
	deleteBranch: boolean;
	json: boolean;
}

export interface KillCommandDeps {
	subagentsDir?: string;
}

const SIGTERM_WAIT_MS = 2000;
const SIGKILL_WAIT_MS = 500;
const POLL_INTERVAL_MS = 50;

function sleep(ms: number): Promise<void> {
	return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

async function waitForExit(pid: number, timeoutMs: number): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (!isProcessAlive(pid)) {
			return true;
		}
		await sleep(POLL_INTERVAL_MS);
	}
	return !isProcessAlive(pid);
}

async function stopLiveProcess(
	record: SubagentRecord,
	force: boolean,
): Promise<number | undefined> {
	if (record.status !== "running" || record.pid === undefined || !isProcessAlive(record.pid)) {
		return undefined;
	}

	const pid = record.pid;
	try {
		process.kill(pid, "SIGTERM");
	} catch (error) {
		const code = (error as NodeJS.ErrnoException | undefined)?.code;
		if (code === "ESRCH") {
			return undefined;
		}
		throw error;
	}

	if (await waitForExit(pid, SIGTERM_WAIT_MS)) {
		return pid;
	}

	if (!force) {
		throw new Error(
			`Subagent "${record.name}" (${record.id}, pid=${pid}) did not exit on SIGTERM. Pass --force to send SIGKILL.`,
		);
	}

	try {
		process.kill(pid, "SIGKILL");
	} catch (error) {
		const code = (error as NodeJS.ErrnoException | undefined)?.code;
		if (code === "ESRCH") {
			return pid;
		}
		throw error;
	}

	await waitForExit(pid, SIGKILL_WAIT_MS);
	return pid;
}

export async function runKillCommand(
	options: KillCommandOptions,
	deps: KillCommandDeps = {},
): Promise<KillSubagentResult[]> {
	const records = options.all
		? listSubagents({ subagentsDir: deps.subagentsDir })
		: [resolveSubagent(options.target ?? "", deps.subagentsDir)];

	const results: KillSubagentResult[] = [];

	for (const record of records) {
		const stoppedPid = await stopLiveProcess(record, options.force);

		let worktreeCleanup:
			| {
					removedWorktree?: string;
					deletedBranch?: string;
					preservedBranch?: string;
			  }
			| undefined;

		if (record.worktree) {
			worktreeCleanup = await removeWorktree({
				repoRoot: record.worktree.repoRoot,
				worktreePath: record.worktree.path,
				branch: record.worktree.branch,
				baseCommit: record.worktree.baseCommit,
				force: options.force,
				deleteBranch: options.deleteBranch,
			});
		}

		deleteSubagentRecord(record.id, deps.subagentsDir);

		results.push({
			id: record.id,
			...(stoppedPid !== undefined ? { stoppedPid } : {}),
			...(worktreeCleanup?.removedWorktree
				? { removedWorktree: worktreeCleanup.removedWorktree }
				: {}),
			...(worktreeCleanup?.deletedBranch
				? { deletedBranch: worktreeCleanup.deletedBranch }
				: {}),
			...(worktreeCleanup?.preservedBranch
				? { preservedBranch: worktreeCleanup.preservedBranch }
				: {}),
			sessionId: record.sessionId,
		});
	}

	return results;
}
