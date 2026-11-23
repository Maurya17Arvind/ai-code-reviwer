import { type FindingStatus } from '@acra/shared-types';

/** Allowed status transitions (Module F). Dismissed / false positive are terminal for automation. */
export const FINDING_TRANSITIONS: Readonly<Record<FindingStatus, readonly FindingStatus[]>> = {
  new: ['validated', 'dismissed', 'false_positive'],
  validated: ['published', 'resolved', 'dismissed', 'false_positive'],
  published: ['resolved', 'dismissed', 'false_positive'],
  resolved: ['validated'],
  dismissed: [],
  false_positive: [],
};

export function canTransition(from: FindingStatus, to: FindingStatus): boolean {
  return from === to || FINDING_TRANSITIONS[from].includes(to);
}

export function assertTransition(from: FindingStatus, to: FindingStatus): void {
  if (!canTransition(from, to)) throw new Error(`Invalid finding status transition ${from} → ${to}`);
}

/** Minimal view of a previously recorded finding needed for reconciliation. */
export interface PriorFinding {
  readonly id: string;
  readonly fingerprint: string;
  readonly filePath: string;
  readonly status: FindingStatus;
  readonly createdAt: string;
}

export interface Reconciliation {
  /** fingerprint → prior record, for findings seen again (keep id/createdAt). */
  readonly stillPresent: ReadonlyMap<string, PriorFinding>;
  /** fingerprints suppressed because a user dismissed them or marked them false positive. */
  readonly suppressed: ReadonlyMap<string, FindingStatus>;
  /** Prior open findings in re-reviewed files that no longer occur. */
  readonly resolved: readonly PriorFinding[];
}

/**
 * Compares the current review's fingerprints with prior findings of the same repository/branch.
 * A prior open finding is only considered resolved when its file was part of the new review —
 * absence from a narrower scope proves nothing.
 */
export function reconcileFindings(
  prior: readonly PriorFinding[],
  currentFingerprints: ReadonlySet<string>,
  reviewedFiles: ReadonlySet<string>,
): Reconciliation {
  const stillPresent = new Map<string, PriorFinding>();
  const suppressed = new Map<string, FindingStatus>();
  const resolved: PriorFinding[] = [];

  for (const finding of prior) {
    if (finding.status === 'dismissed' || finding.status === 'false_positive') {
      suppressed.set(finding.fingerprint, finding.status);
      continue;
    }
    if (currentFingerprints.has(finding.fingerprint)) {
      stillPresent.set(finding.fingerprint, finding);
    } else if (
      (finding.status === 'validated' || finding.status === 'published') &&
      reviewedFiles.has(finding.filePath) &&
      canTransition(finding.status, 'resolved')
    ) {
      resolved.push(finding);
    }
  }
  return { stillPresent, suppressed, resolved };
}
