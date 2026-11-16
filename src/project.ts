import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

export interface ProjectScope {
	root: string;
	name: string;
	/** Stable id stored as Mem0's agent_id, so memories can be filtered per project. */
	id: string;
}

/** Nearest directory with a .git entry, or the cwd itself. Subfolders of a repo share one project. */
export function findProjectRoot(cwd: string): string {
	let dir = resolve(cwd);
	for (;;) {
		if (existsSync(join(dir, ".git"))) return dir;
		const parent = dirname(dir);
		if (parent === dir) return resolve(cwd);
		dir = parent;
	}
}

export function projectScope(cwd: string): ProjectScope {
	const root = findProjectRoot(cwd);
	const name = basename(root) || "root";
	const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "project";
	const hash = createHash("sha256").update(root).digest("hex").slice(0, 8);
	return { root, name, id: `proj-${slug}-${hash}` };
}
