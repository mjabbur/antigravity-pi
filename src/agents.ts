import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { getAgentDir, parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { getToolValidationError } from "./args.js";
import { isDirectoryPath } from "./paths.js";
import {
	type AgentProfile,
	KNOWN_BUILTIN_TOOLS,
	READONLY_TOOLS,
	type RunMode,
	type ThinkingLevel,
	type WorkspaceMode,
} from "./types.js";

export { KNOWN_BUILTIN_TOOLS, READONLY_TOOLS };

export const MAX_AGENT_PROFILE_BYTES = 128 * 1024;

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
 * Rejects modifiers (+/-/wildcards) and unknown tool names.
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
		if (trimmed.length === 0) continue;
		const toolError = getToolValidationError(trimmed);
		if (toolError) {
			throw new Error(toolError);
		}
		if (!seen.has(trimmed)) {
			seen.add(trimmed);
			result.push(trimmed);
		}
	}

	return result.length > 0 ? result : undefined;
}

function isNonSymlinkEntry(
	targetPath: string,
	kind: "file" | "dir",
	maxBytes?: number,
): boolean {
	try {
		const stat = lstatSync(targetPath);
		if (stat.isSymbolicLink()) return false;
		if (kind === "dir") return stat.isDirectory();
		return stat.isFile() && (maxBytes === undefined || stat.size <= maxBytes);
	} catch {
		return false;
	}
}

function hasGitMarker(dirPath: string): boolean {
	try {
		const stat = lstatSync(join(dirPath, ".git"));
		return !stat.isSymbolicLink() && (stat.isDirectory() || stat.isFile());
	} catch {
		return false;
	}
}

function findGitRoot(startCwd: string): string | undefined {
	let current = resolve(startCwd);
	while (true) {
		if (hasGitMarker(current)) {
			return current;
		}
		const parent = dirname(current);
		if (parent === current) {
			return undefined;
		}
		current = parent;
	}
}

function readParsedProfile(
	filePath: string,
): { frontmatter: Record<string, unknown>; body: string } | undefined {
	if (!isNonSymlinkEntry(filePath, "file", MAX_AGENT_PROFILE_BYTES)) {
		return undefined;
	}
	let raw: string;
	try {
		raw = readFileSync(filePath, "utf8");
	} catch {
		return undefined;
	}
	if (Buffer.byteLength(raw, "utf8") > MAX_AGENT_PROFILE_BYTES) {
		return undefined;
	}
	try {
		const parsed = parseFrontmatter<Record<string, unknown>>(raw);
		const fm = parsed.frontmatter;
		if (!fm || typeof fm !== "object" || Array.isArray(fm)) {
			return undefined;
		}
		return parsed;
	} catch {
		return undefined;
	}
}

function parseTrimmedString<T extends string = string>(
	value: unknown,
	allowed?: Set<string>,
): T | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	if (trimmed.length === 0) return undefined;
	if (allowed && !allowed.has(trimmed)) return undefined;
	return trimmed as T;
}

function parseProfileFile(filePath: string, source: "user" | "project"): AgentProfile | undefined {
	const parsed = readParsedProfile(filePath);
	if (!parsed) return undefined;

	const fm = parsed.frontmatter;
	const name = parseTrimmedString(fm.name);
	if (!name) return undefined;

	let tools: string[] | undefined;
	try {
		tools = parseToolList(fm.tools);
	} catch {
		return undefined;
	}

	const description = typeof fm.description === "string" ? fm.description.trim() : "";
	const model = parseTrimmedString(fm.model);
	const thinking = parseTrimmedString<ThinkingLevel>(fm.thinking, VALID_THINKING_SET);
	const mode = parseTrimmedString<RunMode>(fm.mode, VALID_RUN_MODE_SET);
	const workspace = parseTrimmedString<WorkspaceMode>(fm.workspace, VALID_WORKSPACE_SET);

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
	const dirExists =
		source === "project" ? isNonSymlinkEntry(dirPath, "dir") : isDirectoryPath(dirPath);
	if (!dirExists) {
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
		const profile = parseProfileFile(fullPath, source);
		if (profile) {
			profiles.push(profile);
		}
	}
	return profiles;
}

function findNearestProjectAgentsDir(startCwd: string): string | undefined {
	const resolvedStart = resolve(startCwd);
	const gitRoot = findGitRoot(resolvedStart);
	if (!gitRoot) {
		const directCandidate = join(resolvedStart, ".pi", "agents");
		return isNonSymlinkEntry(directCandidate, "dir") ? directCandidate : undefined;
	}

	let current = resolvedStart;
	while (true) {
		const candidate = join(current, ".pi", "agents");
		if (isNonSymlinkEntry(candidate, "dir")) {
			return candidate;
		}
		if (current === gitRoot) {
			return undefined;
		}
		const parent = dirname(current);
		if (parent === current) {
			return undefined;
		}
		current = parent;
	}
}

function mergeProjectProfiles(
	byName: Map<string, AgentProfile>,
	cwd: string,
	userAgentsDir: string,
): void {
	const projectAgentsDir = findNearestProjectAgentsDir(cwd);
	if (!projectAgentsDir || resolve(projectAgentsDir) === resolve(userAgentsDir)) {
		return;
	}
	for (const profile of loadAgentsFromDir(projectAgentsDir, "project")) {
		const targetName = byName.has(profile.name) ? `project:${profile.name}` : profile.name;
		if (!byName.has(targetName)) {
			byName.set(targetName, targetName === profile.name ? profile : { ...profile, name: targetName });
		}
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
		mergeProjectProfiles(byName, options.cwd ?? process.cwd(), userAgentsDir);
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
