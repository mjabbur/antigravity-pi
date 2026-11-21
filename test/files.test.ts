import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { after, describe, it } from "node:test";
import { CliUsageError } from "../src/args.js";
import {
	formatPromptWithFiles,
	loadAttachedFiles,
	MAX_ATTACHED_FILE_BYTES,
	resolvePromptInput,
} from "../src/files.js";

describe("files helpers", () => {
	const tempDir = mkdtempSync(join(os.tmpdir(), "agy-pi-files-test-"));

	after(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	describe("loadAttachedFiles", () => {
		it("loads files using both relative and absolute paths", async () => {
			const subDir = join(tempDir, "nested");
			mkdirSync(subDir, { recursive: true });

			const relTarget = join(subDir, "hello.txt");
			const absTarget = join(tempDir, "utf8.txt");
			writeFileSync(relTarget, "hello world", "utf8");
			writeFileSync(absTarget, "hello — 🚀", "utf8");

			const loaded = await loadAttachedFiles(["nested/hello.txt", absTarget], tempDir);
			assert.equal(loaded.length, 2);

			assert.deepEqual(loaded[0], {
				path: relTarget,
				content: "hello world",
				bytes: Buffer.byteLength("hello world", "utf8"),
			});
			assert.deepEqual(loaded[1], {
				path: absTarget,
				content: "hello — 🚀",
				bytes: Buffer.byteLength("hello — 🚀", "utf8"),
			});
			assert.equal(loaded[1].bytes, 14);
		});

		it("accepts a file of exactly MAX_ATTACHED_FILE_BYTES (512 KiB)", async () => {
			const exactFile = join(tempDir, "exact-512k.bin");
			writeFileSync(exactFile, Buffer.alloc(MAX_ATTACHED_FILE_BYTES, "a"));

			const loaded = await loadAttachedFiles(["exact-512k.bin"], tempDir);
			assert.equal(loaded.length, 1);
			assert.equal(loaded[0].bytes, MAX_ATTACHED_FILE_BYTES);
		});

		it("rejects missing file", async () => {
			await assert.rejects(
				() => loadAttachedFiles(["does-not-exist.ts"], tempDir),
				/Cannot access attached file/,
			);
		});

		it("rejects directory path", async () => {
			const dirPath = join(tempDir, "a-dir");
			mkdirSync(dirPath, { recursive: true });

			await assert.rejects(
				() => loadAttachedFiles(["a-dir"], tempDir),
				/not a regular file/,
			);
		});

		it("rejects files larger than 512 KiB", async () => {
			const bigFile = join(tempDir, "too-big.txt");
			writeFileSync(bigFile, Buffer.alloc(MAX_ATTACHED_FILE_BYTES + 1, "x"));

			await assert.rejects(
				() => loadAttachedFiles([bigFile], tempDir),
				/exceeds 524288 byte limit/,
			);
		});
	});

	describe("formatPromptWithFiles", () => {
		it("returns prompt unchanged when there are no files", () => {
			assert.equal(formatPromptWithFiles("Explain this.", []), "Explain this.");
		});

		it("formats attached files in <file path=\"...\"> blocks before prompt", () => {
			const formatted = formatPromptWithFiles("Review both files.", [
				{ path: "/repo/a.ts", content: "const a = 1;" },
				{ path: "/repo/b.ts", content: "const b = 2;\n" },
			]);

			assert.equal(
				formatted,
				[
					`<file path="/repo/a.ts">\nconst a = 1;\n</file>`,
					`<file path="/repo/b.ts">\nconst b = 2;\n\n</file>`,
					"Review both files.",
				].join("\n\n"),
			);
		});
	});

	describe("resolvePromptInput", () => {
		it("returns trimmed prompt argument directly", async () => {
			const result = await resolvePromptInput("  hello world  ");
			assert.equal(result, "hello world");
		});

		it("reads from stdin when prompt argument is '-' or stdin is non-TTY", async () => {
			const streamA = Object.assign(Readable.from(["  from dash stdin \n"]), { isTTY: true });
			assert.equal(await resolvePromptInput("-", streamA), "from dash stdin");

			const streamB = Object.assign(Readable.from(["piped ", "prompt\n"]), { isTTY: false });
			assert.equal(await resolvePromptInput(undefined, streamB), "piped prompt");
		});

		it("throws CliUsageError when missing prompt on TTY or empty prompt", async () => {
			const ttyStream = Object.assign(Readable.from([]), { isTTY: true });
			await assert.rejects(
				() => resolvePromptInput(undefined, ttyStream),
				(err: unknown) => err instanceof CliUsageError,
			);

			const emptyStream = Object.assign(Readable.from(["   \n\t "]), { isTTY: false });
			await assert.rejects(
				() => resolvePromptInput(undefined, emptyStream),
				(err: unknown) => err instanceof CliUsageError,
			);
		});
	});
});
