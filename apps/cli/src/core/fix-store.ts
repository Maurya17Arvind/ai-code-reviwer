import { type ApprovalRequest, APPROVAL_STATUSES, invalidate, isExpired, expire } from '@acra/approvals';
import { type FixProposal } from '@acra/fix-engine';
import { appendFile, mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import * as z from 'zod';
import { CliError } from './cli-context';

export const FIX_STATUSES = ['proposed', 'applied', 'staged', 'committed', 'pushed', 'opened', 'discarded'] as const;
export type FixStatus = (typeof FIX_STATUSES)[number];

const ValidationResultSchema = z.object({
  argv: z.array(z.string()),
  passed: z.boolean(),
  exitCode: z.number().nullable(),
  timedOut: z.boolean(),
  durationMs: z.number(),
});

const FixRecordSchema = z.object({
  version: z.literal(1),
  reviewId: z.string(),
  finding: z.object({
    title: z.string(),
    severity: z.string(),
    category: z.string(),
    lineNumber: z.number().optional(),
  }),
  branch: z.string(),
  status: z.enum(FIX_STATUSES),
  proposal: z.looseObject({
    id: z.string(),
    findingId: z.string(),
    fingerprint: z.string(),
    filePath: z.string(),
    baseSha: z.string(),
    explanation: z.string(),
    changes: z.array(z.object({ oldStart: z.number(), oldEnd: z.number(), added: z.array(z.string()) })),
    patch: z.string(),
    patchSha256: z.string(),
    originalSha256: z.string(),
    resultSha256: z.string(),
    additions: z.number(),
    deletions: z.number(),
    provider: z.string(),
    model: z.string(),
    createdAt: z.string(),
  }),
  validation: z.array(ValidationResultSchema).optional(),
  commitSha: z.string().optional(),
  pushedTo: z.string().optional(),
  reviewRequest: z.object({ provider: z.string(), id: z.number(), url: z.string() }).optional(),
  updatedAt: z.string(),
});
export type FixRecord = Omit<z.infer<typeof FixRecordSchema>, 'proposal'> & { proposal: FixProposal };

const ApprovalSchema = z.looseObject({
  id: z.string(),
  bindingHash: z.string(),
  status: z.enum(APPROVAL_STATUSES),
  headSha: z.string(),
  expiresAt: z.string(),
  operation: z.looseObject({ kind: z.string(), fixId: z.string() }),
});

/**
 * Fix proposals, approval requests and an append-only audit log under `<git-dir>/ai-review/`
 * (never in the working tree, never committed). Files are written atomically and re-validated on read.
 */
export class LocalFixStore {
  private readonly root: string;

  constructor(gitDirectory: string) {
    this.root = join(gitDirectory, 'ai-review');
  }

  private dir(kind: 'fixes' | 'approvals'): string {
    return join(this.root, kind);
  }

  async saveFix(record: FixRecord): Promise<void> {
    await this.write('fixes', record.proposal.id, { ...record, updatedAt: new Date().toISOString() });
  }

  async fixes(): Promise<FixRecord[]> {
    const records = await this.readAll('fixes', FixRecordSchema);
    return (records as FixRecord[]).sort((a, b) => a.proposal.createdAt.localeCompare(b.proposal.createdAt));
  }

  /** Resolves a fix by id or unique prefix (≥ 4 characters). */
  async findFix(idPrefix: string): Promise<FixRecord> {
    const matches = (await this.fixes()).filter((f) => f.proposal.id.startsWith(idPrefix.toLowerCase()));
    if (idPrefix.length < 4 || matches.length !== 1) {
      throw new CliError(
        matches.length > 1
          ? `Fix id "${idPrefix}" is ambiguous.`
          : `No fix with id "${idPrefix}". See \`ai-review fix list\`.`,
      );
    }
    return matches[0] as FixRecord;
  }

  async saveApproval(request: ApprovalRequest): Promise<void> {
    await this.write('approvals', request.id, request);
  }

  async approvals(): Promise<ApprovalRequest[]> {
    const all = (await this.readAll('approvals', ApprovalSchema)) as unknown as ApprovalRequest[];
    return all.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  /**
   * Housekeeping before any approval decision: expires overdue requests and invalidates open
   * requests bound to a reviewed commit other than `currentHeadSha` (Module H).
   */
  async refreshApprovals(currentHeadSha: string | null, now = new Date()): Promise<ApprovalRequest[]> {
    const all = await this.approvals();
    const result: ApprovalRequest[] = [];
    for (const request of all) {
      let next = request;
      if ((next.status === 'pending' || next.status === 'approved') && isExpired(next, now)) next = expire(next, now);
      if (
        (next.status === 'pending' || next.status === 'approved') &&
        currentHeadSha &&
        next.headSha !== currentHeadSha
      ) {
        next = invalidate(next, 'a newer commit was reviewed');
      }
      if (next !== request) {
        await this.saveApproval(next);
        await this.audit({ action: `approval.${next.status}`, approvalId: next.id, fixId: next.operation.fixId });
      }
      result.push(next);
    }
    return result;
  }

  async audit(entry: Record<string, unknown>): Promise<void> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    await appendFile(
      join(this.root, 'audit.jsonl'),
      `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`,
      {
        mode: 0o600,
      },
    );
  }

  private async write(kind: 'fixes' | 'approvals', id: string, value: unknown): Promise<void> {
    if (!/^[0-9a-f-]{8,64}$/i.test(id)) throw new CliError('Invalid record id');
    const dir = this.dir(kind);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const path = join(dir, `${id}.json`);
    const temp = `${path}.${process.pid}.tmp`;
    await writeFile(temp, JSON.stringify(value, null, 2), { mode: 0o600 });
    await rename(temp, path);
  }

  private async readAll(kind: 'fixes' | 'approvals', schema: z.ZodType): Promise<unknown[]> {
    let names: string[];
    try {
      names = (await readdir(this.dir(kind))).filter((n) => n.endsWith('.json'));
    } catch {
      return [];
    }
    const records: unknown[] = [];
    for (const name of names) {
      try {
        const parsed = schema.safeParse(JSON.parse(await readFile(join(this.dir(kind), name), 'utf8')));
        if (parsed.success) records.push(parsed.data);
      } catch {
        // unreadable record: ignored (never executed)
      }
    }
    return records;
  }
}
