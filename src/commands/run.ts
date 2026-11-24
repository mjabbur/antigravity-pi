import { statSync } from "node:fs";
import { resolve } from "node:path";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
	createAgentSession,
	DefaultResourceLoader,
	type ModelRuntime,
	type ResourceLoader,
	type SessionManager,
	type SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { findAgentProfile } from "../agents.js";
import { formatPromptWithFiles, loadAttachedFiles } from "../files.js";
import { ProgressLogger, summarizeToolArgs } from "../progress.js";
import { CliAbortError, initPiRuntime, resolveTargetModel } from "../runtime.js";
import { openOrCreateSession } from "../sessions.js";
import {
	generateSubagentId,
	listSubagents,
	saveSubagentRecord,
} from "../subagents.js";
import type {
	AgentProfile,
	RunMode,
	RunResult,
	SubagentRecord,
	SubagentWorktreeInfo,
	ThinkingLevel,
	TokenUsageSummary,
	ToolExecutionSummary,
	WorkspaceMode,
} from "../types.js";
import { createWorktree, getWorktreeDiff } from "../worktree.js";

export interface RunCommandOptions {
	agent?: string;
	name?: string;
	model?: string;
	thinking?: ThinkingLevel;
	mode?: RunMode;
	modeExplicit?: boolean;
	workspace?: WorkspaceMode;
	tools?: string[];
	cwd: string;
	system?: string;
	files?: string[];
	projectAgents?: boolean;
	sessionId?: string;
	noSession: boolean;
	timeoutSec?: number;
	json: boolean;
	quiet: boolean;
	prompt: string;
	existingSubagent?: SubagentRecord;
}

export interface RunCommandDeps {
	modelRuntime?: ModelRuntime;
	settingsManager?: SettingsManager;
	sessionManager?: SessionManager;
	resourceLoader?: ResourceLoader;
	progress?: ProgressLogger;
	signal?: AbortSignal;
	sessionDir?: string;
	agentDir?: string;
	subagentsDir?: string;
	worktreesDir?: string;
	pid?: number;
}

const MODE_TOOLS: Record<RunMode, string[]> = {
	readonly: ["read", "grep", "find", "ls"],
	coder: ["read", "bash", "edit", "write", "grep", "find", "ls"],
};

interface RunSetup {
	agentProfile?: AgentProfile;
	mode: RunMode;
	tools: string[];
	workspace: WorkspaceMode;
	combinedSystemPrompt?: string;
	fullPrompt: string;
	modelRuntime: ModelRuntime;
	settingsManager: SettingsManager;
	agentDir: string;
	createdRuntime: boolean;
}

interface PreparedSession {
	session: Awaited<ReturnType<typeof createAgentSession>>["session"];
	sessionId: string;
	sessionFile?: string;
	model: { provider: string; id: string };
	thinkingLevel: ThinkingLevel;
	effectiveCwd: string;
	worktreeInfo?: SubagentWorktreeInfo;
	subagentRecord?: SubagentRecord;
}

interface SessionProgressTracker {
	unsubscribe: () => void;
	removeAbortListener: () => void;
	getState: () => {
		turns: number;
		toolsUsed: ToolExecutionSummary[];
		lastAssistant?: AssistantMessage;
		wasAborted: boolean;
		usageTotals: TokenUsageSummary;
	};
}

function assertDirectoryExists(dirPath: string): void {
	let stats;
	try {
		stats = statSync(dirPath);
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		throw new Error(`Working directory does not exist: ${dirPath} (${detail})`);
	}
	if (!stats.isDirectory()) {
		throw new Error(`Working directory path is not a directory: ${dirPath}`);
	}
}

function extractAssistantText(message: AssistantMessage | undefined): string {
	if (!message) return "";
	return message.content
		.filter((block): block is Extract<AssistantMessage["content"][number], { type: "text" }> => block.type === "text")
		.map((block) => block.text)
		.join("");
}

function combineSystemPrompts(parts: Array<string | undefined>): string | undefined {
	const cleaned = parts
		.map((part) => part?.trim())
		.filter((part): part is string => Boolean(part && part.length > 0));
	return cleaned.length > 0 ? cleaned.join("\n\n") : undefined;
}

