import type { AskResult, ModelSummary, RunResult, SessionSummary } from "./types.js";

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
		result.sessionId ? `session=${result.sessionId}` : undefined,
		`model=${result.provider}/${result.model}`,
		`mode=${result.mode}`,
		`tools=${result.toolCallsCount}`,
		`tokens=${formatTokens(result.usage.input)}/${formatTokens(result.usage.output)}`,
		`cost=${formatCost(result.usage.cost)}`,
	]
		.filter((part): part is string => Boolean(part))
		.join(" ");

	return `${result.text}\n\n[agy-pi] ${meta}`;
}
