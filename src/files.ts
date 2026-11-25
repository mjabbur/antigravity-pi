import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import { resolve } from "node:path";
import { CliUsageError } from "./args.js";

export const MAX_ATTACHED_FILE_BYTES = 512 * 1024;
export const MAX_TOTAL_ATTACHED_BYTES = 2 * 1024 * 1024;
export const MAX_STDIN_BYTES = 2 * 1024 * 1024;

export interface AttachedFile {
	path: string;
	content: string;
	bytes: number;
}

function readSingleAttachedFile(inputPath: string, cwd: string): AttachedFile {
	const resolvedPath = resolve(cwd, inputPath);
	let fd: number;
	try {
		fd = openSync(resolvedPath, constants.O_RDONLY);
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		throw new Error(`Cannot access attached file "${inputPath}" (${resolvedPath}): ${detail}`);
	}

	try {
		const stats = fstatSync(fd);
		if (!stats.isFile()) {
			throw new Error(`Attached path is not a regular file: "${inputPath}" (${resolvedPath})`);
		}
		if (stats.size > MAX_ATTACHED_FILE_BYTES) {
			throw new Error(
				`Attached file "${inputPath}" exceeds ${MAX_ATTACHED_FILE_BYTES} byte limit (${stats.size} bytes).`,
			);
		}

		const buffer = Buffer.allocUnsafe(MAX_ATTACHED_FILE_BYTES + 1);
		let bytesRead = 0;
		while (bytesRead < buffer.length) {
			const chunk = readSync(fd, buffer, bytesRead, buffer.length - bytesRead, null);
			if (chunk === 0) break;
			bytesRead += chunk;
		}
		if (bytesRead > MAX_ATTACHED_FILE_BYTES) {
			throw new Error(
				`Attached file "${inputPath}" exceeds ${MAX_ATTACHED_FILE_BYTES} byte limit (${bytesRead} bytes).`,
			);
		}

		return {
			path: resolvedPath,
			content: buffer.subarray(0, bytesRead).toString("utf8"),
			bytes: bytesRead,
		};
	} finally {
		closeSync(fd);
	}
}

export async function loadAttachedFiles(paths: string[], cwd: string): Promise<AttachedFile[]> {
	const results: AttachedFile[] = [];
	let totalBytes = 0;

	for (const inputPath of paths) {
		const attached = readSingleAttachedFile(inputPath, cwd);
		totalBytes += attached.bytes;
		if (totalBytes > MAX_TOTAL_ATTACHED_BYTES) {
			throw new Error(
				`Total attached files size exceeds ${MAX_TOTAL_ATTACHED_BYTES} byte limit (${totalBytes} bytes).`,
			);
		}
		results.push(attached);
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
	let remainingBytes = MAX_STDIN_BYTES;
	for await (const chunk of stream) {
		const buf = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : Buffer.from(chunk);
		remainingBytes -= buf.length;
		if (remainingBytes < 0) {
			throw new CliUsageError(
				`Stdin prompt exceeds ${MAX_STDIN_BYTES} byte limit (${MAX_STDIN_BYTES - remainingBytes} bytes).`,
			);
		}
		chunks.push(buf);
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