function pickUniqueSubagentId(
	preferredId: string,
	subagentsDir?: string,
): string {
	const existingIds = new Set(listSubagents({ subagentsDir }).map((record) => record.id));
	if (!existingIds.has(preferredId)) {
		return preferredId;
	}
	for (let attempt = 1; attempt <= 10; attempt++) {
		const candidate = `${preferredId.slice(0, 58)}-${attempt}`;
		if (!existingIds.has(candidate)) {
			return candidate;
		}
	}
	return generateSubagentId(preferredId);
}

function loadValidatedProfile(
	options: RunCommandOptions,
	baseCwd: string,
	deps: RunCommandDeps,
): AgentProfile | undefined {
	let agentProfile: AgentProfile | undefined;
	if (options.agent) {
		agentProfile = findAgentProfile(options.agent, {
			cwd: baseCwd,
			agentDir: deps.agentDir,
			includeProjectAgents: options.projectAgents,
		});
		if (!agentProfile) {
			throw new Error(
				`Agent profile "${options.agent}" not found. Run 'agy-pi agents' to list available profiles.`,
			);
		}
	}

	if (options.name && !options.noSession && !options.existingSubagent) {
		const existing = listSubagents({ subagentsDir: deps.subagentsDir }).find(
			(record) => record.id === options.name || record.name === options.name,
		);
		if (existing) {
			throw new Error(
				`Subagent name "${options.name}" is already in use (id=${existing.id}). Use 'agy-pi send ${options.name} ...' or 'agy-pi kill ${options.name}' first.`,
			);
		}
	}

	return agentProfile;
}

function resolveExecutionConfig(
	options: RunCommandOptions,
	agentProfile: AgentProfile | undefined,
): Pick<RunSetup, "mode" | "tools" | "workspace" | "combinedSystemPrompt"> {
	const existing = options.existingSubagent;
	const explicitMode = options.modeExplicit ? options.mode : undefined;
	const mode: RunMode = explicitMode ?? agentProfile?.mode ?? existing?.mode ?? options.mode ?? "readonly";
	const tools =
		options.tools ??
		(explicitMode ? MODE_TOOLS[explicitMode] : agentProfile?.tools ?? MODE_TOOLS[mode]);
	const workspace: WorkspaceMode = existing
		? existing.workspace
		: (options.workspace ?? agentProfile?.workspace ?? "inherit");
	const combinedSystemPrompt = existing
		? (options.system ?? existing.systemPrompt)
		: combineSystemPrompts([agentProfile?.systemPrompt, options.system]);

	return { mode, tools, workspace, combinedSystemPrompt };
}

async function ensureRunRuntime(
	baseCwd: string,
	deps: RunCommandDeps,
): Promise<{
	modelRuntime: ModelRuntime;
	settingsManager: SettingsManager;
	agentDir: string;
	createdRuntime: boolean;
}> {
	if (deps.modelRuntime && deps.settingsManager && deps.agentDir) {
		return {
			modelRuntime: deps.modelRuntime,
			settingsManager: deps.settingsManager,
			agentDir: deps.agentDir,
			createdRuntime: false,
		};
	}
	const runtime = await initPiRuntime({ cwd: baseCwd, agentDir: deps.agentDir });
	return {
		modelRuntime: deps.modelRuntime ?? runtime.modelRuntime,
		settingsManager: deps.settingsManager ?? runtime.settingsManager,
		agentDir: deps.agentDir ?? runtime.agentDir,
		createdRuntime: !deps.modelRuntime,
	};
}

async function resolveRunSetup(
	options: RunCommandOptions,
	deps: RunCommandDeps,
	baseCwd: string,
	progress: ProgressLogger,
): Promise<RunSetup> {
	const agentProfile = loadValidatedProfile(options, baseCwd, deps);
	const execConfig = resolveExecutionConfig(options, agentProfile);

	const attachedFiles =
		options.files && options.files.length > 0
			? await loadAttachedFiles(options.files, baseCwd)
			: [];
	if (attachedFiles.length > 0) {
		progress.log(`attached ${attachedFiles.length} file(s)`);
	}

	const runtime = await ensureRunRuntime(baseCwd, deps);
	return {
		agentProfile,
		...execConfig,
		fullPrompt: formatPromptWithFiles(options.prompt, attachedFiles),
		...runtime,
	};
}

