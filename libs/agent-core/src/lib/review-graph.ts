import {
  AiProviderError,
  type AiProviderName,
  type AiReviewer,
  type ModelReviewOutput,
  type ReviewPrompt,
} from '@acra/ai-providers-core';
import { describeScope } from '@acra/git-providers-core';
import { type ReviewContext } from '@acra/repository-context';
import {
  aggregateFindings,
  buildReviewPrompt,
  type CandidateFinding,
  deduplicateFindings,
  type MergedFinding,
  type ModelExecution,
  parseModelOutput,
  type PriorFinding,
  reconcileFindings,
  redactContext,
  type RejectedCandidate,
  type ReviewReport,
  runStaticAnalysis,
  selectFindings,
  validateFindings,
  type ValidationOutcome,
} from '@acra/review-engine';
import { type ReviewCategory, type Severity } from '@acra/shared-types';
import { Annotation, END, Send, START, StateGraph } from '@langchain/langgraph';
import { randomUUID } from 'node:crypto';

export interface ReviewSettings {
  readonly categories: readonly ReviewCategory[];
  readonly minimumSeverity: Severity;
  readonly minimumConfidence: number;
  readonly framework?: string;
  readonly language?: string;
  /** Per-provider wall-clock limit. */
  readonly providerTimeoutMs: number;
}

export interface SkippedProvider {
  readonly provider: AiProviderName;
  readonly model: string;
  readonly reason: string;
}

export interface ReviewRunInput {
  /** Original (unredacted) context — stays local. */
  readonly context: ReviewContext;
  readonly reviewers: readonly AiReviewer[];
  readonly skippedProviders?: readonly SkippedProvider[];
  readonly settings: ReviewSettings;
  readonly repository: {
    readonly rootPath: string;
    readonly branch: string | null;
    readonly headSha: string | null;
    readonly repositoryId: string | null;
  };
  readonly priorFindings?: readonly PriorFinding[];
  readonly reviewId?: string;
  readonly now?: () => Date;
  readonly signal?: AbortSignal;
}

interface TraceEntry {
  readonly node: string;
  readonly durationMs: number;
}

const concat = <T>() => ({ reducer: (left: T[], right: T[]) => left.concat(right), default: (): T[] => [] });

const ReviewState = Annotation.Root({
  redactedContext: Annotation<ReviewContext | undefined>(),
  secretsRedacted: Annotation<number>(),
  prompt: Annotation<ReviewPrompt | undefined>(),
  staticFindings: Annotation<CandidateFinding[]>(),
  executions: Annotation<ModelExecution[]>(concat<ModelExecution>()),
  modelOutputs:
    Annotation<Array<{ provider: AiProviderName; output: ModelReviewOutput }>>(
      concat<{ provider: AiProviderName; output: ModelReviewOutput }>(),
    ),
  candidates: Annotation<CandidateFinding[]>(),
  aggregationRejected: Annotation<RejectedCandidate[]>(),
  validation: Annotation<ValidationOutcome | undefined>(),
  merged: Annotation<MergedFinding[]>(),
  report: Annotation<ReviewReport | undefined>(),
  trace: Annotation<TraceEntry[]>(concat<TraceEntry>()),
  /** Payload of a single ai_review branch (delivered via Send). */
  task: Annotation<{ provider: AiProviderName } | undefined>(),
});
type State = typeof ReviewState.State;
type Update = typeof ReviewState.Update;

/**
 * The review pipeline as a LangGraph StateGraph (ADR-004):
 *
 *   START → prepare ─┬─ ai_review(claude) ─┐
 *                    └─ ai_review(gpt)    ─┴→ aggregate → validate → deduplicate → finalize → END
 *
 * `prepare` redacts secrets, runs static analysis and builds ONE prompt; every ai_review branch
 * receives that same prompt (same promptHash). A failing branch records a failed execution instead
 * of throwing, so one provider's failure never discards another provider's findings.
 */
