import { listAgyPiSessions } from "../sessions.js";
import type { SessionSummary } from "../types.js";

export interface SessionsCommandOptions {
	limit: number;
	json: boolean;
}

export interface SessionsCommandDeps {
	sessionDir?: string;
}

export async function runSessionsCommand(
	options: SessionsCommandOptions,
	deps: SessionsCommandDeps = {},
): Promise<SessionSummary[]> {
	return listAgyPiSessions({
		limit: options.limit,
		sessionDir: deps.sessionDir,
	});
}
