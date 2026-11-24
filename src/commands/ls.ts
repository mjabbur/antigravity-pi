import { listSubagents } from "../subagents.js";
import type { SubagentRecord, SubagentStatus } from "../types.js";

export interface LsCommandOptions {
	status?: SubagentStatus;
	limit: number;
	json: boolean;
}

export interface LsCommandDeps {
	subagentsDir?: string;
}

export async function runLsCommand(
	options: LsCommandOptions,
	deps: LsCommandDeps = {},
): Promise<SubagentRecord[]> {
	if (options.limit <= 0) {
		return [];
	}
	return listSubagents({
		subagentsDir: deps.subagentsDir,
		status: options.status,
		limit: options.limit,
	});
}
