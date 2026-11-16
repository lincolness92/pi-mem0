import { homedir } from "node:os";
import { join } from "node:path";

export interface ProviderBlock {
	provider: string;
	config: Record<string, unknown>;
	/** Reuse the API key and base URL of this pi provider (from pi's model registry). */
	piProvider?: string;
	/** Read the API key from this environment variable. */
	apiKeyEnv?: string;
}

export interface Mem0Config {
	enabled: boolean;
	/** pi model used for fact extraction, as "provider/modelId". Defaults to the session model. */
	extractionModel?: string;
	/** pi thinking level for extraction calls, or "off" to leave it to the provider default. */
	extractionReasoning: string;
	extractionTimeoutMs: number;
	embedder: ProviderBlock;
	vectorStore?: { provider: string; config?: Record<string, unknown> };
	dataDir: string;
	userId: string;
	customInstructions?: string;
	capture: {
		enabled: boolean;
		/** Include short progress messages written between tool calls, not only the final answer. */
		includeIntermediate: boolean;
		/** Upper bound for the text sent to the extraction model per task. */
		maxChars: number;
		/** Tasks whose user prompt plus answer are shorter than this are skipped. */
		minChars: number;
	};
	search: { defaultLimit: number; maxLimit: number };
	telemetry: boolean;
}

export class ConfigError extends Error {}

export const SETTINGS_KEY = "mem0";

export function defaultConfig(env: NodeJS.ProcessEnv = process.env): Mem0Config {
	const agentDir = env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
	return {
		enabled: true,
		extractionReasoning: "low",
		extractionTimeoutMs: 120_000,
		embedder: {
			provider: "openai",
			config: { model: "nomic-embed-text", baseURL: "http://localhost:11434/v1", apiKey: "ollama" },
		},
		dataDir: join(agentDir, "mem0"),
		userId: env.USER || env.USERNAME || "default-user",
		capture: { enabled: true, includeIntermediate: true, maxChars: 12_000, minChars: 80 },
		search: { defaultLimit: 5, maxLimit: 20 },
		telemetry: false,
	};
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function expectType(name: string, value: unknown, type: "string" | "boolean" | "number"): void {
	if (value !== undefined && typeof value !== type) throw new ConfigError(`mem0.${name} must be a ${type}.`);
}

function positiveInt(name: string, value: unknown): void {
	if (value !== undefined && (!Number.isInteger(value) || (value as number) <= 0)) {
		throw new ConfigError(`mem0.${name} must be a positive integer.`);
	}
}

function providerBlock(name: string, raw: unknown, fallback?: ProviderBlock): ProviderBlock {
	if (raw === undefined && fallback) return fallback;
	if (!isObject(raw) || typeof raw.provider !== "string" || !raw.provider.trim()) {
		throw new ConfigError(`mem0.${name} must be an object with a "provider" string.`);
	}
	if (raw.config !== undefined && !isObject(raw.config)) throw new ConfigError(`mem0.${name}.config must be an object.`);
	expectType(`${name}.piProvider`, raw.piProvider, "string");
	expectType(`${name}.apiKeyEnv`, raw.apiKeyEnv, "string");
	return {
		provider: raw.provider,
		config: { ...((raw.config as Record<string, unknown>) ?? {}) },
		...(raw.piProvider ? { piProvider: raw.piProvider as string } : {}),
		...(raw.apiKeyEnv ? { apiKeyEnv: raw.apiKeyEnv as string } : {}),
	};
}

/** Validate the "mem0" block of pi's settings and merge it over the defaults. */
export function loadConfig(settings: unknown, env: NodeJS.ProcessEnv = process.env): Mem0Config {
	const base = defaultConfig(env);
	const raw = isObject(settings) ? settings[SETTINGS_KEY] : undefined;
	if (raw === undefined) return base;
	if (!isObject(raw)) throw new ConfigError(`"${SETTINGS_KEY}" in settings must be an object.`);

	expectType("enabled", raw.enabled, "boolean");
	expectType("extractionModel", raw.extractionModel, "string");
	expectType("extractionReasoning", raw.extractionReasoning, "string");
	positiveInt("extractionTimeoutMs", raw.extractionTimeoutMs);
	expectType("dataDir", raw.dataDir, "string");
	expectType("userId", raw.userId, "string");
	expectType("customInstructions", raw.customInstructions, "string");
	expectType("telemetry", raw.telemetry, "boolean");
	if (typeof raw.extractionModel === "string" && !/^[^/\s]+\/\S+$/.test(raw.extractionModel)) {
		throw new ConfigError('mem0.extractionModel must look like "provider/modelId".');
	}
	if (raw.vectorStore !== undefined && (!isObject(raw.vectorStore) || typeof raw.vectorStore.provider !== "string")) {
		throw new ConfigError('mem0.vectorStore must be an object with a "provider" string.');
	}

	const capture = raw.capture === undefined ? {} : raw.capture;
	if (!isObject(capture)) throw new ConfigError("mem0.capture must be an object.");
	expectType("capture.enabled", capture.enabled, "boolean");
	expectType("capture.includeIntermediate", capture.includeIntermediate, "boolean");
	positiveInt("capture.maxChars", capture.maxChars);
	positiveInt("capture.minChars", capture.minChars);

	const search = raw.search === undefined ? {} : raw.search;
	if (!isObject(search)) throw new ConfigError("mem0.search must be an object.");
	positiveInt("search.defaultLimit", search.defaultLimit);
	positiveInt("search.maxLimit", search.maxLimit);

	const userId = typeof raw.userId === "string" ? raw.userId.trim() : base.userId;
	if (!userId) throw new ConfigError("mem0.userId must not be empty.");

	const config: Mem0Config = {
		enabled: (raw.enabled as boolean | undefined) ?? base.enabled,
		extractionReasoning: (raw.extractionReasoning as string | undefined) ?? base.extractionReasoning,
		extractionTimeoutMs: (raw.extractionTimeoutMs as number | undefined) ?? base.extractionTimeoutMs,
		embedder: providerBlock("embedder", raw.embedder, base.embedder),
		dataDir: (raw.dataDir as string | undefined) ?? base.dataDir,
		userId,
		capture: {
			enabled: (capture.enabled as boolean | undefined) ?? base.capture.enabled,
			includeIntermediate: (capture.includeIntermediate as boolean | undefined) ?? base.capture.includeIntermediate,
			maxChars: (capture.maxChars as number | undefined) ?? base.capture.maxChars,
			minChars: (capture.minChars as number | undefined) ?? base.capture.minChars,
		},
		search: {
			defaultLimit: (search.defaultLimit as number | undefined) ?? base.search.defaultLimit,
			maxLimit: (search.maxLimit as number | undefined) ?? base.search.maxLimit,
		},
		telemetry: (raw.telemetry as boolean | undefined) ?? base.telemetry,
	};
	if (typeof raw.extractionModel === "string") config.extractionModel = raw.extractionModel;
	if (typeof raw.customInstructions === "string" && raw.customInstructions.trim()) {
		config.customInstructions = raw.customInstructions;
	}
	if (isObject(raw.vectorStore)) {
		config.vectorStore = raw.vectorStore as Mem0Config["vectorStore"];
	}
	if (config.search.defaultLimit > config.search.maxLimit) {
		throw new ConfigError("mem0.search.defaultLimit cannot exceed mem0.search.maxLimit.");
	}
	return config;
}
