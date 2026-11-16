const REDACTED = "[REDACTED]";

const PATTERNS: Array<[RegExp, string | ((...groups: string[]) => string)]> = [
	[/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g, REDACTED],
	[/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{12,}/gi, (_m, scheme) => `${scheme} ${REDACTED}`],
	[/\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, REDACTED],
	[/\b(sk|rk|pk)-(?:proj-|ant-|live-|test-)?[A-Za-z0-9_-]{16,}\b/g, REDACTED],
	[/\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/g, REDACTED],
	[/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, REDACTED],
	[/\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g, REDACTED],
	[/\b(AKIA|ASIA)[A-Z0-9]{16}\b/g, REDACTED],
	[/\bAIza[A-Za-z0-9_-]{30,}\b/g, REDACTED],
	[
		/\b([A-Za-z0-9_.-]*(?:api[_-]?key|secret|token|password|passwd|pwd|access[_-]?key|client[_-]?secret)[A-Za-z0-9_.-]*)(\s*["']?\s*[:=]\s*["']?)([^\s"',;]{6,})/gi,
		(_m, key, sep) => `${key}${sep}${REDACTED}`,
	],
	[/(\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:)[^\s@/]+@/gi, (_m, prefix) => `${prefix}${REDACTED}@`],
];

/** Remove credentials before text leaves the session for the extraction model or the memory store. */
export function redactSecrets(text: string): string {
	let out = text;
	for (const [pattern, replacement] of PATTERNS) {
		out = out.replace(pattern, replacement as never);
	}
	return out;
}
