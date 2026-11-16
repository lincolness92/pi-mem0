import assert from "node:assert/strict";
import { test } from "node:test";
import { buildCapture } from "../src/capture.ts";

const opts = { includeIntermediate: true, maxChars: 12_000, minChars: 80 };

const user = (text: string) => ({ role: "user", content: text, timestamp: 0 });
const assistant = (text: string, toolCalls: Array<{ name: string; arguments?: object }> = []) => ({
	role: "assistant",
	content: [
		...(text ? [{ type: "text", text }] : []),
		{ type: "thinking", thinking: "private reasoning" },
		...toolCalls.map((call, i) => ({ type: "toolCall", id: `t${i}`, name: call.name, arguments: call.arguments ?? {} })),
	],
});
const toolResult = (text: string) => ({ role: "toolResult", content: [{ type: "text", text }] });

test("keeps the final answer of a multi-turn task, not the first preamble", () => {
	const task = buildCapture(
		[
			user("Corrija o cálculo de juros no módulo de pagamentos, está arredondando errado."),
			assistant("Vou ler o arquivo primeiro.", [{ name: "read", arguments: { path: "src/juros.ts" } }]),
			toolResult("conteúdo enorme do arquivo que não deve ir para a memória"),
			assistant("", [{ name: "edit", arguments: { path: "src/juros.ts" } }]),
			toolResult("ok"),
			assistant("Corrigi: o arredondamento agora usa HALF_EVEN, como exige a norma interna."),
		],
		opts,
	);
	assert.ok(task);
	const [u, a] = task.messages;
	assert.equal(u?.role, "user");
	assert.match(u?.content ?? "", /cálculo de juros/);
	assert.match(a?.content ?? "", /Final answer:\nCorrigi: o arredondamento agora usa HALF_EVEN/);
	assert.match(a?.content ?? "", /- Vou ler o arquivo primeiro\./);
	assert.match(a?.content ?? "", /Files changed: src\/juros\.ts$/);
	assert.doesNotMatch(a?.content ?? "", /conteúdo enorme|private reasoning/);
	assert.deepEqual(task.filesChanged, ["src/juros.ts"]);
});

test("drops progress notes when includeIntermediate is off", () => {
	const task = buildCapture(
		[user("Explique por que o job noturno falhou ontem e o que fazer."), assistant("Vou olhar os logs."), assistant("O job falhou por timeout no banco; aumente o pool.")],
		{ ...opts, includeIntermediate: false },
	);
	assert.equal(task?.messages[1]?.content, "O job falhou por timeout no banco; aumente o pool.");
});

test("skips tiny exchanges, empty answers and memory-only lookups", () => {
	assert.equal(buildCapture([user("oi"), assistant("Olá!")], opts), null);
	assert.equal(buildCapture([user("Faça uma análise longa do projeto inteiro, por favor.")], opts), null);
	assert.equal(
		buildCapture(
			[
				user("Procure o que decidimos sobre o arredondamento de juros na semana passada."),
				assistant("", [{ name: "mem0_memory", arguments: { action: "search", query: "arredondamento" } }]),
				toolResult("- usar HALF_EVEN"),
				assistant("Vocês decidiram usar HALF_EVEN para o arredondamento dos juros."),
			],
			opts,
		),
		null,
	);
});

test("keeps a short exchange that changed files", () => {
	const task = buildCapture([user("renomeie"), assistant("Feito.", [{ name: "write", arguments: { path: "a.ts" } }])], opts);
	assert.deepEqual(task?.filesChanged, ["a.ts"]);
});

test("deduplicates replayed prompts and redacts secrets", () => {
	const prompt = "Configure o cliente com a chave api_key=abcd1234efgh5678 e teste a conexão com o serviço.";
	const task = buildCapture([user(prompt), user(prompt), assistant("Configurado com sucesso usando Bearer abcdefghijklmnopqrstuvwxyz.")], opts);
	assert.ok(task);
	assert.equal(task.messages[0]?.content.match(/Configure/g)?.length, 1);
	assert.match(task.messages[0]?.content ?? "", /api_key=\[REDACTED\]/);
	assert.match(task.messages[1]?.content ?? "", /Bearer \[REDACTED\]/);
});

test("respects maxChars, prioritising the final answer over notes", () => {
	const notes = Array.from({ length: 50 }, (_, i) => assistant(`nota intermediária número ${i} `.repeat(10)));
	const task = buildCapture([user("x".repeat(5000)), ...notes, assistant(`FINAL ${"y".repeat(1500)}`)], { ...opts, maxChars: 3000 });
	assert.ok(task);
	const total = task.messages.reduce((sum, m) => sum + m.content.length, 0);
	assert.ok(total <= 3100, `total ${total}`);
	assert.match(task.messages[1]?.content ?? "", /FINAL y+/);
	assert.ok((task.messages[0]?.content.length ?? 0) <= 900);
});
