import type { ThinkingLevel } from "@earendil-works/pi-agent-core";

export type { ThinkingLevel };

export type RunMode = "readonly" | "coder";

export type ParsedCommand =
	| { kind: "help" }
	| { kind: "version" }
	| {
			kind: "models";
			query?: string;
			provider?: string;
			refresh: boolean;
			json: boolean;
	  }
	| {
			kind: "sessions";
			limit: number;
			json: boolean;
	  }
	| {
			kind: "ask";
			model?: string;
			thinking?: ThinkingLevel;
			system?: string;
			files: string[];
			sessionId?: string;
			noSession: boolean;
			timeoutSec?: number;
			json: boolean;
			quiet: boolean;
			prompt?: string;
	  }
	| {
			kind: "run";
			model?: string;
			thinking?: ThinkingLevel;
			mode: RunMode;
			cwd: string;
			system?: string;
			sessionId?: string;
			noSession: boolean;
			timeoutSec?: number;
			json: boolean;
			quiet: boolean;
			prompt?: string;
	  };

export interface ModelSummary {
	provider: string;
	id: string;
	name: string;
	reasoning: boolean;
	contextWindow: number;
	maxTokens: number;
	costInput: number;
	costOutput: number;
	inputModalities: string[];
}

export interface TokenUsageSummary {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	total: number;
	cost: number;
}

export interface AskResult {
	text: string;
	thinking?: string;
	sessionId?: string;
	sessionFile?: string;
	provider: string;
	model: string;
	thinkingLevel: ThinkingLevel;
	stopReason: string;
	usage: TokenUsageSummary;
	durationMs: number;
}

export interface ToolExecutionSummary {
	toolCallId: string;
	toolName: string;
	argsSummary: string;
	isError: boolean;
	durationMs?: number;
}

export interface RunResult {
	text: string;
	sessionId?: string;
	sessionFile?: string;
	provider: string;
	model: string;
	thinkingLevel: ThinkingLevel;
	mode: RunMode;
	cwd: string;
	toolsUsed: ToolExecutionSummary[];
	toolCallsCount: number;
	turns: number;
	usage: TokenUsageSummary;
	durationMs: number;
}

export interface SessionSummary {
	id: string;
	path: string;
	cwd: string;
	name?: string;
	created: string;
	modified: string;
	messageCount: number;
	firstMessage: string;
}
