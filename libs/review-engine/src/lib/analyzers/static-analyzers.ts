import { type ContextFile, type ReviewContext } from '@acra/repository-context';
import { type ReviewCategory, type Severity } from '@acra/shared-types';
import { type CandidateFinding } from '../candidate';
import { redactSecrets, scanForSecrets } from '../secrets/secret-scanner';

/**
 * RUN_STATIC_ANALYSIS: deterministic, dependency-free checks on ADDED lines only.
 *
 * The repository's own linters/test tools are deliberately NOT executed here: running
 * repository-defined commands means executing untrusted code. That happens only in the
 * sandboxed fix-validation runner (Phase 6).
 */
interface LineRule {
  readonly id: string;
  readonly languages: readonly string[] | 'any';
  readonly pattern: RegExp;
  readonly severity: Severity;
  readonly category: ReviewCategory;
  readonly confidence: number;
  readonly title: string;
  readonly description: string;
  readonly suggestion: string;
}

const JS = ['typescript', 'javascript'];

const RULES: readonly LineRule[] = [
  {
    id: 'dynamic-code-evaluation',
    languages: JS,
    pattern: /(?<![\w.])eval\s*\(|\bnew\s+Function\s*\(/,
    severity: 'high',
    category: 'security',
    confidence: 0.8,
    title: 'Dynamic code evaluation',
    description:
      'eval() / new Function() execute strings as code; with any attacker-influenced input this is remote code execution.',
    suggestion: 'Replace dynamic evaluation with explicit parsing or a lookup table.',
  },
  {
    id: 'angular-sanitizer-bypass',
    languages: JS,
    pattern: /\bbypassSecurityTrust(?:Html|Script|Style|Url|ResourceUrl)\s*\(/,
    severity: 'high',
    category: 'security',
    confidence: 0.75,
    title: 'Angular sanitization bypassed with DomSanitizer.bypassSecurityTrust*',
    description: "Bypassing Angular's built-in sanitization disables XSS protection for this value.",
    suggestion:
      'Let Angular sanitize the value, or sanitize it explicitly (DomSanitizer.sanitize) and only trust compile-time constants.',
  },
  {
    id: 'command-injection',
    languages: JS,
    pattern: /\b(?:exec|execSync|spawnSync|spawn)\s*\(\s*`[^`]*\$\{/,
    severity: 'high',
    category: 'security',
    confidence: 0.75,
    title: 'Shell command built from interpolated input',
    description:
      'Interpolating values into a shell command allows command injection if any part is attacker-controlled.',
    suggestion: 'Use execFile/spawn with an argument array and no shell; validate inputs against an allowlist.',
  },
  {
    id: 'sql-injection',
    languages: JS,
    pattern: /`[^`]*\b(?:SELECT|INSERT\s+INTO|UPDATE|DELETE\s+FROM)\b[^`]*\$\{/i,
    severity: 'high',
    category: 'security',
    confidence: 0.65,
    title: 'SQL statement built with string interpolation',
    description: 'Interpolating values into SQL text enables SQL injection.',
    suggestion: 'Use parameterized queries / tagged template helpers (e.g. Prisma.sql, $queryRaw with placeholders).',
  },
  {
    id: 'tls-verification-disabled',
    languages: 'any',
    pattern:
      /rejectUnauthorized\s*:\s*false|NODE_TLS_REJECT_UNAUTHORIZED\s*=\s*['"]?0|InsecureSkipVerify\s*:\s*true|verify\s*=\s*False/,
    severity: 'high',
    category: 'security',
    confidence: 0.85,
    title: 'TLS certificate verification disabled',
    description: 'Disabling certificate verification allows man-in-the-middle attacks.',
    suggestion: 'Keep verification enabled; trust a private CA explicitly if needed.',
  },
  {
    id: 'react-dangerous-html',
    languages: JS,
    pattern: /\bdangerouslySetInnerHTML\s*=/,
    severity: 'medium',
    category: 'security',
    confidence: 0.6,
    title: 'Raw HTML injection with dangerouslySetInnerHTML',
    description: 'Rendering unsanitized HTML enables XSS.',
    suggestion: 'Render text content, or sanitize the HTML with a vetted sanitizer before injecting it.',
  },
  {
    id: 'ts-ignore',
    languages: ['typescript'],
    pattern: /\/\/\s*@ts-ignore\b/,
    severity: 'low',
    category: 'maintainability',
    confidence: 0.7,
    title: '@ts-ignore suppresses type checking',
    description: '@ts-ignore hides all type errors on the next line, including future ones.',
    suggestion: 'Fix the type error, or use @ts-expect-error with a comment explaining why.',
  },
];

export function runStaticAnalysis(context: ReviewContext): CandidateFinding[] {
  const findings: CandidateFinding[] = [];
  for (const file of context.files) {
    for (const { line, lineNumber } of addedLines(file)) {
      for (const secret of scanForSecrets(line)) {
        findings.push({
          source: 'static',
          filePath: file.path,
          lineStart: lineNumber,
          lineEnd: lineNumber,
          severity: 'critical',
          category: 'security',
          title: `Hard-coded secret (${secret.kind.replace(/_/g, ' ')})`,
          description:
            'A credential appears to be committed in source code. Anyone with repository access can use it, and it stays in Git history.',
          evidence: redactSecrets(line.trim()).text,
          suggestion:
            'Remove it, rotate the credential immediately, and load it from a secret manager or environment variable.',
          confidence: 0.95,
        });
      }
      for (const rule of RULES) {
        if (rule.languages !== 'any' && !rule.languages.includes(file.language)) continue;
        if (!rule.pattern.test(line)) continue;
        findings.push({
          source: 'static',
          filePath: file.path,
          lineStart: lineNumber,
          lineEnd: lineNumber,
          severity: rule.severity,
          category: rule.category,
          title: rule.title,
          description: rule.description,
          evidence: redactSecrets(line.trim()).text,
          suggestion: rule.suggestion,
          confidence: rule.confidence,
        });
      }
    }
  }
  return findings;
}

function* addedLines(file: ContextFile): Generator<{ line: string; lineNumber: number }> {
  for (const hunk of file.hunks) {
    for (const diffLine of hunk.lines) {
      if (diffLine.kind === 'add' && diffLine.newLine !== undefined) {
        yield { line: diffLine.content, lineNumber: diffLine.newLine };
      }
    }
  }
}
