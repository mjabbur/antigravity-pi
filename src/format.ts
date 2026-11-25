import { stripTerminalControls } from "./progress.js";
import type {
	AgentProfile,
	AskResult,
	KillSubagentResult,
	ModelSummary,
	RunResult,
	SessionSummary,
	SubagentSummary,
	WorktreeDiffResult,
} from "./types.js";

function sanitizeLine(text: string): string {
	return stripTerminalControls(text.replace(/[\r\n\t]+/g, " "));
}

function sanitizeMultiline(text: string): string {
	return stripTerminalControls(text, { preserveNewlines: true });
}

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
		const rawLabel = s.name ? `${s.name} — ${s.firstMessage}` : s.firstMessage;
		const preview = sanitizeLine(rawLabel).trim().slice(0, 72);
		const date = sanitizeLine(s.modified).slice(0, 19).replace("T", " ");
		const id = sanitizeLine(s.id);
		const cwd = sanitizeLine(s.cwd);
		return `${id}  ${date}  msgs=${s.messageCount}  cwd=${cwd}${preview ? `  "${preview}"` : ""}`;
	});
	return lines.join("\n");
}

export function formatAgentsText(agents: AgentProfile[]): string {
	if (agents.length === 0) {
		return "No agent profiles found.";
	}
	const lines = agents.map((a) => {
		const parts = [
			sanitizeLine(a.name),
			`source=${a.source}`,
			a.mode ? `mode=${a.mode}` : undefined,
			a.workspace ? `workspace=${a.workspace}` : undefined,
			a.model ? `model=${sanitizeLine(a.model)}` : undefined,
			a.tools && a.tools.length > 0 ? `tools=${sanitizeLine(a.tools.join(","))}` : undefined,
		].filter((part): part is string => Boolean(part));
		const cleanedDesc = sanitizeLine(a.description).trim();
		const desc = cleanedDesc ? `  "${cleanedDesc}"` : "";
		return `${parts.join("  ")}${desc}`;
	});
	return lines.join("\n");
}

export function formatSubagentsText(subagents: SubagentSummary[]): string {
	if (subagents.length === 0) {
		return "No subagents found.";
	}
	const lines = subagents.map((s) => {
		const date = sanitizeLine(s.updatedAt).slice(0, 19).replace("T", " ");
		const id = sanitizeLine(s.id);
		const name = sanitizeLine(s.name);
		const parts = [
			id,
			name !== id ? `name=${name}` : undefined,
			`status=${s.status}`,
			s.agent ? `agent=${sanitizeLine(s.agent)}` : undefined,
			`model=${sanitizeLine(s.model)}`,
			`workspace=${s.workspace}`,
			s.worktree ? `branch=${sanitizeLine(s.worktree.branch)}` : undefined,
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
		`subagent=${sanitizeLine(result.subagent)}`,
		result.branch ? `branch=${sanitizeLine(result.branch)}` : undefined,
		`path=${sanitizeLine(result.path)}`,
		`commits=${result.commitsAhead}`,
	].filter((part): part is string => Boolean(part));

	const sections: string[] = [`[agy-pi] ${headerParts.join(" ")}`];

	if (!result.hasChanges) {
		sections.push("No changes in worktree.");
		return sections.join("\n");
	}

	if (result.statusShort) {
		sections.push(sanitizeMultiline(result.statusShort));
	}
	if (result.diffStat) {
		sections.push(sanitizeMultiline(result.diffStat));
	}
	if (result.diff) {
		sections.push(sanitizeMultiline(result.diff));
	}

	return sections.join("\n\n");
}

export function formatKillText(results: KillSubagentResult[]): string {
	if (results.length === 0) {
		return "No subagents to kill.";
	}
	const lines = results.map((r) => {
		const details = [
			`killed ${sanitizeLine(r.id)}`,
			r.stoppedPid !== undefined ? `pid=${r.stoppedPid}` : undefined,
			r.removedWorktree ? `removed=${sanitizeLine(r.removedWorktree)}` : undefined,
			r.deletedBranch ? `deleted-branch=${sanitizeLine(r.deletedBranch)}` : undefined,
			r.preservedBranch ? `preserved-branch=${sanitizeLine(r.preservedBranch)}` : undefined,
			`session=${sanitizeLine(r.sessionId)}`,
		].filter((part): part is string => Boolean(part));
		return details.join("  ");
	});
	return lines.join("\n");
}

export function formatAskText(result: AskResult): string {
	const meta = [
		result.sessionId ? `session=${sanitizeLine(result.sessionId)}` : undefined,
		`model=${sanitizeLine(result.provider)}/${sanitizeLine(result.model)}`,
		`thinking=${result.thinkingLevel}`,
		`tokens=${formatTokens(result.usage.input)}/${formatTokens(result.usage.output)}`,
		`cost=${formatCost(result.usage.cost)}`,
	]
		.filter((part): part is string => Boolean(part))
		.join(" ");

	return `${sanitizeMultiline(result.text)}\n\n[agy-pi] ${meta}`;
}

function formatRunMeta(result: RunResult): string {
	return [
		result.subagent ? `subagent=${sanitizeLine(result.subagent)}` : undefined,
		result.agent ? `agent=${sanitizeLine(result.agent)}` : undefined,
		result.sessionId ? `session=${sanitizeLine(result.sessionId)}` : undefined,
		`model=${sanitizeLine(result.provider)}/${sanitizeLine(result.model)}`,
		`mode=${result.mode}`,
		`tools=${result.toolCallsCount}`,
		`tokens=${formatTokens(result.usage.input)}/${formatTokens(result.usage.output)}`,
		`cost=${formatCost(result.usage.cost)}`,
		result.worktree ? `branch=${sanitizeLine(result.worktree.branch)}` : undefined,
		result.worktree ? `worktree=${sanitizeLine(result.worktree.path)}` : undefined,
	]
		.filter((part): part is string => Boolean(part))
		.join(" ");
}

export function formatRunText(result: RunResult): string {
	const base = `${sanitizeMultiline(result.text)}\n\n[agy-pi] ${formatRunMeta(result)}`;
	return result.worktree?.diffStat
		? `${base}\n${sanitizeMultiline(result.worktree.diffStat)}`
		: base;
}
