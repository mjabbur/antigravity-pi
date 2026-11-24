import { resolveSubagent } from "../subagents.js";
import type { WorktreeDiffResult } from "../types.js";
import { getWorktreeDiff } from "../worktree.js";

export interface DiffCommandOptions {
	target: string;
	statOnly: boolean;
	json: boolean;
}

export interface DiffCommandDeps {
	subagentsDir?: string;
}

export async function runDiffCommand(
	options: DiffCommandOptions,
	deps: DiffCommandDeps = {},
): Promise<WorktreeDiffResult> {
	const record = resolveSubagent(options.target, deps.subagentsDir);
	if (record.workspace !== "worktree" || !record.worktree) {
		throw new Error(
			`Subagent "${record.name}" (${record.id}) uses workspace "${record.workspace}" and has no git worktree to diff.`,
		);
	}

	const diffData = await getWorktreeDiff(
		record.worktree.path,
		record.worktree.baseCommit,
	);

	return {
		subagent: record.id,
		workspace: record.workspace,
		path: record.worktree.path,
		branch: record.worktree.branch,
		baseCommit: record.worktree.baseCommit,
		statusShort: diffData.statusShort,
		diffStat: diffData.diffStat,
		diff: options.statOnly ? "" : diffData.diff,
		hasChanges: diffData.hasChanges,
		commitsAhead: diffData.commitsAhead,
	};
}
