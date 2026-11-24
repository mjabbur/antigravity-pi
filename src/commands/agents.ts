import { resolve } from "node:path";
import { discoverAgents } from "../agents.js";
import type { AgentProfile } from "../types.js";

export interface AgentsCommandOptions {
	cwd: string;
	projectAgents: boolean;
	json: boolean;
}

export interface AgentsCommandDeps {
	agentDir?: string;
}

export async function runAgentsCommand(
	options: AgentsCommandOptions,
	deps: AgentsCommandDeps = {},
): Promise<AgentProfile[]> {
	const cwd = resolve(options.cwd);
	return discoverAgents({
		cwd,
		agentDir: deps.agentDir,
		includeProjectAgents: options.projectAgents,
	});
}
