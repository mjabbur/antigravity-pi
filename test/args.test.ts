import assert from "node:assert/strict";
import { resolve } from "node:path";
import { describe, it } from "node:test";
import { CliUsageError, parseCliArgs } from "../src/args.js";

describe("parseCliArgs", () => {
	describe("help and version", () => {
		it("returns help when argv is empty or uses help flags", () => {
			assert.deepEqual(parseCliArgs([]), { kind: "help" });
			assert.deepEqual(parseCliArgs(["-h"]), { kind: "help" });
			assert.deepEqual(parseCliArgs(["--help"]), { kind: "help" });
			assert.deepEqual(parseCliArgs(["help"]), { kind: "help" });
		});

		it("returns version for version flags", () => {
			assert.deepEqual(parseCliArgs(["-v"]), { kind: "version" });
			assert.deepEqual(parseCliArgs(["--version"]), { kind: "version" });
			assert.deepEqual(parseCliArgs(["version"]), { kind: "version" });
		});

		it("returns help when -h/--help is passed to subcommands", () => {
			assert.deepEqual(parseCliArgs(["models", "--help"]), { kind: "help" });
			assert.deepEqual(parseCliArgs(["agents", "-h"]), { kind: "help" });
			assert.deepEqual(parseCliArgs(["ask", "-h"]), { kind: "help" });
			assert.deepEqual(parseCliArgs(["run", "--help"]), { kind: "help" });
			assert.deepEqual(parseCliArgs(["send", "-h"]), { kind: "help" });
			assert.deepEqual(parseCliArgs(["ls", "--help"]), { kind: "help" });
			assert.deepEqual(parseCliArgs(["subagents", "-h"]), { kind: "help" });
			assert.deepEqual(parseCliArgs(["diff", "--help"]), { kind: "help" });
			assert.deepEqual(parseCliArgs(["kill", "--help"]), { kind: "help" });
			assert.deepEqual(parseCliArgs(["sessions", "-h"]), { kind: "help" });
		});
	});

	describe("models", () => {
		it("parses models with defaults", () => {
			assert.deepEqual(parseCliArgs(["models"]), {
				kind: "models",
				query: undefined,
				provider: undefined,
				refresh: false,
				json: false,
			});
		});

		it("parses models query, --provider, --refresh, and --json", () => {
			assert.deepEqual(
				parseCliArgs(["models", "claude", "-p", "anthropic", "--refresh", "--json"]),
				{
					kind: "models",
					query: "claude",
					provider: "anthropic",
					refresh: true,
					json: true,
				},
			);
		});

		it("rejects more than one positional query for models", () => {
			assert.throws(
				() => parseCliArgs(["models", "one", "two"]),
				(err: unknown) => err instanceof CliUsageError && err.exitCode === 2,
			);
		});
	});

	describe("sessions", () => {
		it("parses sessions with default limit 20", () => {
			assert.deepEqual(parseCliArgs(["sessions"]), {
				kind: "sessions",
				limit: 20,
				json: false,
			});
		});

		it("parses --limit / -n and --json", () => {
			assert.deepEqual(parseCliArgs(["sessions", "-n", "5", "--json"]), {
				kind: "sessions",
				limit: 5,
				json: true,
			});
			assert.deepEqual(parseCliArgs(["sessions", "--limit", "50"]), {
				kind: "sessions",
				limit: 50,
				json: false,
			});
		});

		it("rejects positional arguments for sessions", () => {
			assert.throws(
				() => parseCliArgs(["sessions", "extra"]),
				(err: unknown) => err instanceof CliUsageError && err.exitCode === 2,
			);
		});

		it("rejects invalid --limit values", () => {
			for (const bad of ["0", "-1", "1.5", "abc", ""]) {
				assert.throws(
					() => parseCliArgs(["sessions", "--limit", bad]),
					(err: unknown) => err instanceof CliUsageError && err.exitCode === 2,
				);
			}
		});
	});

	describe("agents", () => {
		it("parses agents with defaults and resolves defaultCwd", () => {
			assert.deepEqual(parseCliArgs(["agents"], "/workspace/project"), {
				kind: "agents",
				cwd: resolve("/workspace/project"),
				projectAgents: false,
				json: false,
			});
		});

		it("parses --cwd / -C, --project-agents, and --json", () => {
			assert.deepEqual(
				parseCliArgs(["agents", "-C", "sub/dir", "--project-agents", "--json"], "/workspace"),
				{
					kind: "agents",
					cwd: resolve("/workspace", "sub/dir"),
					projectAgents: true,
					json: true,
				},
			);
		});

		it("rejects positional arguments for agents", () => {
			assert.throws(
				() => parseCliArgs(["agents", "extra"]),
				(err: unknown) => err instanceof CliUsageError && err.exitCode === 2,
			);
		});
	});

	describe("ask", () => {
		it("parses ask options, repeatable --file, and joined prompt", () => {
			const parsed = parseCliArgs([
				"ask",
				"--model",
				"anthropic/claude-sonnet:high",
				"--thinking",
				"high",
				"--system",
				"Be terse.",
				"-f",
				"src/a.ts",
				"--file",
				"src/b.ts",
				"--session",
				"sess-123",
				"--timeout",
				"45.5",
				"--json",
				"--quiet",
				"Review",
				"these",
				"files",
			]);

			assert.deepEqual(parsed, {
				kind: "ask",
				model: "anthropic/claude-sonnet:high",
				thinking: "high",
				system: "Be terse.",
				files: ["src/a.ts", "src/b.ts"],
				sessionId: "sess-123",
				noSession: false,
				timeoutSec: 45.5,
				json: true,
				quiet: true,
				prompt: "Review these files",
			});
		});

		it("parses ask with --no-session and -q short flag", () => {
			const parsed = parseCliArgs(["ask", "--no-session", "-q", "-m", "openai/gpt-5", "Hello"]);
			assert.deepEqual(parsed, {
				kind: "ask",
				model: "openai/gpt-5",
				thinking: undefined,
				system: undefined,
				files: [],
				sessionId: undefined,
				noSession: true,
				timeoutSec: undefined,
				json: false,
				quiet: true,
				prompt: "Hello",
			});
		});

		it("supports -- separator for prompts beginning with dashes", () => {
			const parsed = parseCliArgs(["ask", "-m", "openai/gpt-5", "--", "--help", "me", "-x"]);
			assert.deepEqual(parsed, {
				kind: "ask",
				model: "openai/gpt-5",
				thinking: undefined,
				system: undefined,
				files: [],
				sessionId: undefined,
				noSession: false,
				timeoutSec: undefined,
				json: false,
				quiet: false,
				prompt: "--help me -x",
			});
		});
	});

	describe("run", () => {
		it("parses run with defaults and resolves defaultCwd", () => {
			const parsed = parseCliArgs(["run", "Inspect repo"], "/workspace/project");
			assert.deepEqual(parsed, {
				kind: "run",
				agent: undefined,
				name: undefined,
				model: undefined,
				thinking: undefined,
				mode: "readonly",
				modeExplicit: false,
				workspace: undefined,
				tools: undefined,
				cwd: resolve("/workspace/project"),
				system: undefined,
				files: [],
				projectAgents: false,
				sessionId: undefined,
				noSession: false,
				timeoutSec: undefined,
				json: false,
				quiet: false,
				prompt: "Inspect repo",
			});
		});

		it("parses --mode readonly|coder, --cwd, --thinking, --timeout, --json, --quiet, and --", () => {
			const parsed = parseCliArgs(
				[
					"run",
					"--mode",
					"coder",
					"-C",
					"packages/app",
					"-m",
					"zai/glm-5",
					"-t",
					"xhigh",
					"-s",
					"Only touch tests.",
					"--session",
					"run-1",
					"--timeout",
					"120",
					"--json",
					"-q",
					"--",
					"-fix",
					"everything",
				],
				"/workspace",
			);

			assert.deepEqual(parsed, {
				kind: "run",
				agent: undefined,
				name: undefined,
				model: "zai/glm-5",
				thinking: "xhigh",
				mode: "coder",
				modeExplicit: true,
				workspace: undefined,
				tools: undefined,
				cwd: resolve("/workspace", "packages/app"),
				system: "Only touch tests.",
				files: [],
				projectAgents: false,
				sessionId: "run-1",
				noSession: false,
				timeoutSec: 120,
				json: true,
				quiet: true,
				prompt: "-fix everything",
			});
		});

		it("parses -a/--agent, --name, -w/--workspace, --tools, -f/--file, and --project-agents", () => {
			const parsed = parseCliArgs(
				[
					"run",
					"-a",
					"reviewer",
					"--name",
					"pr-review_1",
					"-w",
					"worktree",
					"--tools",
					"read, grep, read, find",
					"-f",
					"src/a.ts",
					"--file",
					"src/b.ts",
					"--project-agents",
					"Audit",
					"changes",
				],
				"/workspace/repo",
			);

			assert.deepEqual(parsed, {
				kind: "run",
				agent: "reviewer",
				name: "pr-review_1",
				model: undefined,
				thinking: undefined,
				mode: "readonly",
				modeExplicit: false,
				workspace: "worktree",
				tools: ["read", "grep", "find"],
				cwd: resolve("/workspace/repo"),
				system: undefined,
				files: ["src/a.ts", "src/b.ts"],
				projectAgents: true,
				sessionId: undefined,
				noSession: false,
				timeoutSec: undefined,
				json: false,
				quiet: false,
				prompt: "Audit changes",
			});
		});

		it("accepts --agent, --workspace inherit, --mode readonly, and --no-session", () => {
			const parsed = parseCliArgs(
				[
					"run",
					"--agent",
					"scout",
					"--workspace",
					"inherit",
					"--mode",
					"readonly",
					"--no-session",
					"Check status",
				],
				"/tmp",
			);
			assert.equal(parsed.kind, "run");
			if (parsed.kind === "run") {
				assert.equal(parsed.agent, "scout");
				assert.equal(parsed.workspace, "inherit");
				assert.equal(parsed.mode, "readonly");
				assert.equal(parsed.modeExplicit, true);
				assert.equal(parsed.noSession, true);
				assert.equal(parsed.sessionId, undefined);
			}
		});
	});

	describe("send", () => {
		it("parses send with target, options, repeatable --file, and joined prompt", () => {
			const parsed = parseCliArgs([
				"send",
				"worker-1",
				"-m",
				"openai/gpt-5",
				"-t",
				"high",
				"-f",
				"a.ts",
				"--file",
				"b.ts",
				"--timeout",
				"30",
				"--json",
				"-q",
				"Please",
				"continue",
			]);

			assert.deepEqual(parsed, {
				kind: "send",
				target: "worker-1",
				model: "openai/gpt-5",
				thinking: "high",
				files: ["a.ts", "b.ts"],
				timeoutSec: 30,
				json: true,
				quiet: true,
				prompt: "Please continue",
			});
		});

		it("parses send without inline prompt (for stdin prompt input)", () => {
			assert.deepEqual(parseCliArgs(["send", "worker-1"]), {
				kind: "send",
				target: "worker-1",
				model: undefined,
				thinking: undefined,
				files: [],
				timeoutSec: undefined,
				json: false,
				quiet: false,
				prompt: undefined,
			});
		});
	});

	describe("ls and subagents alias", () => {
		it("parses ls and subagents with default limit 20", () => {
			assert.deepEqual(parseCliArgs(["ls"]), {
				kind: "ls",
				status: undefined,
				limit: 20,
				json: false,
			});
			assert.deepEqual(parseCliArgs(["subagents"]), {
				kind: "ls",
				status: undefined,
				limit: 20,
				json: false,
			});
		});

		it("parses --status, --limit/-n, and --json for ls and subagents", () => {
			assert.deepEqual(
				parseCliArgs(["ls", "--status", "idle", "-n", "5", "--json"]),
				{
					kind: "ls",
					status: "idle",
					limit: 5,
					json: true,
				},
			);
			assert.deepEqual(
				parseCliArgs(["subagents", "--status", "running", "--limit", "10"]),
				{
					kind: "ls",
					status: "running",
					limit: 10,
					json: false,
				},
			);
		});

		it("rejects unexpected positional arguments for ls and subagents", () => {
			for (const cmd of ["ls", "subagents"]) {
				assert.throws(
					() => parseCliArgs([cmd, "extra"]),
					(err: unknown) => err instanceof CliUsageError && err.exitCode === 2,
				);
			}
		});
	});

	describe("diff", () => {
		it("parses diff target with defaults and with --stat / --json", () => {
			assert.deepEqual(parseCliArgs(["diff", "worker-1"]), {
				kind: "diff",
				target: "worker-1",
				statOnly: false,
				json: false,
			});
			assert.deepEqual(parseCliArgs(["diff", "worker-1", "--stat", "--json"]), {
				kind: "diff",
				target: "worker-1",
				statOnly: true,
				json: true,
			});
		});

		it("rejects extra positional arguments for diff", () => {
			assert.throws(
				() => parseCliArgs(["diff", "a", "b"]),
				(err: unknown) => err instanceof CliUsageError && err.exitCode === 2,
			);
		});
	});

	describe("kill", () => {
		it("parses kill with target or --all, --force, --delete-branch, and --json", () => {
			assert.deepEqual(parseCliArgs(["kill", "worker-1"]), {
				kind: "kill",
				target: "worker-1",
				all: false,
				force: false,
				deleteBranch: false,
				json: false,
			});
			assert.deepEqual(
				parseCliArgs(["kill", "--all", "--force", "--delete-branch", "--json"]),
				{
					kind: "kill",
					target: undefined,
					all: true,
					force: true,
					deleteBranch: true,
					json: true,
				},
			);
		});

		it("rejects extra positional arguments for kill", () => {
			assert.throws(
				() => parseCliArgs(["kill", "a", "b"]),
				(err: unknown) => err instanceof CliUsageError && err.exitCode === 2,
			);
		});
	});

	describe("CliUsageError validation", () => {
		it("throws CliUsageError on invalid subcommand or unknown top-level option", () => {
			assert.throws(
				() => parseCliArgs(["unknown-cmd"]),
				(err: unknown) => err instanceof CliUsageError && err.exitCode === 2,
			);
			assert.throws(
				() => parseCliArgs(["--unknown-flag"]),
				(err: unknown) => err instanceof CliUsageError && err.exitCode === 2,
			);
			assert.throws(
				() => parseCliArgs(["ask", "--unknown-flag", "hi"]),
				(err: unknown) => err instanceof CliUsageError && err.exitCode === 2,
			);
		});

		it("throws CliUsageError on invalid --thinking", () => {
			for (const cmd of ["ask", "run"]) {
				assert.throws(
					() => parseCliArgs([cmd, "--thinking", "ultra", "hi"]),
					(err: unknown) => err instanceof CliUsageError && err.exitCode === 2,
				);
			}
		});

		it("throws CliUsageError on invalid --mode", () => {
			assert.throws(
				() => parseCliArgs(["run", "--mode", "admin", "hi"]),
				(err: unknown) => err instanceof CliUsageError && err.exitCode === 2,
			);
		});

		it("throws CliUsageError on invalid --workspace", () => {
			assert.throws(
				() => parseCliArgs(["run", "--workspace", "sandbox", "hi"]),
				(err: unknown) => err instanceof CliUsageError && err.exitCode === 2,
			);
		});

		it("throws CliUsageError on invalid --status", () => {
			for (const cmd of ["ls", "subagents"]) {
				assert.throws(
					() => parseCliArgs([cmd, "--status", "paused"]),
					(err: unknown) => err instanceof CliUsageError && err.exitCode === 2,
				);
			}
		});

		it("throws CliUsageError on invalid --tools", () => {
			for (const bad of ["", " , ", "read,", ",grep", "read, ,grep"]) {
				assert.throws(
					() => parseCliArgs(["run", "--tools", bad, "hi"]),
					(err: unknown) => err instanceof CliUsageError && err.exitCode === 2,
				);
			}
		});

		it("throws CliUsageError on invalid --name", () => {
			for (const bad of ["", "-leading-dash", ".leading-dot", "_leading-underscore", "bad name", "a".repeat(65)]) {
				assert.throws(
					() => parseCliArgs(["run", "--name", bad, "hi"]),
					(err: unknown) => err instanceof CliUsageError && err.exitCode === 2,
				);
			}
		});

		it("throws CliUsageError when kill is missing both target and --all or combines them", () => {
			assert.throws(
				() => parseCliArgs(["kill"]),
				(err: unknown) => err instanceof CliUsageError && err.exitCode === 2,
			);
			assert.throws(
				() => parseCliArgs(["kill", "worker-1", "--all"]),
				(err: unknown) => err instanceof CliUsageError && err.exitCode === 2,
			);
		});

		it("throws CliUsageError when send or diff is missing target", () => {
			assert.throws(
				() => parseCliArgs(["send"]),
				(err: unknown) => err instanceof CliUsageError && err.exitCode === 2,
			);
			assert.throws(
				() => parseCliArgs(["diff"]),
				(err: unknown) => err instanceof CliUsageError && err.exitCode === 2,
			);
		});

		it("throws CliUsageError on invalid --timeout", () => {
			for (const bad of ["0", "-5", "abc", "Infinity", "NaN"]) {
				assert.throws(
					() => parseCliArgs(["ask", "--timeout", bad, "hi"]),
					(err: unknown) => err instanceof CliUsageError && err.exitCode === 2,
				);
			}
		});

		it("throws CliUsageError when combining --session and --no-session", () => {
			assert.throws(
				() => parseCliArgs(["ask", "--session", "abc", "--no-session", "hi"]),
				(err: unknown) => err instanceof CliUsageError && err.exitCode === 2,
			);
			assert.throws(
				() => parseCliArgs(["run", "--session", "abc", "--no-session", "hi"]),
				(err: unknown) => err instanceof CliUsageError && err.exitCode === 2,
			);
		});
	});
});
