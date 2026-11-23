import { type PriorFinding, type ReviewReport, ReviewReportSchema } from '@acra/review-engine';
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import * as z from 'zod';
import { CliError } from './cli-context';

const DecisionsSchema = z.object({
  version: z.literal(1),
  decisions: z.record(
    z.string(),
    z.object({
      status: z.enum(['dismissed', 'false_positive']),
      reason: z.string().max(500).optional(),
      findingId: z.string(),
      filePath: z.string(),
      decidedAt: z.iso.datetime(),
    }),
  ),
});
type Decisions = z.infer<typeof DecisionsSchema>;

const MAX_REPORTS = 50;

/**
 * Local review history in `<git-dir>/ai-review/` — inside .git, so it is never part of the working
 * tree, never committed and never pushed. Files are written atomically (temp + rename) with
 * owner-only permissions and re-validated on read.
 */
export class LocalReviewStore {
  private readonly root: string;

  constructor(gitDirectory: string) {
    this.root = join(gitDirectory, 'ai-review');
  }

  get directory(): string {
    return this.root;
  }

  async save(report: ReviewReport): Promise<string> {
    const reports = join(this.root, 'reports');
    await mkdir(reports, { recursive: true, mode: 0o700 });
    const name = `${report.createdAt.replace(/[:.]/g, '-')}_${report.reviewId}.json`;
    const json = `${JSON.stringify(report, null, 2)}\n`;
    await atomicWrite(join(reports, name), json);
    await atomicWrite(join(this.root, 'latest.json'), json);
    await this.prune(reports);
    return join(reports, name);
  }

  async latest(): Promise<ReviewReport | null> {
    let raw: string;
    try {
      raw = await readFile(join(this.root, 'latest.json'), 'utf8');
    } catch {
      return null;
    }
    const parsed = ReviewReportSchema.safeParse(safeJson(raw));
    if (!parsed.success)
      throw new CliError(`Stored review in ${this.root} is unreadable; run \`ai-review review\` again.`);
    return parsed.data;
  }

  async decisions(): Promise<Decisions> {
    try {
      const parsed = DecisionsSchema.safeParse(safeJson(await readFile(join(this.root, 'decisions.json'), 'utf8')));
      if (parsed.success) return parsed.data;
    } catch {
      // no decisions yet
    }
    return { version: 1, decisions: {} };
  }

  async decide(fingerprint: string, decision: Decisions['decisions'][string]): Promise<void> {
    const current = await this.decisions();
    current.decisions[fingerprint] = decision;
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    await atomicWrite(join(this.root, 'decisions.json'), `${JSON.stringify(current, null, 2)}\n`);
  }

  /** Prior findings for lifecycle reconciliation: last review's open findings + user decisions. */
  async priorFindings(): Promise<PriorFinding[]> {
    const [latest, { decisions }] = await Promise.all([this.latest().catch(() => null), this.decisions()]);
    const prior: PriorFinding[] = (latest?.findings ?? []).map((finding) => ({
      id: finding.id,
      fingerprint: finding.fingerprint,
      filePath: finding.filePath,
      status: finding.status,
      createdAt: finding.createdAt,
    }));
    for (const [fingerprint, decision] of Object.entries(decisions)) {
      prior.push({
        id: decision.findingId,
        fingerprint,
        filePath: decision.filePath,
        status: decision.status,
        createdAt: decision.decidedAt,
      });
    }
    return prior;
  }

  private async prune(reports: string): Promise<void> {
    const files = (await readdir(reports)).filter((f) => f.endsWith('.json')).sort();
    for (const stale of files.slice(0, Math.max(0, files.length - MAX_REPORTS))) {
      await rm(join(reports, stale), { force: true });
    }
  }
}

async function atomicWrite(path: string, content: string): Promise<void> {
  const temp = `${path}.${process.pid}.tmp`;
  await writeFile(temp, content, { encoding: 'utf8', mode: 0o600 });
  await rename(temp, path);
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}
