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
			assert.deepEqual(parseCliArgs(["ask", "-h"]), { kind: "help" });
			assert.deepEqual(parseCliArgs(["run", "--help"]), { kind: "help" });
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
				model: undefined,
				thinking: undefined,
				mode: "readonly",
				cwd: resolve("/workspace/project"),
				system: undefined,
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
				model: "zai/glm-5",
				thinking: "xhigh",
				mode: "coder",
				cwd: resolve("/workspace", "packages/app"),
				system: "Only touch tests.",
				sessionId: "run-1",
				noSession: false,
				timeoutSec: 120,
				json: true,
				quiet: true,
				prompt: "-fix everything",
			});
		});

		it("accepts --mode readonly and --no-session", () => {
			const parsed = parseCliArgs(["run", "--mode", "readonly", "--no-session", "Check status"], "/tmp");
			assert.equal(parsed.kind, "run");
			if (parsed.kind === "run") {
				assert.equal(parsed.mode, "readonly");
				assert.equal(parsed.noSession, true);
				assert.equal(parsed.sessionId, undefined);
			}
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
