import { listSubagents } from "../subagents.js";
import type { SubagentRecord, SubagentStatus, SubagentSummary } from "../types.js";

export interface LsCommandOptions {
	status?: SubagentStatus;
	limit: number;
	json: boolean;
}

export interface LsCommandDeps {
	subagentsDir?: string;
}

function toSubagentSummary(record: SubagentRecord): SubagentSummary {
	return {
		id: record.id,
		name: record.name,
		status: record.status,
		...(record.agent !== undefined ? { agent: record.agent } : {}),
		model: record.model,
		thinkingLevel: record.thinkingLevel,
		mode: record.mode,
		workspace: record.workspace,
		cwd: record.cwd,
		effectiveCwd: record.effectiveCwd,
		...(record.worktree !== undefined ? { worktree: record.worktree } : {}),
		turns: record.turns,
		toolCalls: record.toolCalls,
		tokens: record.tokens,
		cost: record.cost,
		createdAt: record.createdAt,
		updatedAt: record.updatedAt,
	};
}

export async function runLsCommand(
	options: LsCommandOptions,
	deps: LsCommandDeps = {},
): Promise<SubagentSummary[]> {
	if (options.limit <= 0) {
		return [];
	}
	return listSubagents({
		subagentsDir: deps.subagentsDir,
		status: options.status,
		limit: options.limit,
	}).map(toSubagentSummary);
}
