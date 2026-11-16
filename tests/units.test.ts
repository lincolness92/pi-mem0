import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, renameSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ConfigError, loadConfig } from "../src/config.ts";
import { createPiLlm, formatItems } from "../src/memory.ts";
import { Outbox } from "../src/outbox.ts";
import { projectScope } from "../src/project.ts";
import { redactSecrets } from "../src/redact.ts";

const env = { USER: "ana", PI_CODING_AGENT_DIR: "/tmp/agent" } as NodeJS.ProcessEnv;

test("config: defaults when the mem0 block is absent", () => {
	const config = loadConfig({ defaultModel: "x" }, env);
	assert.equal(config.userId, "ana");
	assert.equal(config.dataDir, "/tmp/agent/mem0");
	assert.equal(config.telemetry, false);
	assert.equal(config.embedder.config.model, "nomic-embed-text");
});

test("config: merges overrides and rejects invalid values", () => {
	const config = loadConfig(
		{ mem0: { extractionModel: "openai/gpt-5.4", capture: { includeIntermediate: false }, search: { defaultLimit: 3 } } },
		env,
	);
	assert.equal(config.extractionModel, "openai/gpt-5.4");
	assert.equal(config.capture.includeIntermediate, false);
	assert.equal(config.capture.maxChars, 12_000);
	assert.equal(config.search.defaultLimit, 3);
	assert.throws(() => loadConfig({ mem0: { extractionModel: "gpt-5.4" } }, env), ConfigError);
	assert.throws(() => loadConfig({ mem0: { capture: { maxChars: 0 } } }, env), ConfigError);
	assert.throws(() => loadConfig({ mem0: { embedder: { config: {} } } }, env), ConfigError);
	assert.throws(() => loadConfig({ mem0: { search: { defaultLimit: 30 } } }, env), ConfigError);
});

test("redact: removes common credential shapes and keeps normal text", () => {
	const text = [
		"token: ghp_abcdefghijklmnopqrstuvwxyz0123",
		"OPENAI_API_KEY=sk-proj-abcdefghijklmnop1234",
		"postgres://user:hunter22@db.local/app",
		"AKIAABCDEFGHIJKLMNOP",
		"-----BEGIN RSA PRIVATE KEY-----\nabc\n-----END RSA PRIVATE KEY-----",
		"o cálculo usa HALF_EVEN",
	].join("\n");
	const out = redactSecrets(text);
	for (const secret of ["ghp_abc", "sk-proj", "hunter22", "AKIAABCD", "BEGIN RSA"]) assert.ok(!out.includes(secret), secret);
	assert.match(out, /o cálculo usa HALF_EVEN/);
});

test("project: subfolders of a git repo share the same scope", () => {
	const root = mkdtempSync(join(tmpdir(), "pi-mem0-proj-"));
	mkdirSync(join(root, ".git"));
	mkdirSync(join(root, "src", "deep"), { recursive: true });
	const a = projectScope(root);
	const b = projectScope(join(root, "src", "deep"));
	assert.deepEqual(a, b);
	assert.match(a.id, /^proj-pi-mem0-proj-[a-z0-9]+-[0-9a-f]{8}$/);
});

test("outbox: enqueue, claim, retry, fail and recover stale claims", () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-mem0-outbox-"));
	const box = new Outbox(dir, 2);
	const base = { createdAt: "now", userId: "u", agentId: "p", messages: [{ role: "user" as const, content: "x" }], metadata: {} };
	box.enqueue(base);
	assert.equal(box.pendingCount(), 1);

	const first = box.claimNext();
	assert.ok(first);
	assert.equal(box.claimNext(), undefined, "a claimed item is not handed out twice");
	assert.equal(box.release(first, "boom"), "retry");
	const second = box.claimNext();
	assert.equal(second?.item.attempts, 1);
	assert.equal(box.release(second as NonNullable<typeof second>, "boom"), "failed");
	assert.equal(box.pendingCount(), 0);
	assert.equal(box.failedCount(), 1);

	box.enqueue(base);
	const claim = box.claimNext();
	assert.ok(claim);
	// Simulate a pi process that died while holding the claim.
	const dead = claim.file.replace(/claimed-\d+$/, "claimed-999999");
	renameSync(join(box.pendingDir, claim.file), join(box.pendingDir, dead));
	assert.equal(box.recoverStale(), 1);
	assert.equal(box.pendingCount(), 1);
	box.complete(box.claimNext() as NonNullable<ReturnType<Outbox["claimNext"]>>);
	assert.deepEqual(readdirSync(box.pendingDir), []);
});

test("pi LLM adapter: folds messages and asks for JSON when Mem0 requests it", async () => {
	const calls: Array<[string, string]> = [];
	const llm = createPiLlm({
		complete: async (system, user) => {
			calls.push([system, user]);
			return '{"memory": []}';
		},
	});
	const out = await llm.generateResponse(
		[
			{ role: "system", content: "extract facts" },
			{ role: "user", content: "conversation" },
		],
		{ type: "json_object" },
	);
	assert.equal(out, '{"memory": []}');
	assert.match(calls[0]?.[0] ?? "", /^extract facts\n\nRespond with one valid JSON object only/);
	assert.equal(calls[0]?.[1], "conversation");
	const chat = await llm.generateChat([{ role: "user", content: "hi" }]);
	assert.deepEqual(chat, { content: '{"memory": []}', role: "assistant" });
	assert.doesNotMatch(calls[1]?.[0] ?? "", /JSON/);
});

test("formatItems shows date, project and id", () => {
	const text = formatItems([{ id: "abc", memory: "usar  HALF_EVEN", createdAt: "2026-11-16T10:00:00Z", project: "pagamentos", score: 0.8123 }], {
		showProject: true,
	});
	assert.equal(text, "- usar HALF_EVEN (2026-11-16, pagamentos, score 0.81, id abc)");
});
