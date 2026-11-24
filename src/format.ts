import type {
	AgentProfile,
	AskResult,
	KillSubagentResult,
	ModelSummary,
	RunResult,
	SessionSummary,
	SubagentRecord,
	WorktreeDiffResult,
} from "./types.js";

export function formatTokens(n: number): string {
	if (!Number.isFinite(n) || n <= 0) return "0";
	if (n < 1000) return String(Math.round(n));
	if (n < 10_000) {
		return `${(n / 1000).toFixed(1).replace(/\.0$/, "")}k`;
	}
	if (n < 1_000_000) {
		return `${Math.round(n / 1000)}k`;
	}
	return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
}

export function formatCost(cost: number): string {
	if (!Number.isFinite(cost) || cost <= 0) return "$0";
	if (cost < 0.01) return `$${cost.toFixed(4)}`;
	return `$${cost.toFixed(2)}`;
}

export function formatJson(value: unknown): string {
	return JSON.stringify(value, null, 2);
}

export function formatModelsText(models: ModelSummary[]): string {
	if (models.length === 0) {
		return "No available models found.";
	}
	const lines = models.map((m) => {
		const spec = `${m.provider}/${m.id}`;
		const ctx = formatTokens(m.contextWindow);
		const reasoning = m.reasoning ? "thinking" : "standard";
		const price = `$${m.costInput}/$${m.costOutput}`;
		return `${spec}  ctx=${ctx}  ${reasoning}  price=${price}`;
	});
	return `${lines.join("\n")}\n\n(${models.length} model${models.length === 1 ? "" : "s"})`;
}

export function formatSessionsText(sessions: SessionSummary[]): string {
	if (sessions.length === 0) {
		return "No sessions found.";
	}
	const lines = sessions.map((s) => {
		const label = s.name ? `${s.name} — ${s.firstMessage}` : s.firstMessage;
		const preview = label.replace(/[\r\n]+/g, " ").trim().slice(0, 72);
		const date = s.modified.slice(0, 19).replace("T", " ");
		return `${s.id}  ${date}  msgs=${s.messageCount}  cwd=${s.cwd}${preview ? `  "${preview}"` : ""}`;
	});
	return lines.join("\n");
}

export function formatAgentsText(agents: AgentProfile[]): string {
	if (agents.length === 0) {
		return "No agent profiles found.";
	}
	const lines = agents.map((a) => {
		const parts = [
			a.name,
			`source=${a.source}`,
			a.mode ? `mode=${a.mode}` : undefined,
			a.workspace ? `workspace=${a.workspace}` : undefined,
			a.model ? `model=${a.model}` : undefined,
			a.tools && a.tools.length > 0 ? `tools=${a.tools.join(",")}` : undefined,
		].filter((part): part is string => Boolean(part));
		const desc = a.description
			? `  "${a.description.replace(/[\r\n]+/g, " ").trim()}"`
			: "";
		return `${parts.join("  ")}${desc}`;
	});
	return lines.join("\n");
}

export function formatSubagentsText(subagents: SubagentRecord[]): string {
	if (subagents.length === 0) {
		return "No subagents found.";
	}
	const lines = subagents.map((s) => {
		const date = s.updatedAt.slice(0, 19).replace("T", " ");
		const parts = [
			s.id,
			s.name !== s.id ? `name=${s.name}` : undefined,
			`status=${s.status}`,
			s.agent ? `agent=${s.agent}` : undefined,
			`model=${s.model}`,
			`workspace=${s.workspace}`,
			s.worktree ? `branch=${s.worktree.branch}` : undefined,
			`turns=${s.turns}`,
			`tools=${s.toolCalls}`,
			`cost=${formatCost(s.cost)}`,
			date,
		].filter((part): part is string => Boolean(part));
		return parts.join("  ");
	});
	return lines.join("\n");
}

export function formatDiffText(result: WorktreeDiffResult): string {
	const headerParts = [
		`subagent=${result.subagent}`,
		result.branch ? `branch=${result.branch}` : undefined,
		`path=${result.path}`,
		`commits=${result.commitsAhead}`,
	].filter((part): part is string => Boolean(part));

	const sections: string[] = [`[agy-pi] ${headerParts.join(" ")}`];

	if (!result.hasChanges) {
		sections.push("No changes in worktree.");
		return sections.join("\n");
	}

	if (result.statusShort) {
		sections.push(result.statusShort);
	}
	if (result.diffStat) {
		sections.push(result.diffStat);
	}
	if (result.diff) {
		sections.push(result.diff);
	}

	return sections.join("\n\n");
}

export function formatKillText(results: KillSubagentResult[]): string {
	if (results.length === 0) {
		return "No subagents to kill.";
	}
	const lines = results.map((r) => {
		const details = [
			`killed ${r.id}`,
			r.stoppedPid !== undefined ? `pid=${r.stoppedPid}` : undefined,
			r.removedWorktree ? `removed=${r.removedWorktree}` : undefined,
			r.deletedBranch ? `deleted-branch=${r.deletedBranch}` : undefined,
			r.preservedBranch ? `preserved-branch=${r.preservedBranch}` : undefined,
			`session=${r.sessionId}`,
		].filter((part): part is string => Boolean(part));
		return details.join("  ");
	});
	return lines.join("\n");
}

export function formatAskText(result: AskResult): string {
	const meta = [
		result.sessionId ? `session=${result.sessionId}` : undefined,
		`model=${result.provider}/${result.model}`,
		`thinking=${result.thinkingLevel}`,
		`tokens=${formatTokens(result.usage.input)}/${formatTokens(result.usage.output)}`,
		`cost=${formatCost(result.usage.cost)}`,
	]
		.filter((part): part is string => Boolean(part))
		.join(" ");

	return `${result.text}\n\n[agy-pi] ${meta}`;
}

export function formatRunText(result: RunResult): string {
	const meta = [
		result.subagent ? `subagent=${result.subagent}` : undefined,
		result.agent ? `agent=${result.agent}` : undefined,
		result.sessionId ? `session=${result.sessionId}` : undefined,
		`model=${result.provider}/${result.model}`,
		`mode=${result.mode}`,
		`tools=${result.toolCallsCount}`,
		`tokens=${formatTokens(result.usage.input)}/${formatTokens(result.usage.output)}`,
		`cost=${formatCost(result.usage.cost)}`,
		result.worktree ? `branch=${result.worktree.branch}` : undefined,
		result.worktree ? `worktree=${result.worktree.path}` : undefined,
	]
		.filter((part): part is string => Boolean(part))
		.join(" ");

	const base = `${result.text}\n\n[agy-pi] ${meta}`;
	if (result.worktree?.diffStat) {
		return `${base}\n${result.worktree.diffStat}`;
	}
	return base;
}
