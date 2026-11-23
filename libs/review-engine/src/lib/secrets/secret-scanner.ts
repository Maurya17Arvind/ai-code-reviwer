/**
 * Detects credentials in source text. Used twice:
 *  - to REDACT secrets from the review context before anything is sent to an AI provider, and
 *  - to REPORT newly added secrets as deterministic findings.
 * Patterns favour precision (known token formats) over recall to avoid noisy findings.
 */
export interface SecretMatch {
  readonly kind: string;
  readonly start: number;
  readonly end: number;
}

interface SecretPattern {
  readonly kind: string;
  readonly regex: RegExp;
  /** Capture group holding the secret value (default: whole match). */
  readonly group?: number;
}

const PLACEHOLDER =
  /^(\$\{|<|\{\{|%\(|process\.env|import\.meta\.env)|change-?me|example|placeholder|dummy|x{6,}|\*{4,}/i;

const PATTERNS: readonly SecretPattern[] = [
  { kind: 'private_key', regex: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY(?: BLOCK)?-----/g },
  { kind: 'aws_access_key', regex: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { kind: 'github_token', regex: /\b(?:gh[pousr]_[A-Za-z0-9]{36,255}|github_pat_[A-Za-z0-9_]{22,255})\b/g },
  { kind: 'gitlab_token', regex: /\bglpat-[A-Za-z0-9_-]{20,}\b/g },
  { kind: 'anthropic_api_key', regex: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g },
  { kind: 'openai_api_key', regex: /\bsk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{32,}\b/g },
  { kind: 'slack_token', regex: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g },
  { kind: 'google_api_key', regex: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { kind: 'stripe_live_key', regex: /\b(?:sk|rk)_live_[0-9a-zA-Z]{24,}\b/g },
  { kind: 'jwt', regex: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g },
  { kind: 'url_credentials', regex: /\b[a-z][a-z0-9+.-]*:\/\/[^\s:@/'"]+:([^\s@/'"]{4,})@/gi, group: 1 },
  {
    kind: 'hardcoded_credential',
    regex:
      /\b(?:password|passwd|pwd|secret|api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret)\b["']?\s*[:=]\s*["']([^"'\s]{8,})["']/gi,
    group: 1,
  },
];

export function scanForSecrets(text: string): SecretMatch[] {
  const matches: SecretMatch[] = [];
  for (const pattern of PATTERNS) {
    for (const match of text.matchAll(pattern.regex)) {
      const value = pattern.group ? match[pattern.group] : match[0];
      if (!value || match.index === undefined) continue;
      if (pattern.group && PLACEHOLDER.test(value)) continue;
      const offset = pattern.group ? match[0].indexOf(value) : 0;
      const start = match.index + offset;
      matches.push({ kind: pattern.kind, start, end: start + value.length });
    }
  }
  // Drop matches contained in an earlier/longer match (e.g. a token inside a URL credential).
  matches.sort((a, b) => a.start - b.start || b.end - a.end);
  return matches.filter((m, i) => !matches.slice(0, i).some((o) => o.start <= m.start && o.end >= m.end));
}

export function redactSecrets(text: string): { text: string; redactions: number } {
  const matches = scanForSecrets(text);
  if (matches.length === 0) return { text, redactions: 0 };
  let result = '';
  let cursor = 0;
  for (const match of matches) {
    if (match.start < cursor) continue;
    result += `${text.slice(cursor, match.start)}[REDACTED:${match.kind}]`;
    cursor = match.end;
  }
  return { text: result + text.slice(cursor), redactions: matches.length };
}