function createReviewGraph(input: ReviewRunInput) {
  const reviewers = new Map(input.reviewers.map((reviewer) => [reviewer.provider, reviewer]));
  const now = input.now ?? (() => new Date());
  const reviewId = input.reviewId ?? randomUUID();

  const traced =
    (name: string, fn: (state: State) => Promise<Update> | Update) =>
    async (state: State): Promise<Update> => {
      const started = performance.now();
      const update = await fn(state);
      return { ...update, trace: [{ node: name, durationMs: Math.round(performance.now() - started) }] };
    };

  const prepare = traced('prepare', (): Update => {
    const { context: redactedContext, redactions } = redactContext(input.context);
    return {
      redactedContext,
      secretsRedacted: redactions,
      // Static analysis needs the original lines (to find secrets); its evidence is redacted.
      staticFindings: runStaticAnalysis(input.context),
      prompt: buildReviewPrompt(redactedContext, {
        categories: input.settings.categories,
        minimumSeverity: input.settings.minimumSeverity,
        ...(input.settings.framework ? { framework: input.settings.framework } : {}),
        ...(input.settings.language ? { language: input.settings.language } : {}),
      }),
    };
  });

  const aiReview = async (state: State): Promise<Update> => {
    const provider = state.task?.provider;
    const reviewer = provider ? reviewers.get(provider) : undefined;
    if (!reviewer || !state.prompt) return {};
    const started = performance.now();
    const signals = [AbortSignal.timeout(input.settings.providerTimeoutMs), ...(input.signal ? [input.signal] : [])];
    const base = { provider: reviewer.provider, model: reviewer.model, rawFindingCount: 0 };
    try {
      const result = await reviewer.review(state.prompt, AbortSignal.any(signals));
      const parsed = parseModelOutput(result.output);
      const execution: ModelExecution = {
        ...base,
        servedByModel: result.servedByModel,
        latencyMs: result.latencyMs,
        usage: { ...result.usage },
        costUsd: result.costUsd,
        ...(result.requestId ? { requestId: result.requestId } : {}),
        ...(parsed.ok
          ? { status: 'succeeded' as const, rawFindingCount: parsed.output.findings.length }
          : {
              status: 'failed' as const,
              errorKind: 'invalid_output',
              errorMessage: `Output failed schema validation: ${parsed.problems.join('; ')}`,
            }),
      };
      return {
        executions: [execution],
        modelOutputs: parsed.ok ? [{ provider: reviewer.provider, output: parsed.output }] : [],
        trace: [{ node: `ai_review:${reviewer.provider}`, durationMs: Math.round(performance.now() - started) }],
      };
    } catch (error) {
      const providerError =
        error instanceof AiProviderError
          ? error
          : new AiProviderError(
              reviewer.provider,
              'unknown',
              error instanceof Error ? error.message.slice(0, 300) : 'Unknown error',
            );
      return {
        executions: [
          {
            ...base,
            servedByModel: null,
            status: 'failed',
            errorKind: providerError.kind,
            errorMessage: providerError.message,
            latencyMs: Math.round(performance.now() - started),
            usage: { inputTokens: 0, outputTokens: 0 },
            costUsd: null,
          },
        ],
        trace: [{ node: `ai_review:${reviewer.provider}`, durationMs: Math.round(performance.now() - started) }],
      };
    }
  };

  const aggregate = traced('aggregate', (state) => {
    const { candidates, rejected } = aggregateFindings(state.modelOutputs, state.staticFindings);
    return { candidates, aggregationRejected: rejected };
  });

  const validate = traced('validate', (state) => ({
    // Validate against the context the models actually saw (redacted), so evidence matches.
    validation: validateFindings(state.redactedContext ?? input.context, state.candidates, {
      enabledCategories: input.settings.categories,
    }),
  }));

  const deduplicate = traced('deduplicate', (state) => ({
    merged: deduplicateFindings(state.validation?.accepted ?? []),
  }));

  // Not wrapped in traced(): the report must include finalize's own duration.
  const finalize = (state: State): Update => {
    const finalizeStarted = performance.now();
    const timestamp = now().toISOString();
    // A prior finding only counts as resolved when an AI reviewer actually looked at the code again.
    // If every reviewer failed (quota, timeout, refusal), its absence proves nothing.
    const anyReviewerSucceeded = state.executions.some((e) => e.status === 'succeeded');
    const reconciliation = reconcileFindings(
      input.priorFindings ?? [],
      new Set(state.merged.map((m) => m.fingerprint)),
      anyReviewerSucceeded ? new Set(input.context.files.map((f) => f.path)) : new Set<string>(),
    );
    const { findings, filtered } = selectFindings(state.merged, {
      minimumSeverity: input.settings.minimumSeverity,
      minimumConfidence: input.settings.minimumConfidence,
      reviewSessionId: reviewId,
      repositoryId: input.repository.repositoryId,
      commitSha: input.repository.headSha,
      now: timestamp,
      reconciliation,
    });

    const skipped: ModelExecution[] = (input.skippedProviders ?? []).map((s) => ({
      provider: s.provider,
      model: s.model,
      servedByModel: null,
      status: 'skipped',
      errorMessage: s.reason,
      latencyMs: 0,
      usage: { inputTokens: 0, outputTokens: 0 },
      costUsd: null,
      rawFindingCount: 0,
    }));
    const executions = [...state.executions, ...skipped].sort((a, b) => a.provider.localeCompare(b.provider));
    const ran = state.executions;
    const succeeded = ran.filter((e) => e.status === 'succeeded').length;
    const status = succeeded === 0 ? 'failed' : succeeded === ran.length ? 'completed' : 'partial';
    const costs = ran.map((e) => e.costUsd).filter((c): c is number => c !== null);

    const rejected = [
      ...state.aggregationRejected,
      ...(state.validation?.rejected ?? []).map(({ candidate, reason }) => ({
        source: candidate.source,
        filePath: candidate.filePath,
        title: candidate.title,
        reason,
      })),
    ];
    const bySeverity: Record<string, number> = {};
    for (const finding of findings) bySeverity[finding.severity] = (bySeverity[finding.severity] ?? 0) + 1;

    const report: ReviewReport = {
      schemaVersion: 1,
      reviewId,
      createdAt: timestamp,
      status,
      repository: {
        rootPath: input.repository.rootPath,
        branch: input.repository.branch,
        headSha: input.repository.headSha,
      },
      scope: { ...input.context.scope },
      scopeDescription: describeScope(input.context.scope),
      contextHash: input.context.contextHash,
      promptHash: state.prompt?.promptHash ?? '',
      secretsRedacted: state.secretsRedacted,
      settings: {
        providers: input.reviewers.map((r) => r.provider),
        categories: [...input.settings.categories],
        minimumSeverity: input.settings.minimumSeverity,
        minimumConfidence: input.settings.minimumConfidence,
      },
      stats: {
        filesReviewed: input.context.files.length,
        filesOmitted: input.context.omitted.length,
        candidates: state.candidates.length + state.aggregationRejected.length,
        rejected: rejected.length,
        filtered: filtered.length,
        findings: findings.length,
        bySeverity,
        totalCostUsd: costs.length > 0 ? Math.round(costs.reduce((a, b) => a + b, 0) * 1_000_000) / 1_000_000 : null,
      },
      executions,
      findings,
      filtered,
      rejected,
      resolved: reconciliation.resolved.map((r) => ({ id: r.id, fingerprint: r.fingerprint, filePath: r.filePath })),
      modelSummaries: Object.fromEntries(state.modelOutputs.map((o) => [o.provider, o.output.summary.slice(0, 2_000)])),
      trace: [...state.trace, { node: 'finalize', durationMs: 0 }],
    };
    const trace = report.trace.at(-1);
    if (trace)
      report.trace[report.trace.length - 1] = { ...trace, durationMs: Math.round(performance.now() - finalizeStarted) };
    return { report };
  };

  return new StateGraph(ReviewState)
    .addNode('prepare', prepare)
    .addNode('ai_review', aiReview)
    .addNode('aggregate', aggregate)
    .addNode('validate', validate)
    .addNode('deduplicate', deduplicate)
    .addNode('finalize', finalize)
    .addEdge(START, 'prepare')
    .addConditionalEdges(
      'prepare',
      // A Send branch receives ONLY its payload (not the shared state), so the prompt travels with it.
      (state: State) =>
        input.reviewers.length > 0
          ? input.reviewers.map(
              (reviewer) => new Send('ai_review', { task: { provider: reviewer.provider }, prompt: state.prompt }),
            )
          : ['aggregate'],
      ['ai_review', 'aggregate'],
    )
    .addEdge('ai_review', 'aggregate')
    .addEdge('aggregate', 'validate')
    .addEdge('validate', 'deduplicate')
    .addEdge('deduplicate', 'finalize')
    .addEdge('finalize', END)
    .compile();
}

/** Runs the full review pipeline and returns the report. */
export async function runReview(input: ReviewRunInput): Promise<ReviewReport> {
  const graph = createReviewGraph(input);
  const state = await graph.invoke(
    { staticFindings: [], candidates: [], aggregationRejected: [], merged: [], secretsRedacted: 0 },
    { recursionLimit: 25 },
  );
  if (!state.report) throw new Error('Review pipeline finished without a report');
  return state.report;
}