function createInitialSubagentRecord(params: {
	options: RunCommandOptions;
	deps: RunCommandDeps;
	setup: RunSetup;
	sessionId: string;
	sessionFile?: string;
	model: { provider: string; id: string };
	thinkingLevel: ThinkingLevel;
	baseCwd: string;
	effectiveCwd: string;
	worktreeInfo?: SubagentWorktreeInfo;
}): SubagentRecord {
	const { options, deps, setup, sessionId, sessionFile, model, thinkingLevel, baseCwd, effectiveCwd, worktreeInfo } = params;
	const existing = options.existingSubagent;
	const nowIso = new Date().toISOString();
	const subagentId =
		existing?.id ??
		options.name ??
		pickUniqueSubagentId(generateSubagentId(options.agent ?? "sub", sessionId), deps.subagentsDir);
	const agentName = setup.agentProfile?.name ?? existing?.agent;

	return {
		id: subagentId,
		name: existing?.name ?? options.name ?? subagentId,
		sessionId,
		...(sessionFile ? { sessionFile } : {}),
		...(agentName ? { agent: agentName } : {}),
		model: `${model.provider}/${model.id}`,
		thinkingLevel,
		mode: setup.mode,
		tools: [...setup.tools],
		...(setup.combinedSystemPrompt ? { systemPrompt: setup.combinedSystemPrompt } : {}),
		cwd: existing?.cwd ?? baseCwd,
		effectiveCwd,
		workspace: setup.workspace,
		...(worktreeInfo ? { worktree: worktreeInfo } : {}),
		pid: deps.pid ?? process.pid,
		status: "running",
		turns: existing?.turns ?? 0,
		toolCalls: existing?.toolCalls ?? 0,
		tokens: existing?.tokens ?? {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			total: 0,
			cost: 0,
		},
		cost: existing?.cost ?? 0,
		createdAt: existing?.createdAt ?? nowIso,
		updatedAt: nowIso,
	};
}

async function resolveWorkspaceCwd(
	options: RunCommandOptions,
	deps: RunCommandDeps,
	workspace: WorkspaceMode,
	baseCwd: string,
	progress: ProgressLogger,
): Promise<{ effectiveCwd: string; worktreeInfo?: SubagentWorktreeInfo }> {
	if (options.existingSubagent) {
		const effectiveCwd = resolve(options.existingSubagent.effectiveCwd);
		assertDirectoryExists(effectiveCwd);
		return { effectiveCwd, worktreeInfo: options.existingSubagent.worktree };
	}
	if (workspace === "worktree") {
		const created = await createWorktree({
			cwd: baseCwd,
			slug: options.name ?? options.agent ?? "run",
			worktreesDir: deps.worktreesDir,
		});
		progress.log(`worktree ${created.worktree.branch} -> ${created.worktree.path}`);
		return { effectiveCwd: created.effectiveCwd, worktreeInfo: created.worktree };
	}
	return { effectiveCwd: baseCwd };
}

async function resolveSessionResourceLoader(params: {
	resourceLoader?: ResourceLoader;
	effectiveCwd: string;
	agentDir: string;
	settingsManager: SettingsManager;
	combinedSystemPrompt?: string;
}): Promise<ResourceLoader> {
	if (params.resourceLoader) {
		return params.resourceLoader;
	}
	const loader = new DefaultResourceLoader({
		cwd: params.effectiveCwd,
		agentDir: params.agentDir,
		settingsManager: params.settingsManager,
		noExtensions: true,
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		appendSystemPrompt: params.combinedSystemPrompt ? [params.combinedSystemPrompt] : undefined,
	});
	await loader.reload();
	return loader;
}

