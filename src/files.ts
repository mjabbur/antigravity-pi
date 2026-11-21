import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { CliUsageError } from "./args.js";

export const MAX_ATTACHED_FILE_BYTES = 512 * 1024;

export interface AttachedFile {
	path: string;
	content: string;
	bytes: number;
}

export async function loadAttachedFiles(paths: string[], cwd: string): Promise<AttachedFile[]> {
	const results: AttachedFile[] = [];

	for (const inputPath of paths) {
		const resolvedPath = resolve(cwd, inputPath);
		let stats;
		try {
			stats = await stat(resolvedPath);
		} catch (error) {
			const detail = error instanceof Error ? error.message : String(error);
			throw new Error(`Cannot access attached file "${inputPath}" (${resolvedPath}): ${detail}`);
		}

		if (!stats.isFile()) {
			throw new Error(`Attached path is not a regular file: "${inputPath}" (${resolvedPath})`);
		}

		if (stats.size > MAX_ATTACHED_FILE_BYTES) {
			throw new Error(
				`Attached file "${inputPath}" exceeds ${MAX_ATTACHED_FILE_BYTES} byte limit (${stats.size} bytes).`,
			);
		}

		const content = await readFile(resolvedPath, "utf8");
		results.push({
			path: resolvedPath,
			content,
			bytes: Buffer.byteLength(content, "utf8"),
		});
	}

	return results;
}

export function formatPromptWithFiles(
	prompt: string,
	files: Array<{ path: string; content: string }>,
): string {
	if (files.length === 0) {
		return prompt;
	}
	const fileBlocks = files.map((file) => `<file path="${file.path}">\n${file.content}\n</file>`);
	return `${fileBlocks.join("\n\n")}\n\n${prompt}`;
}

export async function readStdinText(stream: NodeJS.ReadableStream = process.stdin): Promise<string> {
	const chunks: Buffer[] = [];
	for await (const chunk of stream) {
		chunks.push(typeof chunk === "string" ? Buffer.from(chunk, "utf8") : Buffer.from(chunk));
	}
	return Buffer.concat(chunks).toString("utf8");
}

export async function resolvePromptInput(
	promptArg: string | undefined,
	stdin: NodeJS.ReadableStream & { isTTY?: boolean } = process.stdin,
): Promise<string> {
	let raw: string;
	if (promptArg === "-") {
		raw = await readStdinText(stdin);
	} else if (promptArg !== undefined) {
		raw = promptArg;
	} else if (!stdin.isTTY) {
		raw = await readStdinText(stdin);
	} else {
		throw new CliUsageError("Prompt is required. Pass it as an argument or pipe via stdin.");
	}

	const trimmed = raw.trim();
	if (!trimmed) {
		throw new CliUsageError("Prompt cannot be empty.");
	}
	return trimmed;
}
