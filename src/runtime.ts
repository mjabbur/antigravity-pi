import { existsSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { type Api, clampThinkingLevel, type Model } from "@earendil-works/pi-ai";
import {
	createAgentSessionServices,
	getAgentDir,
	ModelRuntime,
	resolveCliModel,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";

function hasNonEmptyDirectory(dirPath: string): boolean {
	try {
		return existsSync(dirPath) && readdirSync(dirPath).length > 0;
	} catch {
		return false;
	}
}

export class CliAbortError extends Error {
	readonly exitCode: number;

	constructor(message = "Operation aborted", exitCode = 130) {
		super(message);
		this.name = "CliAbortError";
		this.exitCode = exitCode;
	}
}

export interface PiRuntime {
	modelRuntime: ModelRuntime;
	settingsManager: SettingsManager;
	agentDir: string;
}

export async function initPiRuntime(options?: {
	cwd?: string;
	agentDir?: string;
	refresh?: boolean;
}): Promise<PiRuntime> {
	const cwd = resolve(options?.cwd ?? process.cwd());
	const agentDir = options?.agentDir ? resolve(options.agentDir) : getAgentDir();
	const authPath = options?.agentDir ? join(agentDir, "auth.json") : undefined;
	const modelsPath = options?.agentDir ? join(agentDir, "models.json") : undefined;
	const refresh = options?.refresh === true;

	const settingsManager = SettingsManager.create(cwd, agentDir);
	const modelRuntime = await ModelRuntime.create({
		authPath,
		modelsPath,
		allowModelNetwork: refresh,
	});

	if (hasNonEmptyDirectory(join(agentDir, "extensions"))) {
		const services = await createAgentSessionServices({
			cwd,
			agentDir,
			modelRuntime,
			settingsManager,
			resourceLoaderOptions: {
				noSkills: true,
				noPromptTemplates: true,
				noThemes: true,
				noContextFiles: true,
			},
		});
		if (refresh) {
			await services.modelRuntime.refresh({ allowNetwork: true });
		}
		return {
			modelRuntime: services.modelRuntime,
			settingsManager: services.settingsManager,
			agentDir: services.agentDir,
		};
	}

	return {
		modelRuntime,
		settingsManager,
		agentDir,
	};
}

export async function resolveTargetModel(options: {
	modelRuntime: ModelRuntime;
	settingsManager: SettingsManager;
	modelSpec?: string;
	thinking?: ThinkingLevel;
	defaultThinking?: ThinkingLevel;
	fallbackSessionModel?: { provider: string; modelId: string } | null;
}): Promise<{ model: Model<Api>; thinkingLevel: ThinkingLevel; warning?: string }> {
	const { modelRuntime, settingsManager, modelSpec, thinking, fallbackSessionModel } = options;

	let model: Model<Api> | undefined;
	let parsedThinking: ThinkingLevel | undefined;
	let warning: string | undefined;

	if (modelSpec) {
		const resolved = resolveCliModel({
			cliModel: modelSpec,
			cliThinking: thinking,
			modelRuntime,
		});
		if (resolved.error || !resolved.model) {
			throw new Error(
				`${resolved.error ?? `Model "${modelSpec}" not found.`} Run 'agy-pi models' to list available models.`,
			);
		}
		const availableForProvider = modelRuntime.hasConfiguredAuth(resolved.model.provider)
			? [resolved.model]
			: await modelRuntime.getAvailable(resolved.model.provider);
		if (availableForProvider.length === 0) {
			throw new Error(
				`Provider "${resolved.model.provider}" has no configured credentials. Run 'agy-pi models' to list available models.`,
			);
		}
		model = resolved.model;
		parsedThinking = resolved.thinkingLevel;
		warning = resolved.warning;
	} else {
		if (fallbackSessionModel) {
			const sessionModel = modelRuntime.getModel(
				fallbackSessionModel.provider,
				fallbackSessionModel.modelId,
			);
			if (sessionModel && modelRuntime.hasConfiguredAuth(sessionModel.provider)) {
				model = sessionModel;
			} else {
				warning = `Could not restore session model ${fallbackSessionModel.provider}/${fallbackSessionModel.modelId}; using default model.`;
			}
		}

		if (!model) {
			const defaultProvider = settingsManager.getDefaultProvider();
			const defaultModelId = settingsManager.getDefaultModel();
			if (defaultProvider && defaultModelId) {
				const defaultModel = modelRuntime.getModel(defaultProvider, defaultModelId);
				if (defaultModel && modelRuntime.hasConfiguredAuth(defaultModel.provider)) {
					model = defaultModel;
				}
			}
		}

		if (!model) {
			const available = await modelRuntime.getAvailable();
			if (available.length === 0) {
				throw new Error(
					"No models available with configured credentials. Configure provider auth in ~/.pi/agent/auth.json or environment variables, then run 'agy-pi models'.",
				);
			}
			model = available[0];
		}
	}

	const desiredThinking: ThinkingLevel =
		thinking ??
		parsedThinking ??
		settingsManager.getModelThinkingLevel(model.provider, model.id) ??
		settingsManager.getDefaultThinkingLevel() ??
		options.defaultThinking ??
		"off";

	const thinkingLevel = clampThinkingLevel(model, desiredThinking);
	return {
		model,
		thinkingLevel,
		...(warning ? { warning } : {}),
	};
}
