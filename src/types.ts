import type { ThinkingLevel } from "@earendil-works/pi-agent-core";

export type { ThinkingLevel };

export const KNOWN_BUILTIN_TOOLS = [
	"read",
	"grep",
	"find",
	"ls",
	"edit",
	"write",
	"bash",
	"powershell",
] as const;

export const READONLY_TOOLS = ["read", "grep", "find", "ls"] as const;

export type KnownBuiltinTool = (typeof KNOWN_BUILTIN_TOOLS)[number];

export type RunMode = "readonly" | "coder";
export type WorkspaceMode = "inherit" | "worktree";
export type SubagentStatus = "running" | "idle" | "error" | "killed";

export interface AgentProfile {
	name: string;
	description: string;
	model?: string;
	thinking?: ThinkingLevel;
	tools?: string[];
	mode?: RunMode;
	workspace?: WorkspaceMode;
	systemPrompt: string;
	source: "user" | "project";
	filePath: string;
}

export interface SubagentWorktreeInfo {
	repoRoot: string;
	path: string;
	branch: string;
	baseCommit: string;
}

export interface TokenUsageSummary {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	total: number;
	cost: number;
}

export interface SubagentRecord {
	id: string;
	name: string;
	sessionId: string;
	sessionFile?: string;
	agent?: string;
	model: string;
	thinkingLevel: ThinkingLevel;
	mode: RunMode;
	tools: string[];
	systemPrompt?: string;
	cwd: string;
	effectiveCwd: string;
	workspace: WorkspaceMode;
	worktree?: SubagentWorktreeInfo;
	pid?: number;
	pidStartTime?: string;
	status: SubagentStatus;
	turns: number;
	toolCalls: number;
	tokens: TokenUsageSummary;
	cost: number;
	createdAt: string;
	updatedAt: string;
	lastError?: string;
}

export interface SubagentSummary {
	id: string;
	name: string;
	status: SubagentStatus;
	agent?: string;
	model: string;
	thinkingLevel: ThinkingLevel;
	mode: RunMode;
	workspace: WorkspaceMode;
	cwd: string;
	effectiveCwd: string;
	worktree?: SubagentWorktreeInfo;
	turns: number;
	toolCalls: number;
	tokens: TokenUsageSummary;
	cost: number;
	createdAt: string;
	updatedAt: string;
}

export interface WorktreeDiffResult {
	subagent: string;
	workspace: WorkspaceMode;
	path: string;
	branch?: string;
	baseCommit?: string;
	statusShort: string;
	diffStat: string;
	diff: string;
	hasChanges: boolean;
	commitsAhead: number;
}

export interface KillSubagentResult {
	id: string;
	stoppedPid?: number;
	removedWorktree?: string;
	deletedBranch?: string;
	preservedBranch?: string;
	sessionId: string;
}

export interface ModelsCommand {
	kind: "models";
	query?: string;
	provider?: string;
	refresh: boolean;
	json: boolean;
}

export interface SessionsCommand {
	kind: "sessions";
	limit: number;
	json: boolean;
}

export interface AgentsCommand {
	kind: "agents";
	cwd: string;
	projectAgents: boolean;
	json: boolean;
}

export interface AskCommand {
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

export interface RunCommand {
	kind: "run";
	agent?: string;
	name?: string;
	model?: string;
	thinking?: ThinkingLevel;
	mode: RunMode;
	modeExplicit?: boolean;
	workspace?: WorkspaceMode;
	tools?: string[];
	cwd: string;
	system?: string;
	files: string[];
	projectAgents: boolean;
	sessionId?: string;
	noSession: boolean;
	timeoutSec?: number;
	json: boolean;
	quiet: boolean;
	prompt?: string;
}

export interface SendCommand {
	kind: "send";
	target: string;
	model?: string;
	thinking?: ThinkingLevel;
	files: string[];
	timeoutSec?: number;
	json: boolean;
	quiet: boolean;
	prompt?: string;
}

export interface LsCommand {
	kind: "ls";
	status?: SubagentStatus;
	limit: number;
	json: boolean;
}

export interface DiffCommand {
	kind: "diff";
	target: string;
	statOnly: boolean;
	json: boolean;
}

export interface KillCommand {
	kind: "kill";
	target?: string;
	all: boolean;
	force: boolean;
	deleteBranch: boolean;
	json: boolean;
}

export type ParsedCommand =
	| { kind: "help" }
	| { kind: "version" }
	| ModelsCommand
	| SessionsCommand
	| AgentsCommand
	| AskCommand
	| RunCommand
	| SendCommand
	| LsCommand
	| DiffCommand
	| KillCommand;

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
	subagent?: string;
	agent?: string;
	sessionId?: string;
	sessionFile?: string;
	provider: string;
	model: string;
	thinkingLevel: ThinkingLevel;
	mode: RunMode;
	cwd: string;
	workspace?: WorkspaceMode;
	effectiveCwd?: string;
	worktree?: {
		path: string;
		branch: string;
		diffStat?: string;
	};
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