async function prepareWorktreeAndSession(
	options: RunCommandOptions,
	deps: RunCommandDeps,
	setup: RunSetup,
	baseCwd: string,
	progress: ProgressLogger,
): Promise<PreparedSession> {
	const { effectiveCwd, worktreeInfo } = await resolveWorkspaceCwd(
		options,
		deps,
		setup.workspace,
		baseCwd,
		progress,
	);
	const existing = options.existingSubagent;
	const sessionManager =
		deps.sessionManager ??
		openOrCreateSession({
			cwd: effectiveCwd,
			sessionId: options.sessionId ?? existing?.sessionFile ?? existing?.sessionId,
			noSession: options.noSession,
			sessionDir: deps.sessionDir,
		});

	const { model, thinkingLevel, warning } = await resolveTargetModel({
		modelRuntime: setup.modelRuntime,
		settingsManager: setup.settingsManager,
		modelSpec: options.model ?? setup.agentProfile?.model,
		thinking: options.thinking ?? setup.agentProfile?.thinking,
		defaultThinking: existing?.thinkingLevel ?? "medium",
		fallbackSessionModel: sessionManager.buildSessionContext().model,
	});
	if (warning) {
		progress.log(`warning: ${warning}`);
	}

	const resourceLoader = await resolveSessionResourceLoader({
		resourceLoader: deps.resourceLoader,
		effectiveCwd,
		agentDir: setup.agentDir,
		settingsManager: setup.settingsManager,
		combinedSystemPrompt: setup.combinedSystemPrompt,
	});

	const { session } = await createAgentSession({
		cwd: effectiveCwd,
		agentDir: setup.agentDir,
		modelRuntime: setup.modelRuntime,
		model,
		thinkingLevel,
		tools: setup.tools,
		resourceLoader,
		sessionManager,
		settingsManager: setup.settingsManager,
	});

	const sessionId = sessionManager.getSessionId();
	const sessionFile = sessionManager.getSessionFile();
	const subagentRecord = options.noSession
		? undefined
		: createInitialSubagentRecord({
				options,
				deps,
				setup,
				sessionId,
				sessionFile,
				model,
				thinkingLevel,
				baseCwd,
				effectiveCwd,
				worktreeInfo,
			});
	if (subagentRecord) {
		saveSubagentRecord(subagentRecord, deps.subagentsDir);
	}

	return {
		session,
		sessionId,
		sessionFile,
		model,
		thinkingLevel,
		effectiveCwd,
		worktreeInfo,
		subagentRecord,
	};
}

function accumulateAssistantUsage(usageTotals: TokenUsageSummary, msg: AssistantMessage): void {
	usageTotals.input += msg.usage.input;
	usageTotals.output += msg.usage.output;
	usageTotals.cacheRead += msg.usage.cacheRead;
	usageTotals.cacheWrite += msg.usage.cacheWrite;
	usageTotals.total += msg.usage.totalTokens;
	usageTotals.cost += msg.usage.cost.total;
}

interface MutableProgressState {
	turns: number;
	textChars: number;
	thinkingChars: number;
	lastAssistant?: AssistantMessage;
	toolsUsed: ToolExecutionSummary[];
	pendingArgs: Map<string, string>;
	usageTotals: TokenUsageSummary;
}

function handleSessionEvent(
	event: Parameters<Parameters<PreparedSession["session"]["subscribe"]>[0]>[0],
	state: MutableProgressState,
	progress: ProgressLogger,
): void {
	switch (event.type) {
		case "turn_start":
			state.turns += 1;
			state.textChars = 0;
			state.thinkingChars = 0;
			progress.log(`turn ${state.turns} started`);
			break;
		case "message_update": {
			const sub = event.assistantMessageEvent;
			if (sub.type === "thinking_delta") {
				state.thinkingChars += sub.delta.length;
				progress.logThrottled(`turn ${state.turns} thinking (${state.thinkingChars} chars)`);
			} else if (sub.type === "text_delta") {
				state.textChars += sub.delta.length;
				progress.logThrottled(`turn ${state.turns} streaming (${state.textChars} chars)`);
			}
			break;
		}
		case "message_end":
			if (event.message.role === "assistant") {
				const msg = event.message as AssistantMessage;
				state.lastAssistant = msg;
				accumulateAssistantUsage(state.usageTotals, msg);
			}
			break;
		case "tool_execution_start": {
			const argsSummary = summarizeToolArgs(event.toolName, event.args);
			state.pendingArgs.set(event.toolCallId, argsSummary);
			progress.log(argsSummary ? `tool ${event.toolName}: ${argsSummary}` : `tool ${event.toolName}`);
			break;
		}
		case "tool_execution_end": {
			const argsSummary = state.pendingArgs.get(event.toolCallId) ?? "";
			state.pendingArgs.delete(event.toolCallId);
			state.toolsUsed.push({
				toolCallId: event.toolCallId,
				toolName: event.toolName,
				argsSummary,
				isError: event.isError,
				...(event.durationMs !== undefined ? { durationMs: event.durationMs } : {}),
			});
			const timing = event.durationMs !== undefined ? ` (${Math.round(event.durationMs)}ms)` : "";
			progress.log(`tool ${event.toolName} ${event.isError ? "error" : "ok"}${timing}`);
			break;
		}
		case "auto_retry_start":
			progress.log(`retrying (${event.attempt}/${event.maxAttempts}): ${event.errorMessage}`);
			break;
		case "compaction_start":
			progress.log(`compacting context (${event.reason})`);
			break;
	}
}

