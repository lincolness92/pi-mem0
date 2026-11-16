import { redactSecrets } from "./redact.ts";

export const MEMORY_TOOL_NAME = "mem0_memory";

export interface CaptureOptions {
	includeIntermediate: boolean;
	maxChars: number;
	minChars: number;
}

export interface CapturedTask {
	messages: Array<{ role: "user" | "assistant"; content: string }>;
	filesChanged: string[];
}

const FILE_TOOLS = new Set(["edit", "write", "multiedit", "apply_patch", "notebook_edit"]);
const INTERMEDIATE_LIMIT = 400;

type Part = { type?: unknown; text?: unknown; name?: unknown; arguments?: unknown };
type Message = { role?: unknown; content?: unknown };

function textOf(content: unknown): string {
	if (typeof content === "string") return content.trim();
	if (!Array.isArray(content)) return "";
	return (content as Part[])
		.filter((part) => part?.type === "text" && typeof part.text === "string")
		.map((part) => (part.text as string).trim())
		.filter(Boolean)
		.join("\n");
}

function clip(text: string, limit: number): string {
	if (text.length <= limit) return text;
	if (limit <= 1) return "…";
	return `${text.slice(0, limit - 1).trimEnd()}…`;
}

function filePath(args: unknown): string | undefined {
	if (!args || typeof args !== "object") return undefined;
	const record = args as Record<string, unknown>;
	for (const key of ["path", "file_path", "filePath", "file"]) {
		if (typeof record[key] === "string" && record[key]) return record[key] as string;
	}
	return undefined;
}

/**
 * Turn the messages of one finished task (user prompt through final answer) into the
 * two-message exchange sent to Mem0. Returns null when there is nothing worth storing.
 */
export function buildCapture(messages: readonly unknown[], options: CaptureOptions): CapturedTask | null {
	const userTexts: string[] = [];
	const assistantTexts: string[] = [];
	const files = new Set<string>();
	let toolCalls = 0;
	let memoryToolCalls = 0;

	for (const raw of messages) {
		const message = raw as Message;
		if (message?.role === "user") {
			const text = textOf(message.content);
			// Retries can replay the same prompt; keep it once.
			if (text && !userTexts.includes(text)) userTexts.push(text);
		} else if (message?.role === "assistant") {
			const text = textOf(message.content);
			if (text) assistantTexts.push(text);
			if (Array.isArray(message.content)) {
				for (const part of message.content as Part[]) {
					if (part?.type !== "toolCall") continue;
					toolCalls++;
					const name = typeof part.name === "string" ? part.name : "";
					if (name === MEMORY_TOOL_NAME) memoryToolCalls++;
					if (FILE_TOOLS.has(name.toLowerCase())) {
						const path = filePath(part.arguments);
						if (path) files.add(path);
					}
				}
			}
		}
	}

	if (userTexts.length === 0 || assistantTexts.length === 0) return null;
	// A run that only consulted memory would just store what is already stored.
	if (toolCalls > 0 && toolCalls === memoryToolCalls) return null;

	const user = redactSecrets(userTexts.join("\n\n"));
	const finalAnswer = redactSecrets(assistantTexts[assistantTexts.length - 1] as string);
	const notes = options.includeIntermediate
		? assistantTexts.slice(0, -1).map((text) => `- ${clip(redactSecrets(text).replace(/\s+/g, " "), INTERMEDIATE_LIMIT)}`)
		: [];
	const filesChanged = [...files];

	if (user.length + finalAnswer.length < options.minChars && filesChanged.length === 0) return null;

	// Budget: the user prompt gets up to 30%, the final answer has priority over progress notes.
	const userPart = clip(user, Math.max(200, Math.floor(options.maxChars * 0.3)));
	let remaining = options.maxChars - userPart.length;
	const filesPart = filesChanged.length ? `\n\nFiles changed: ${filesChanged.join(", ")}` : "";
	remaining -= filesPart.length;
	const finalPart = clip(finalAnswer, Math.max(200, remaining));
	remaining -= finalPart.length;

	const keptNotes: string[] = [];
	for (const note of notes) {
		if (note.length + 1 > remaining - 40) break;
		keptNotes.push(note);
		remaining -= note.length + 1;
	}
	const notesPart = keptNotes.length ? `Progress notes:\n${keptNotes.join("\n")}\n\nFinal answer:\n` : "";

	return {
		messages: [
			{ role: "user", content: userPart },
			{ role: "assistant", content: `${notesPart}${finalPart}${filesPart}` },
		],
		filesChanged,
	};
}
