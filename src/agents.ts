import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { getAgentDir, parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { isDirectoryPath } from "./paths.js";
import type { AgentProfile, RunMode, ThinkingLevel, WorkspaceMode } from "./types.js";

const VALID_THINKING_SET = new Set<string>([
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
]);

const VALID_RUN_MODE_SET = new Set<string>(["readonly", "coder"]);
const VALID_WORKSPACE_SET = new Set<string>(["inherit", "worktree"]);

export interface DiscoverAgentsOptions {
	cwd?: string;
	agentDir?: string;
	includeProjectAgents?: boolean;
}

/**
 * Parses a tool list from either a comma-separated string or an array of strings.
 */
export function parseToolList(value: unknown): string[] | undefined {
	if (value === undefined || value === null) return undefined;

	let rawItems: string[];
	if (typeof value === "string") {
		rawItems = value.split(",");
	} else if (Array.isArray(value)) {
		rawItems = value.filter((item): item is string => typeof item === "string");
	} else {
		return undefined;
	}

	const result: string[] = [];
	const seen = new Set<string>();
	for (const item of rawItems) {
		const trimmed = item.trim();
		if (trimmed.length > 0 && !seen.has(trimmed)) {
			seen.add(trimmed);
			result.push(trimmed);
		}
	}

	return result.length > 0 ? result : undefined;
}

function isRegularFile(filePath: string): boolean {
	try {
		return statSync(filePath).isFile();
	} catch {
		return false;
	}
}

function parseProfileFile(filePath: string, source: "user" | "project"): AgentProfile | undefined {
	let raw: string;
	try {
		raw = readFileSync(filePath, "utf8");
	} catch {
		return undefined;
	}

	let parsed: { frontmatter: Record<string, unknown>; body: string };
	try {
		parsed = parseFrontmatter<Record<string, unknown>>(raw);
	} catch {
		return undefined;
	}

	const fm = parsed.frontmatter;
	if (!fm || typeof fm !== "object" || Array.isArray(fm)) {
		return undefined;
	}

	const rawName = fm.name;
	if (typeof rawName !== "string" || rawName.trim().length === 0) {
		return undefined;
	}
	const name = rawName.trim();

	const description = typeof fm.description === "string" ? fm.description.trim() : "";
	const model =
		typeof fm.model === "string" && fm.model.trim().length > 0 ? fm.model.trim() : undefined;
	const thinking =
		typeof fm.thinking === "string" && VALID_THINKING_SET.has(fm.thinking.trim())
			? (fm.thinking.trim() as ThinkingLevel)
			: undefined;
	const mode =
		typeof fm.mode === "string" && VALID_RUN_MODE_SET.has(fm.mode.trim())
			? (fm.mode.trim() as RunMode)
			: undefined;
	const workspace =
		typeof fm.workspace === "string" && VALID_WORKSPACE_SET.has(fm.workspace.trim())
			? (fm.workspace.trim() as WorkspaceMode)
			: undefined;
	const tools = parseToolList(fm.tools);

	return {
		name,
		description,
		...(model !== undefined ? { model } : {}),
		...(thinking !== undefined ? { thinking } : {}),
		...(tools !== undefined ? { tools } : {}),
		...(mode !== undefined ? { mode } : {}),
		...(workspace !== undefined ? { workspace } : {}),
		systemPrompt: parsed.body.trim(),
		source,
		filePath,
	};
}

function loadAgentsFromDir(dirPath: string, source: "user" | "project"): AgentProfile[] {
	if (!isDirectoryPath(dirPath)) {
		return [];
	}

	let entries: string[];
	try {
		entries = readdirSync(dirPath).sort((a, b) => a.localeCompare(b));
	} catch {
		return [];
	}

	const profiles: AgentProfile[] = [];
	for (const entry of entries) {
		if (!entry.endsWith(".md")) continue;
		const fullPath = join(dirPath, entry);
		if (!isRegularFile(fullPath)) continue;
		const profile = parseProfileFile(fullPath, source);
		if (profile) {
			profiles.push(profile);
		}
	}
	return profiles;
}

function findNearestProjectAgentsDir(startCwd: string): string | undefined {
	let current = resolve(startCwd);
	while (true) {
		const candidate = join(current, ".pi", "agents");
		if (isDirectoryPath(candidate)) {
			return candidate;
		}
		const parent = dirname(current);
		if (parent === current) {
			return undefined;
		}
		current = parent;
	}
}

/**
 * Discovers declarative Markdown agent profiles from user and optional project directories.
 */
export function discoverAgents(options: DiscoverAgentsOptions = {}): AgentProfile[] {
	const userAgentDir = options.agentDir ? resolve(options.agentDir) : getAgentDir();
	const userAgentsDir = join(userAgentDir, "agents");

	const byName = new Map<string, AgentProfile>();
	for (const profile of loadAgentsFromDir(userAgentsDir, "user")) {
		byName.set(profile.name, profile);
	}

	if (options.includeProjectAgents) {
		const projectAgentsDir = findNearestProjectAgentsDir(options.cwd ?? process.cwd());
		if (projectAgentsDir && resolve(projectAgentsDir) !== resolve(userAgentsDir)) {
			for (const profile of loadAgentsFromDir(projectAgentsDir, "project")) {
				byName.set(profile.name, profile);
			}
		}
	}

	return Array.from(byName.values()).sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Finds a single agent profile by name.
 */
export function findAgentProfile(
	name: string,
	options: DiscoverAgentsOptions = {},
): AgentProfile | undefined {
	return discoverAgents(options).find((profile) => profile.name === name);
}