function attachSessionProgress(
	session: PreparedSession["session"],
	progress: ProgressLogger,
	signal?: AbortSignal,
): SessionProgressTracker {
	const state: MutableProgressState = {
		turns: 0,
		textChars: 0,
		thinkingChars: 0,
		toolsUsed: [],
		pendingArgs: new Map<string, string>(),
		usageTotals: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: 0 },
	};
	let wasAborted = false;

	const unsubscribe = session.subscribe((event) => handleSessionEvent(event, state, progress));

	const onAbort = () => {
		wasAborted = true;
		progress.log("aborting...");
		void session.abort();
	};
	if (signal?.aborted) {
		onAbort();
	} else {
		signal?.addEventListener("abort", onAbort, { once: true });
	}

	return {
		unsubscribe,
		removeAbortListener: () => signal?.removeEventListener("abort", onAbort),
		getState: () => ({
			turns: state.turns,
			toolsUsed: state.toolsUsed,
			lastAssistant: state.lastAssistant,
			wasAborted,
			usageTotals: state.usageTotals,
		}),
	};
}

async function fetchWorktreeResult(
	worktreeInfo?: SubagentWorktreeInfo,
): Promise<RunResult["worktree"]> {
	if (!worktreeInfo) return undefined;
	try {
		const diffResult = await getWorktreeDiff(worktreeInfo.path, worktreeInfo.baseCommit);
		return {
			path: worktreeInfo.path,
			branch: worktreeInfo.branch,
			...(diffResult.diffStat ? { diffStat: diffResult.diffStat } : {}),
		};
	} catch {
		return {
			path: worktreeInfo.path,
			branch: worktreeInfo.branch,
		};
	}
}

async function finalizeSubagentRun(params: {
	options: RunCommandOptions;
	setup: RunSetup;
	prepared: PreparedSession;
	tracker: SessionProgressTracker;
	signal?: AbortSignal;
	progress: ProgressLogger;
	startedAt: number;
	baseCwd: string;
}): Promise<RunResult> {
	const { options, setup, prepared, tracker, signal, progress, startedAt, baseCwd } = params;
	const state = tracker.getState();
	const finalAssistant =
		state.lastAssistant ??
		([...prepared.session.messages]
			.reverse()
			.find((msg): msg is AssistantMessage => msg.role === "assistant"));

	if (state.wasAborted || signal?.aborted || finalAssistant?.stopReason === "aborted") {
		throw new CliAbortError(finalAssistant?.errorMessage || "Run aborted");
	}
	if (finalAssistant?.stopReason === "error") {
		throw new Error(finalAssistant.errorMessage || "Agent run failed.");
	}

	const text = prepared.session.getLastAssistantText() ?? extractAssistantText(finalAssistant);
	progress.log(
		`done (${state.turns} turn${state.turns === 1 ? "" : "s"}, ${state.toolsUsed.length} tool call${state.toolsUsed.length === 1 ? "" : "s"})`,
	);

	const worktreeResult = await fetchWorktreeResult(prepared.worktreeInfo);
	const resolvedAgentName = setup.agentProfile?.name ?? options.existingSubagent?.agent;

	return {
		text,
		...(prepared.subagentRecord ? { subagent: prepared.subagentRecord.id } : {}),
		...(resolvedAgentName ? { agent: resolvedAgentName } : {}),
		...(options.noSession
			? {}
			: { sessionId: prepared.sessionId, sessionFile: prepared.sessionFile }),
		provider: prepared.model.provider,
		model: prepared.model.id,
		thinkingLevel: prepared.thinkingLevel,
		mode: setup.mode,
		cwd: options.existingSubagent?.cwd ?? baseCwd,
		workspace: setup.workspace,
		effectiveCwd: prepared.effectiveCwd,
		...(worktreeResult ? { worktree: worktreeResult } : {}),
		toolsUsed: state.toolsUsed,
		toolCallsCount: state.toolsUsed.length,
		turns: state.turns,
		usage: state.usageTotals,
		durationMs: Date.now() - startedAt,
	};
}

