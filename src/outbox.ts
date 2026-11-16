import { randomBytes } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface OutboxItem {
	createdAt: string;
	userId: string;
	agentId: string;
	messages: Array<{ role: "user" | "assistant"; content: string }>;
	metadata: Record<string, string>;
	attempts: number;
	lastError?: string;
}

export interface ClaimedItem {
	file: string;
	item: OutboxItem;
}

const CLAIM_SEPARATOR = ".claimed-";

function pidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

/**
 * Durable queue of captured tasks waiting for extraction. One JSON file per task; a pi
 * process claims a file by renaming it, so several pi instances can share the folder.
 */
export class Outbox {
	readonly pendingDir: string;
	readonly failedDir: string;
	private readonly maxAttempts: number;

	constructor(dataDir: string, maxAttempts = 5) {
		this.pendingDir = join(dataDir, "outbox");
		this.failedDir = join(dataDir, "outbox-failed");
		this.maxAttempts = maxAttempts;
		mkdirSync(this.pendingDir, { recursive: true });
	}

	enqueue(item: Omit<OutboxItem, "attempts">): string {
		const name = `${Date.now()}-${randomBytes(4).toString("hex")}.json`;
		const tmp = join(this.pendingDir, `.${name}.tmp`);
		writeFileSync(tmp, JSON.stringify({ ...item, attempts: 0 }), { mode: 0o600 });
		renameSync(tmp, join(this.pendingDir, name));
		return name;
	}

	/** Return claims left behind by pi processes that are no longer running. */
	recoverStale(): number {
		let recovered = 0;
		for (const file of readdirSync(this.pendingDir)) {
			const index = file.lastIndexOf(CLAIM_SEPARATOR);
			if (index < 0) continue;
			const pid = Number(file.slice(index + CLAIM_SEPARATOR.length));
			// Claims of this process belong to a drain that may still be running.
			if (!Number.isInteger(pid) || pid === process.pid || pidAlive(pid)) continue;
			try {
				renameSync(join(this.pendingDir, file), join(this.pendingDir, file.slice(0, index)));
				recovered++;
			} catch {
				// Another process recovered it first.
			}
		}
		return recovered;
	}

	pendingCount(): number {
		return readdirSync(this.pendingDir).filter((file) => file.endsWith(".json")).length;
	}

	failedCount(): number {
		try {
			return readdirSync(this.failedDir).filter((file) => file.endsWith(".json")).length;
		} catch {
			return 0;
		}
	}

	claimNext(): ClaimedItem | undefined {
		const files = readdirSync(this.pendingDir)
			.filter((file) => file.endsWith(".json") && !file.startsWith("."))
			.sort();
		for (const file of files) {
			const claimed = `${file}${CLAIM_SEPARATOR}${process.pid}`;
			try {
				renameSync(join(this.pendingDir, file), join(this.pendingDir, claimed));
			} catch {
				continue;
			}
			try {
				const item = JSON.parse(readFileSync(join(this.pendingDir, claimed), "utf8")) as OutboxItem;
				return { file: claimed, item };
			} catch (error) {
				this.moveToFailed(claimed, `unreadable outbox file: ${(error as Error).message}`);
			}
		}
		return undefined;
	}

	complete(claim: ClaimedItem): void {
		try {
			unlinkSync(join(this.pendingDir, claim.file));
		} catch {
			// Already gone.
		}
	}

	/** Put the item back for a later retry, or park it in outbox-failed after too many attempts. */
	release(claim: ClaimedItem, error: string): "retry" | "failed" {
		const item = { ...claim.item, attempts: claim.item.attempts + 1, lastError: error.slice(0, 500) };
		const path = join(this.pendingDir, claim.file);
		writeFileSync(path, JSON.stringify(item), { mode: 0o600 });
		if (item.attempts >= this.maxAttempts) {
			this.moveToFailed(claim.file, error);
			return "failed";
		}
		renameSync(path, join(this.pendingDir, claim.file.slice(0, claim.file.lastIndexOf(CLAIM_SEPARATOR))));
		return "retry";
	}

	private moveToFailed(file: string, _reason: string): void {
		mkdirSync(this.failedDir, { recursive: true });
		const base = file.includes(CLAIM_SEPARATOR) ? file.slice(0, file.lastIndexOf(CLAIM_SEPARATOR)) : file;
		renameSync(join(this.pendingDir, file), join(this.failedDir, base));
	}
}
