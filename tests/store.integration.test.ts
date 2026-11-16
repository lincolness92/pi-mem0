/**
 * Real Mem0 OSS (SQLite vector store) with real embeddings from a local Ollama and a fake
 * extraction model. Skipped when Ollama or nomic-embed-text is not available.
 */
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadConfig } from "../src/config.ts";
import { createPiLlm, MemoryStore } from "../src/memory.ts";

async function ollamaReady(): Promise<boolean> {
	try {
		const res = await fetch("http://localhost:11434/api/tags", { signal: AbortSignal.timeout(2000) });
		const body = (await res.json()) as { models?: Array<{ name: string }> };
		return Boolean(body.models?.some((m) => m.name.startsWith("nomic-embed-text")));
	} catch {
		return false;
	}
}

test("stores extracted facts per project and finds them by meaning", { skip: !(await ollamaReady()) && "Ollama with nomic-embed-text not running" }, async () => {
	const dataDir = mkdtempSync(join(tmpdir(), "pi-mem0-store-"));
	const config = loadConfig({ mem0: { dataDir, userId: "tester" } });
	const prompts: string[] = [];
	const llm = createPiLlm({
		complete: async (_system, user) => {
			prompts.push(user);
			const fact = user.includes("HALF_EVEN")
				? "The interest calculation in the payments module must round with HALF_EVEN, as the internal standard requires."
				: "The nightly billing job failed because of a database connection pool timeout.";
			return JSON.stringify({ memory: [{ id: "0", text: fact, attributed_to: "assistant" }] });
		},
	});
	const store = await MemoryStore.create(config, config.embedder, llm);
	const meta = (project: string) => ({ project, project_root: `/work/${project}`, session_id: "s1", captured_at: "2026-11-16" });

	const a = await store.add(
		[
			{ role: "user", content: "Corrija o arredondamento dos juros" },
			{ role: "assistant", content: "Final answer:\nAgora usa HALF_EVEN." },
		],
		{ userId: "tester", agentId: "proj-pagamentos" },
		meta("pagamentos"),
	);
	assert.equal(a.length, 1);
	await store.add(
		[
			{ role: "user", content: "Por que o job noturno falhou?" },
			{ role: "assistant", content: "Timeout no pool do banco." },
		],
		{ userId: "tester", agentId: "proj-faturamento" },
		meta("faturamento"),
	);
	assert.equal(prompts.length, 2, "one extraction call per task");

	const inProject = await store.search("como arredondar juros", { userId: "tester", agentId: "proj-pagamentos" }, 5);
	assert.equal(inProject.length, 1);
	assert.match(inProject[0]?.memory ?? "", /HALF_EVEN/);
	assert.equal(inProject[0]?.project, "pagamentos");

	const everywhere = await store.search("database timeout", { userId: "tester" }, 5);
	assert.match(everywhere[0]?.memory ?? "", /pool timeout/);

	const verbatim = await store.add([{ role: "user", content: "Prefira testes com node:test." }], { userId: "tester", agentId: "proj-pagamentos" }, meta("pagamentos"), false);
	assert.equal(verbatim[0]?.memory, "Prefira testes com node:test.");
	assert.equal(prompts.length, 2, "verbatim add skips extraction");

	const listed = await store.list({ userId: "tester", agentId: "proj-pagamentos" }, 10);
	assert.equal(listed.length, 2);
	await store.delete(listed[0]?.id as string);
	assert.equal((await store.list({ userId: "tester", agentId: "proj-pagamentos" }, 10)).length, 1);
});
