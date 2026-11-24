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
	const limit = Math.max(0, options.limit);
	if (limit === 0) {
		return [];
	}
	return listAgyPiSessions({
		limit,
		sessionDir: deps.sessionDir,
	});
}