function saveFinishedSubagentRecord(params: {
	subagentRecord: SubagentRecord;
	turns: number;
	toolCallsCount: number;
	usageTotals: TokenUsageSummary;
	runErrorMessage?: string;
	subagentsDir?: string;
}): void {
	const { subagentRecord, turns, toolCallsCount, usageTotals, runErrorMessage, subagentsDir } = params;
	const updatedTokens: TokenUsageSummary = {
		input: subagentRecord.tokens.input + usageTotals.input,
		output: subagentRecord.tokens.output + usageTotals.output,
		cacheRead: subagentRecord.tokens.cacheRead + usageTotals.cacheRead,
		cacheWrite: subagentRecord.tokens.cacheWrite + usageTotals.cacheWrite,
		total: subagentRecord.tokens.total + usageTotals.total,
		cost: subagentRecord.tokens.cost + usageTotals.cost,
	};
	saveSubagentRecord(
		{
			...subagentRecord,
			pid: undefined,
			status: runErrorMessage ? "error" : "idle",
			turns: subagentRecord.turns + turns,
			toolCalls: subagentRecord.toolCalls + toolCallsCount,
			tokens: updatedTokens,
			cost: updatedTokens.cost,
			updatedAt: new Date().toISOString(),
			lastError: runErrorMessage,
		},
		subagentsDir,
	);
}

export async function runAgentCommand(
	options: RunCommandOptions,
	deps: RunCommandDeps = {},
): Promise<RunResult> {
	const startedAt = Date.now();
	const baseCwd = resolve(options.cwd);
	assertDirectoryExists(baseCwd);

	const progress = deps.progress ?? new ProgressLogger({ quiet: options.quiet });
	if (deps.signal?.aborted) {
		throw new CliAbortError("Run aborted");
	}

	const setup = await resolveRunSetup(options, deps, baseCwd, progress);
	const prepared = await prepareWorktreeAndSession(options, deps, setup, baseCwd, progress);
	const tracker = attachSessionProgress(prepared.session, progress, deps.signal);
	let runErrorMessage: string | undefined;

	try {
		progress.log(
			`run ${prepared.model.provider}/${prepared.model.id} (mode=${setup.mode}, thinking=${prepared.thinkingLevel})`,
		);
		await prepared.session.prompt(setup.fullPrompt);
		await prepared.session.waitForIdle();
		return await finalizeSubagentRun({
			options,
			setup,
			prepared,
			tracker,
			signal: deps.signal,
			progress,
			startedAt,
			baseCwd,
		});
	} catch (error) {
		runErrorMessage = error instanceof Error ? error.message : String(error);
		throw error;
	} finally {
		tracker.removeAbortListener();
		tracker.unsubscribe();
		prepared.session.dispose();
		if (prepared.subagentRecord) {
			const state = tracker.getState();
			saveFinishedSubagentRecord({
				subagentRecord: prepared.subagentRecord,
				turns: state.turns,
				toolCallsCount: state.toolsUsed.length,
				usageTotals: state.usageTotals,
				runErrorMessage,
				subagentsDir: deps.subagentsDir,
			});
		}
		if (setup.createdRuntime) {
			await setup.modelRuntime.settleCredentialWrites();
		}
	}
}
