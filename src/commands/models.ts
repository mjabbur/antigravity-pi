import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { initPiRuntime, type PiRuntime } from "../runtime.js";
import type { ModelSummary } from "../types.js";

export interface ModelsCommandOptions {
	query?: string;
	provider?: string;
	refresh: boolean;
	json: boolean;
}

export interface ModelsCommandDeps {
	modelRuntime?: ModelRuntime;
	agentDir?: string;
	cwd?: string;
}

export async function runModelsCommand(
	options: ModelsCommandOptions,
	deps: ModelsCommandDeps = {},
): Promise<ModelSummary[]> {
	let createdRuntime: PiRuntime | undefined;
	const modelRuntime =
		deps.modelRuntime ??
		(createdRuntime = await initPiRuntime({
			cwd: deps.cwd,
			agentDir: deps.agentDir,
			refresh: options.refresh,
		})).modelRuntime;

	try {
		const available = await modelRuntime.getAvailable(options.provider);
		const query = options.query?.trim().toLowerCase();

		const filtered = query
			? available.filter((model) => {
					const fullId = `${model.provider}/${model.id}`.toLowerCase();
					return (
						fullId.includes(query) ||
						model.id.toLowerCase().includes(query) ||
						model.name.toLowerCase().includes(query) ||
						model.provider.toLowerCase().includes(query)
					);
				})
			: [...available];

		filtered.sort((a, b) => {
			const providerCmp = a.provider.localeCompare(b.provider);
			return providerCmp !== 0 ? providerCmp : a.id.localeCompare(b.id);
		});

		return filtered.map((model) => ({
			provider: model.provider,
			id: model.id,
			name: model.name,
			reasoning: model.reasoning,
			contextWindow: model.contextWindow,
			maxTokens: model.maxTokens,
			costInput: model.cost.input,
			costOutput: model.cost.output,
			inputModalities: [...model.input],
		}));
	} finally {
		if (createdRuntime) {
			await createdRuntime.modelRuntime.settleCredentialWrites();
		}
	}
}
