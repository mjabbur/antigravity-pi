import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { discoverAgents, findAgentProfile, parseToolList } from "../src/agents.js";

describe("agents", () => {
	const rootTemp = mkdtempSync(join(os.tmpdir(), "agy-pi-agents-test-"));

	after(() => {
		rmSync(rootTemp, { recursive: true, force: true });
	});

	describe("parseToolList", () => {
		it("parses comma-separated strings with trimming and deduplication", () => {
			assert.deepEqual(parseToolList("read, grep , read, find , "), [
				"read",
				"grep",
				"find",
			]);
		});

		it("parses YAML string arrays with trimming and deduplication", () => {
			assert.deepEqual(parseToolList(["bash", " edit ", "bash", "write"]), [
				"bash",
				"edit",
				"write",
			]);
		});

		it("returns undefined for empty or invalid values", () => {
			assert.equal(parseToolList(undefined), undefined);
			assert.equal(parseToolList(null), undefined);
			assert.equal(parseToolList(""), undefined);
			assert.equal(parseToolList("  ,  , "), undefined);
			assert.equal(parseToolList([]), undefined);
			assert.equal(parseToolList(["  ", ""]), undefined);
			assert.equal(parseToolList([123, false, null]), undefined);
			assert.equal(parseToolList(42), undefined);
			assert.equal(parseToolList({ tools: ["read"] }), undefined);
		});
	});

	describe("discoverAgents", () => {
		it("loads user profiles from agentDir/agents/*.md and skips malformed or missing-name files", () => {
			const agentDir = join(rootTemp, "user-only-agent-dir");
			const agentsDir = join(agentDir, "agents");
			mkdirSync(agentsDir, { recursive: true });
			mkdirSync(join(agentsDir, "subdir.md"), { recursive: true });

			writeFileSync(
				join(agentsDir, "reviewer.md"),
				[
					"---",
					"name: reviewer",
					"description: Reviews code carefully",
					"model: anthropic/claude-sonnet-4",
					"thinking: high",
					"mode: readonly",
					"workspace: inherit",
					"tools: read, grep, find",
					"---",
					"Inspect diffs thoroughly.",
					"",
				].join("\n"),
				"utf8",
			);

			writeFileSync(
				join(agentsDir, "builder.md"),
				[
					"---",
					"name: builder",
					"description: Builds features",
					"mode: coder",
					"workspace: worktree",
					"tools:",
					"  - read",
					"  - edit",
					"  - bash",
					"---",
					"Implement requested changes cleanly.",
				].join("\n"),
				"utf8",
			);

			// Missing name -> skipped
			writeFileSync(
				join(agentsDir, "no-name.md"),
				["---", "description: Missing name field", "---", "Body"].join("\n"),
				"utf8",
			);

			// Empty name -> skipped
			writeFileSync(
				join(agentsDir, "empty-name.md"),
				["---", "name: \"   \"", "---", "Body"].join("\n"),
				"utf8",
			);

			// Malformed YAML frontmatter -> skipped without crashing
			writeFileSync(
				join(agentsDir, "malformed.md"),
				["---", "name: [unclosed", "tools: {bad", "---", "Broken"].join("\n"),
				"utf8",
			);

			// Non-markdown file -> ignored
			writeFileSync(join(agentsDir, "notes.txt"), "not a profile", "utf8");

			const profiles = discoverAgents({ agentDir, cwd: rootTemp });
			assert.deepEqual(
				profiles.map((p) => p.name),
				["builder", "reviewer"],
			);

			const builder = profiles[0];
			assert.equal(builder.source, "user");
			assert.equal(builder.mode, "coder");
			assert.equal(builder.workspace, "worktree");
			assert.deepEqual(builder.tools, ["read", "edit", "bash"]);
			assert.equal(builder.systemPrompt, "Implement requested changes cleanly.");

			const reviewer = profiles[1];
			assert.equal(reviewer.source, "user");
			assert.equal(reviewer.model, "anthropic/claude-sonnet-4");
			assert.equal(reviewer.thinking, "high");
			assert.equal(reviewer.mode, "readonly");
			assert.equal(reviewer.workspace, "inherit");
			assert.deepEqual(reviewer.tools, ["read", "grep", "find"]);
			assert.equal(reviewer.systemPrompt, "Inspect diffs thoroughly.");
			assert.equal(reviewer.filePath, join(agentsDir, "reviewer.md"));
		});

		it("ignores project agents by default and discovers nearest .pi/agents with override when includeProjectAgents is true", () => {
			const agentDir = join(rootTemp, "override-user-agent-dir");
			const userAgentsDir = join(agentDir, "agents");
			mkdirSync(userAgentsDir, { recursive: true });

			writeFileSync(
				join(userAgentsDir, "scout.md"),
				[
					"---",
					"name: scout",
					"description: User scout",
					"mode: readonly",
					"---",
					"User scout prompt.",
				].join("\n"),
				"utf8",
			);

			writeFileSync(
				join(userAgentsDir, "global-only.md"),
				[
					"---",
					"name: global-only",
					"description: Global agent",
					"---",
					"Global prompt.",
				].join("\n"),
				"utf8",
			);

			const repoRoot = join(rootTemp, "repo-with-agents");
			const projectAgentsDir = join(repoRoot, ".pi", "agents");
			const nestedCwd = join(repoRoot, "packages", "web", "src");
			mkdirSync(join(repoRoot, ".git"), { recursive: true });
			mkdirSync(projectAgentsDir, { recursive: true });
			mkdirSync(nestedCwd, { recursive: true });

			writeFileSync(
				join(projectAgentsDir, "scout.md"),
				[
					"---",
					"name: scout",
					"description: Project scout override",
					"mode: coder",
					"workspace: worktree",
					"---",
					"Project scout prompt.",
				].join("\n"),
				"utf8",
			);

			writeFileSync(
				join(projectAgentsDir, "local-helper.md"),
				[
					"---",
					"name: local-helper",
					"description: Repo specific helper",
					"---",
					"Local helper prompt.",
				].join("\n"),
				"utf8",
			);

			// Default (includeProjectAgents omitted / false): only user profiles
			const withoutProject = discoverAgents({ agentDir, cwd: nestedCwd });
			assert.deepEqual(
				withoutProject.map((p) => `${p.name}:${p.source}`),
				["global-only:user", "scout:user"],
			);

			// With includeProjectAgents: true -> walks up from nestedCwd, keeps user scout, and namespaces project:scout
			const withProject = discoverAgents({
				agentDir,
				cwd: nestedCwd,
				includeProjectAgents: true,
			});
			assert.deepEqual(
				withProject.map((p) => `${p.name}:${p.source}`),
				["global-only:user", "local-helper:project", "project:scout:project", "scout:user"],
			);
			const userScout = withProject.find((p) => p.name === "scout");
			assert.equal(userScout?.source, "user");
			assert.equal(userScout?.description, "User scout");
			assert.equal(userScout?.mode, "readonly");
			assert.equal(userScout?.systemPrompt, "User scout prompt.");

			const projectScout = withProject.find((p) => p.name === "project:scout");
			assert.equal(projectScout?.source, "project");
			assert.equal(projectScout?.description, "Project scout override");
			assert.equal(projectScout?.mode, "coder");
			assert.equal(projectScout?.workspace, "worktree");
			assert.equal(projectScout?.systemPrompt, "Project scout prompt.");
		});
	});

	describe("findAgentProfile", () => {
		it("returns matching profile when found and undefined when missing", () => {
			const agentDir = join(rootTemp, "find-agent-dir");
			mkdirSync(join(agentDir, "agents"), { recursive: true });
			writeFileSync(
				join(agentDir, "agents", "auditor.md"),
				["---", "name: auditor", "description: Security auditor", "---", "Audit code."].join("\n"),
				"utf8",
			);

			const found = findAgentProfile("auditor", { agentDir, cwd: rootTemp });
			assert.ok(found);
			assert.equal(found.name, "auditor");
			assert.equal(found.description, "Security auditor");

			const missing = findAgentProfile("non-existent", { agentDir, cwd: rootTemp });
			assert.equal(missing, undefined);
		});
	});
});
