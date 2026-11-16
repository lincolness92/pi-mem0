import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Mem0Config } from "./config.ts";

export interface MemoryItem {
	id: string;
	memory: string;
	score?: number;
	createdAt?: string;
	project?: string;
}

export interface Scope {
	userId: string;
	/** Project id; omit to search every project of the user. */
	agentId?: string;
}

/** The slice of Mem0's LLM interface that memory extraction uses. */
export interface Mem0Llm {
	generateResponse(
		messages: Array<{ role: string; content: unknown }>,
		responseFormat?: { type?: string },
		tools?: unknown,
	): Promise<string>;
	generateChat(messages: Array<{ role: string; content: unknown }>): Promise<{ content: string; role: string }>;
}

/** Minimal model-call surface taken from pi's model registry, so tests can fake it. */
export interface ModelCaller {
	complete(systemPrompt: string, userPrompt: string): Promise<string>;
}

const JSON_ONLY = "Respond with one valid JSON object only. No prose, no code fences.";

function contentText(content: unknown): string {
	return typeof content === "string" ? content : JSON.stringify(content);
}

/** Adapter that lets Mem0 extract facts with any model configured in pi. */
export function createPiLlm(caller: ModelCaller): Mem0Llm {
	const run = async (messages: Array<{ role: string; content: unknown }>, json: boolean) => {
		const system = messages
			.filter((m) => m.role === "system")
			.map((m) => contentText(m.content))
			.join("\n\n");
		const user = messages
			.filter((m) => m.role !== "system")
			.map((m) => (m.role === "user" ? contentText(m.content) : `[${m.role}]\n${contentText(m.content)}`))
			.join("\n\n");
		return caller.complete(json ? `${system}\n\n${JSON_ONLY}`.trim() : system, user);
	};
	return {
		generateResponse: (messages, responseFormat) => run(messages, responseFormat?.type === "json_object"),
		generateChat: async (messages) => ({ content: await run(messages, false), role: "assistant" }),
	};
}

type Mem0Memory = {
	llm: unknown;
	add(messages: unknown, options: Record<string, unknown>): Promise<unknown>;
	search(query: string, options: Record<string, unknown>): Promise<unknown>;
	getAll(options: Record<string, unknown>): Promise<unknown>;
	delete(id: string): Promise<unknown>;
};

function normalize(raw: unknown): MemoryItem[] {
	const list = Array.isArray(raw)
		? raw
		: raw && typeof raw === "object" && Array.isArray((raw as { results?: unknown }).results)
			? (raw as { results: unknown[] }).results
			: [];
	const items: MemoryItem[] = [];
	for (const entry of list as Array<Record<string, unknown>>) {
		if (!entry || typeof entry !== "object") continue;
		const id = entry.id ?? entry.memory_id;
		const memory = entry.memory ?? entry.text;
		if (typeof id !== "string" || typeof memory !== "string") continue;
		const metadata = (entry.metadata ?? {}) as Record<string, unknown>;
		const createdAt = entry.created_at ?? entry.createdAt;
		const project = metadata.project ?? entry.project;
		items.push({
			id,
			memory,
			...(typeof entry.score === "number" ? { score: entry.score } : {}),
			...(typeof createdAt === "string" ? { createdAt } : {}),
			...(typeof project === "string" ? { project } : {}),
		});
	}
	return items;
}

function filters(scope: Scope): Record<string, string> {
	return { user_id: scope.userId, ...(scope.agentId ? { agent_id: scope.agentId } : {}) };
}

export class MemoryStore {
	private readonly memory: Mem0Memory;

	private constructor(memory: Mem0Memory) {
		this.memory = memory;
	}

	/**
	 * Build a Mem0 OSS instance stored under dataDir. The extraction LLM is replaced by the
	 * pi adapter; the embedder comes from the config (resolved key and base URL included).
	 */
	static async create(config: Mem0Config, embedder: { provider: string; config: Record<string, unknown> }, llm: Mem0Llm) {
		mkdirSync(config.dataDir, { recursive: true });
		// Mem0 reads these when its module loads, so they must be set before the import.
		process.env.MEM0_TELEMETRY = config.telemetry ? "true" : "false";
		process.env.MEM0_DIR ??= join(config.dataDir, "mem0-home");
		const mod = (await import("mem0ai/oss")) as { Memory: new (cfg: unknown) => Mem0Memory };
		const vectorStore = config.vectorStore ?? {
			provider: "memory",
			config: { collectionName: "pi_mem0", dbPath: join(config.dataDir, "vectors.db") },
		};
		const memory = new mod.Memory({
			embedder,
			// Placeholder so Mem0's config validation passes; never called (replaced below).
			llm: { provider: "openai", config: { apiKey: "unused", model: "unused" } },
			vectorStore,
			historyStore: { provider: "sqlite", config: { historyDbPath: join(config.dataDir, "history.db") } },
			...(config.customInstructions ? { customInstructions: config.customInstructions } : {}),
		});
		memory.llm = llm;
		// Surfaces embedder and storage errors now instead of on the first capture.
		await memory.getAll({ filters: { user_id: "__warmup__" }, topK: 1 });
		return new MemoryStore(memory);
	}

	async add(
		messages: Array<{ role: string; content: string }>,
		scope: Required<Scope>,
		metadata: Record<string, string>,
		infer = true,
	): Promise<MemoryItem[]> {
		const result = await this.memory.add(messages, {
			userId: scope.userId,
			agentId: scope.agentId,
			metadata,
			infer,
		});
		return normalize(result);
	}

	async search(query: string, scope: Scope, limit: number): Promise<MemoryItem[]> {
		return normalize(await this.memory.search(query, { filters: filters(scope), topK: limit }));
	}

	async list(scope: Scope, limit: number): Promise<MemoryItem[]> {
		const items = normalize(await this.memory.getAll({ filters: filters(scope), topK: 10_000 }));
		items.sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? ""));
		return items.slice(0, limit);
	}

	async delete(id: string): Promise<void> {
		await this.memory.delete(id);
	}
}

export function formatItems(items: readonly MemoryItem[], options: { showProject: boolean }): string {
	return items
		.map((item) => {
			const meta = [
				item.createdAt ? item.createdAt.slice(0, 10) : undefined,
				options.showProject && item.project ? item.project : undefined,
				typeof item.score === "number" ? `score ${item.score.toFixed(2)}` : undefined,
			].filter(Boolean);
			return `- ${item.memory.replace(/\s+/g, " ").trim()} (${[...meta, `id ${item.id}`].join(", ")})`;
		})
		.join("\n");
}
