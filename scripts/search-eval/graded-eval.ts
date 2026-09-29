export const GRADED_REPORT_SCHEMA_VERSION = 2;

export type QueryClass =
  | 'terse'
  | 'paraphrase'
  | 'question'
  | 'instance-to-rule'
  | 'narrowing'
  | 'typo-concept'
  | 'duplicate-family'
  | 'must-not-match'
  | 'doc-number';

export type RelevanceGrade = -1 | 1 | 2;
export type QuerySplit = 'development' | 'held-out';

/**
 * A judgment is one relevance unit. Usually it contains one document number. Duplicate
 * families contain every interchangeable member so the family contributes at most once.
 * Unlisted documents have the implicit grade 0.
 */
export interface RelevanceJudgment {
  docNos: string[];
  grade: RelevanceGrade;
}

export interface GradedQuery {
  id: string;
  query: string;
  class: QueryClass;
  split: QuerySplit;
  judgments: RelevanceJudgment[];
}

export interface QueryMetrics {
  ndcg10: number;
  reciprocalRank: number;
  recall10: number;
  recall50: number;
  /** Defined only for the must-not-match class. */
  precision5?: number;
}

export interface EvaluatedQuery extends QueryMetrics {
  id: string;
  query: string;
  class: QueryClass;
  split: QuerySplit;
  queryMs: number;
}

export interface MetricSummary {
  queries: number;
  ndcg10: number;
  mrr: number;
  recall10: number;
  recall50: number;
  /** Mean over must-not-match queries only; omitted where the group has none. */
  precision5?: number;
}

export interface BootstrapInterval {
  difference: number;
  low: number;
  high: number;
}

export type ComparisonMetrics = Pick<MetricSummary, 'ndcg10' | 'mrr' | 'recall10' | 'recall50' | 'precision5'>;
export type ComparisonIntervals = Partial<Record<keyof ComparisonMetrics, BootstrapInterval>>;

export interface GradedReport {
  schemaVersion: number;
  label: string;
  generatedAt: string;
  corpus: {
    url: string;
    documents: number;
    sha256: string;
  };
  engine: string;
  querySet: {
    total: number;
    development: number;
    heldOut: number;
    evaluated: number;
    heldOutIncluded: boolean;
    sha256: string;
  };
  evaluation: {
    /** Maximum rank inspected. MRR is therefore MRR@resultLimit. */
    resultLimit: number;
    ndcgCutoff: number;
    recallCutoffs: [number, number];
    precisionCutoff: number;
  };
  performance: {
    indexBuildMs: number;
    timeToFirstSearchMs: number;
    queryP50Ms: number;
    queryP95Ms: number;
    /** Present for SEARCH-20 runs; client-to-server-to-client dense request only. */
    serverRoundTripP50Ms?: number;
    serverRoundTripP95Ms?: number;
    peakRssMb: number;
    payloadMb: {
      index: number;
      vectors: number;
      model: number;
      total: number;
    };
  };
  summary: MetricSummary;
  byClass: Record<string, MetricSummary>;
  bySplit: Partial<Record<QuerySplit, MetricSummary>>;
  queries: EvaluatedQuery[];
  /**
   * Distinct-information metrics (SEARCH-22 part A), present when the duplicate census
   * matches the evaluated corpus. Optional and additive: schema version 2 reports
   * without it remain valid and comparable on the flat metrics.
   */
  diversity?: {
    censusSha256: string;
    cosineThreshold: number;
    alpha: number;
    summary: { distinctFamilies10: number; alphaNdcg10: number };
    byClass: Record<string, { distinctFamilies10: number; alphaNdcg10: number }>;
    queries: Array<{ id: string; distinctFamilies10: number; alphaNdcg10: number }>;
  };
}

export interface ReportComparison {
  all: ComparisonIntervals;
  byClass: Record<string, ComparisonIntervals>;
  bySplit: Partial<Record<QuerySplit, ComparisonIntervals>>;
}

function gain(grade: RelevanceGrade): number {
  return grade > 0 ? 2 ** grade - 1 : 0;
}

function discount(rankIndex: number): number {
  return Math.log2(rankIndex + 2);
}

function positiveJudgments(query: GradedQuery): RelevanceJudgment[] {
  return query.judgments.filter((judgment) => judgment.grade > 0);
}

function foundJudgmentIndexes(judgments: RelevanceJudgment[], resultDocNos: string[], limit: number): Set<number> {
  const found = new Set<number>();
  for (const docNo of resultDocNos.slice(0, limit)) {
    const index = judgments.findIndex((judgment) => judgment.docNos.includes(docNo));
    if (index >= 0) found.add(index);
  }
  return found;
}

export function scoreRanking(query: GradedQuery, resultDocNos: string[]): QueryMetrics {
  const positives = positiveJudgments(query);
  const seen = new Set<number>();
  let dcg = 0;

  for (const [rankIndex, docNo] of resultDocNos.slice(0, 10).entries()) {
    const judgmentIndex = query.judgments.findIndex(
      (judgment, index) => judgment.grade > 0 && !seen.has(index) && judgment.docNos.includes(docNo),
    );
    if (judgmentIndex < 0) continue;

    seen.add(judgmentIndex);
    const judgment = query.judgments[judgmentIndex];
    dcg += gain(judgment.grade) / discount(rankIndex);
  }

  const firstRelevantIndex = resultDocNos.findIndex((docNo) =>
    positives.some((judgment) => judgment.docNos.includes(docNo)),
  );

  const idealGrades = positives.map((judgment) => judgment.grade).sort((a, b) => b - a);
  const idealDcg = idealGrades.slice(0, 10).reduce((sum, grade, index) => sum + gain(grade) / discount(index), 0);
  const relevantCount = positives.length;
  const recall = (limit: number): number =>
    relevantCount === 0 ? 1 : foundJudgmentIndexes(positives, resultDocNos, limit).size / relevantCount;

  let precision5: number | undefined;
  if (query.class === 'must-not-match') {
    const explicitWrong = new Set(
      query.judgments.filter((judgment) => judgment.grade === -1).flatMap((judgment) => judgment.docNos),
    );
    const top = resultDocNos.slice(0, 5);
    precision5 = top.length === 0 ? 1 : top.filter((docNo) => !explicitWrong.has(docNo)).length / top.length;
  }

  return {
    ndcg10: idealDcg === 0 ? 0 : dcg / idealDcg,
    reciprocalRank: firstRelevantIndex < 0 ? 0 : 1 / (firstRelevantIndex + 1),
    recall10: recall(10),
    recall50: recall(50),
    ...(precision5 === undefined ? {} : { precision5 }),
  };
}

function mean(values: number[]): number {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}

export function summarizeQueries(queries: EvaluatedQuery[]): MetricSummary {
  const precisionValues = queries.flatMap((query) => (query.precision5 === undefined ? [] : [query.precision5]));
  return {
    queries: queries.length,
    ndcg10: mean(queries.map((query) => query.ndcg10)),
    mrr: mean(queries.map((query) => query.reciprocalRank)),
    recall10: mean(queries.map((query) => query.recall10)),
    recall50: mean(queries.map((query) => query.recall50)),
    ...(precisionValues.length === 0 ? {} : { precision5: mean(precisionValues) }),
  };
}

export function percentile(values: number[], proportion: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(proportion * sorted.length) - 1));
  return sorted[index];
}

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

type MetricAccessor = (query: EvaluatedQuery) => number | undefined;

const METRIC_ACCESSORS: Record<keyof ComparisonMetrics, MetricAccessor> = {
  ndcg10: (query) => query.ndcg10,
  mrr: (query) => query.reciprocalRank,
  recall10: (query) => query.recall10,
  recall50: (query) => query.recall50,
  precision5: (query) => query.precision5,
};

/** Deterministic paired bootstrap over the queries shared by both reports. */
export function pairedBootstrap(
  current: EvaluatedQuery[],
  baseline: EvaluatedQuery[],
  iterations = 1_000,
  seed = 15,
): ComparisonIntervals {
  if (!Number.isInteger(iterations) || iterations <= 0) {
    throw new Error('Bootstrap iterations must be a positive integer.');
  }

  const baselineById = new Map(baseline.map((query) => [query.id, query]));
  const intervals: ComparisonIntervals = {};

  for (const [metric, access] of Object.entries(METRIC_ACCESSORS) as [keyof ComparisonMetrics, MetricAccessor][]) {
    const pairs = current.flatMap((query) => {
      const oldQuery = baselineById.get(query.id);
      const now = access(query);
      const before = oldQuery && access(oldQuery);
      return oldQuery && now !== undefined && before !== undefined ? [{ now, before }] : [];
    });
    if (pairs.length === 0) continue;

    const difference = mean(pairs.map((pair) => pair.now - pair.before));
    const random = mulberry32(seed);
    const sampledDifferences: number[] = [];
    for (let iteration = 0; iteration < iterations; iteration += 1) {
      let sum = 0;
      for (let draw = 0; draw < pairs.length; draw += 1) {
        const pair = pairs[Math.floor(random() * pairs.length)];
        sum += pair.now - pair.before;
      }
      sampledDifferences.push(sum / pairs.length);
    }

    intervals[metric] = {
      difference,
      low: percentile(sampledDifferences, 0.025),
      high: percentile(sampledDifferences, 0.975),
    };
  }

  return intervals;
}

export function groupByClass(queries: EvaluatedQuery[]): Record<string, MetricSummary> {
  return Object.fromEntries(
    Array.from(new Set(queries.map((query) => query.class)))
      .sort()
      .map((queryClass) => [queryClass, summarizeQueries(queries.filter((query) => query.class === queryClass))]),
  );
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isUnitInterval(value: unknown): value is number {
  return isFiniteNumber(value) && value >= 0 && value <= 1;
}

function isEvaluatedQuery(value: unknown): value is EvaluatedQuery {
  if (!value || typeof value !== 'object') return false;
  const query = value as Partial<EvaluatedQuery>;
  return (
    typeof query.id === 'string' &&
    query.id.length > 0 &&
    typeof query.query === 'string' &&
    query.query.length > 0 &&
    typeof query.class === 'string' &&
    [
      'terse',
      'paraphrase',
      'question',
      'instance-to-rule',
      'narrowing',
      'typo-concept',
      'duplicate-family',
      'must-not-match',
      'doc-number',
    ].includes(query.class) &&
    (query.split === 'development' || query.split === 'held-out') &&
    isUnitInterval(query.ndcg10) &&
    isUnitInterval(query.reciprocalRank) &&
    isUnitInterval(query.recall10) &&
    isUnitInterval(query.recall50) &&
    isFiniteNumber(query.queryMs) &&
    query.queryMs >= 0 &&
    (query.class === 'must-not-match' ? isUnitInterval(query.precision5) : query.precision5 === undefined)
  );
}

function isMetricSummary(value: unknown): value is MetricSummary {
  if (!value || typeof value !== 'object') return false;
  const summary = value as Partial<MetricSummary>;
  return (
    Number.isInteger(summary.queries) &&
    (summary.queries ?? -1) >= 0 &&
    isUnitInterval(summary.ndcg10) &&
    isUnitInterval(summary.mrr) &&
    isUnitInterval(summary.recall10) &&
    isUnitInterval(summary.recall50) &&
    (summary.precision5 === undefined || isUnitInterval(summary.precision5))
  );
}

function summariesMatch(actual: MetricSummary, expected: MetricSummary): boolean {
  const close = (left: number | undefined, right: number | undefined): boolean =>
    left === undefined || right === undefined ? left === right : Math.abs(left - right) <= 0.000001;
  return (
    actual.queries === expected.queries &&
    close(actual.ndcg10, expected.ndcg10) &&
    close(actual.mrr, expected.mrr) &&
    close(actual.recall10, expected.recall10) &&
    close(actual.recall50, expected.recall50) &&
    close(actual.precision5, expected.precision5)
  );
}

/** Runtime guard for reports loaded from disk by --compare. */
export function isGradedReport(value: unknown): value is GradedReport {
  if (!value || typeof value !== 'object') return false;
  const report = value as Partial<GradedReport>;
  const querySet = report.querySet;
  const corpus = report.corpus;
  const evaluation = report.evaluation;
  const performance = report.performance;
  const hasValidServerRoundTrip =
    performance?.serverRoundTripP50Ms === undefined && performance?.serverRoundTripP95Ms === undefined
      ? true
      : isFiniteNumber(performance?.serverRoundTripP50Ms) &&
        (performance?.serverRoundTripP50Ms ?? -1) >= 0 &&
        isFiniteNumber(performance?.serverRoundTripP95Ms) &&
        (performance?.serverRoundTripP95Ms ?? -1) >= (performance?.serverRoundTripP50Ms ?? 0);

  if (
    report.schemaVersion !== GRADED_REPORT_SCHEMA_VERSION ||
    typeof report.label !== 'string' ||
    report.label.length === 0 ||
    typeof report.generatedAt !== 'string' ||
    Number.isNaN(Date.parse(report.generatedAt)) ||
    typeof report.engine !== 'string' ||
    report.engine.length === 0 ||
    !corpus ||
    typeof corpus.url !== 'string' ||
    !Number.isInteger(corpus.documents) ||
    (corpus.documents ?? -1) < 0 ||
    typeof corpus.sha256 !== 'string' ||
    !/^[a-f0-9]{64}$/.test(corpus.sha256) ||
    !querySet ||
    !Number.isInteger(querySet.total) ||
    (querySet.total ?? -1) < 0 ||
    !Number.isInteger(querySet.development) ||
    (querySet.development ?? -1) < 0 ||
    !Number.isInteger(querySet.heldOut) ||
    (querySet.heldOut ?? -1) < 0 ||
    !Number.isInteger(querySet.evaluated) ||
    (querySet.evaluated ?? -1) < 0 ||
    typeof querySet.heldOutIncluded !== 'boolean' ||
    typeof querySet.sha256 !== 'string' ||
    !/^[a-f0-9]{64}$/.test(querySet.sha256) ||
    !evaluation ||
    !Number.isInteger(evaluation.resultLimit) ||
    evaluation.resultLimit <= 0 ||
    !Number.isInteger(evaluation.ndcgCutoff) ||
    evaluation.ndcgCutoff <= 0 ||
    !Array.isArray(evaluation.recallCutoffs) ||
    evaluation.recallCutoffs.length !== 2 ||
    !evaluation.recallCutoffs.every((cutoff) => Number.isInteger(cutoff) && cutoff > 0) ||
    !Number.isInteger(evaluation.precisionCutoff) ||
    evaluation.precisionCutoff <= 0 ||
    evaluation.resultLimit < Math.max(evaluation.ndcgCutoff, ...evaluation.recallCutoffs, evaluation.precisionCutoff) ||
    !performance ||
    !isFiniteNumber(performance.indexBuildMs) ||
    performance.indexBuildMs < 0 ||
    !isFiniteNumber(performance.timeToFirstSearchMs) ||
    performance.timeToFirstSearchMs < 0 ||
    !isFiniteNumber(performance.queryP50Ms) ||
    performance.queryP50Ms < 0 ||
    !isFiniteNumber(performance.queryP95Ms) ||
    performance.queryP95Ms < performance.queryP50Ms ||
    !hasValidServerRoundTrip ||
    !isFiniteNumber(performance.peakRssMb) ||
    performance.peakRssMb < 0 ||
    !performance.payloadMb ||
    !isFiniteNumber(performance.payloadMb.index) ||
    performance.payloadMb.index < 0 ||
    !isFiniteNumber(performance.payloadMb.vectors) ||
    performance.payloadMb.vectors < 0 ||
    !isFiniteNumber(performance.payloadMb.model) ||
    performance.payloadMb.model < 0 ||
    !isFiniteNumber(performance.payloadMb.total) ||
    performance.payloadMb.total < 0 ||
    !isMetricSummary(report.summary) ||
    !report.byClass ||
    typeof report.byClass !== 'object' ||
    !Object.values(report.byClass).every(isMetricSummary) ||
    !report.bySplit ||
    typeof report.bySplit !== 'object' ||
    !Object.values(report.bySplit).every(isMetricSummary) ||
    !Array.isArray(report.queries) ||
    !report.queries.every(isEvaluatedQuery)
  ) {
    return false;
  }

  const queries = report.queries as EvaluatedQuery[];
  const byClass = report.byClass as Record<string, MetricSummary>;
  const bySplit = report.bySplit as Partial<Record<QuerySplit, MetricSummary>>;
  const ids = queries.map((query) => query.id);
  const actualDevelopment = queries.filter((query) => query.split === 'development').length;
  const actualHeldOut = queries.filter((query) => query.split === 'held-out').length;
  if (
    new Set(ids).size !== ids.length ||
    querySet.total !== querySet.development + querySet.heldOut ||
    querySet.evaluated !== queries.length ||
    actualDevelopment !== querySet.development ||
    actualHeldOut !== (querySet.heldOutIncluded ? querySet.heldOut : 0) ||
    (!querySet.heldOutIncluded && querySet.evaluated !== querySet.development) ||
    (!querySet.heldOutIncluded && queries.some((query) => query.split === 'held-out')) ||
    (querySet.heldOutIncluded && querySet.evaluated !== querySet.total) ||
    Math.abs(
      performance.payloadMb.total -
        (performance.payloadMb.index + performance.payloadMb.vectors + performance.payloadMb.model),
    ) > 0.000001
  ) {
    return false;
  }

  const expectedByClass = groupByClass(queries);
  const expectedBySplit = Object.fromEntries(
    Array.from(new Set(queries.map((query) => query.split))).map((split) => [
      split,
      summarizeQueries(queries.filter((query) => query.split === split)),
    ]),
  );
  const sameKeys = (left: object, right: object): boolean => {
    const leftKeys = Object.keys(left).sort();
    const rightKeys = Object.keys(right).sort();
    return leftKeys.length === rightKeys.length && leftKeys.every((key, index) => key === rightKeys[index]);
  };
  if (
    !summariesMatch(report.summary, summarizeQueries(queries)) ||
    !sameKeys(byClass, expectedByClass) ||
    !sameKeys(bySplit, expectedBySplit) ||
    !Object.entries(expectedByClass).every(([key, summary]) => summariesMatch(byClass[key], summary)) ||
    !Object.entries(expectedBySplit).every(([key, summary]) =>
      summariesMatch(bySplit[key as QuerySplit] as MetricSummary, summary),
    )
  ) {
    return false;
  }

  return true;
}

export function compareReports(
  current: GradedReport,
  baseline: GradedReport,
  allowCorpusDrift = false,
): ReportComparison {
  if (current.querySet.sha256 !== baseline.querySet.sha256) {
    throw new Error('Cannot compare reports from different graded query-set revisions.');
  }
  if (
    current.evaluation.resultLimit !== baseline.evaluation.resultLimit ||
    current.evaluation.ndcgCutoff !== baseline.evaluation.ndcgCutoff ||
    current.evaluation.precisionCutoff !== baseline.evaluation.precisionCutoff ||
    current.evaluation.recallCutoffs[0] !== baseline.evaluation.recallCutoffs[0] ||
    current.evaluation.recallCutoffs[1] !== baseline.evaluation.recallCutoffs[1]
  ) {
    throw new Error('Cannot compare reports produced with different evaluation cutoffs.');
  }
  if (!allowCorpusDrift && current.corpus.sha256 !== baseline.corpus.sha256) {
    throw new Error('Cannot compare reports from different corpora without --allow-corpus-drift.');
  }

  const baselineById = new Map(baseline.queries.map((query) => [query.id, query]));
  for (const query of current.queries) {
    const oldQuery = baselineById.get(query.id);
    if (!oldQuery) throw new Error(`Baseline is missing evaluated query ${query.id}.`);
    if (oldQuery.query !== query.query || oldQuery.class !== query.class || oldQuery.split !== query.split) {
      throw new Error(`Query metadata changed for ${query.id}; regenerate an explicit baseline.`);
    }
  }

  const compareGroup = (queries: EvaluatedQuery[]): ComparisonIntervals => {
    const ids = new Set(queries.map((query) => query.id));
    return pairedBootstrap(
      queries,
      baseline.queries.filter((query) => ids.has(query.id)),
    );
  };
  const classes = Array.from(new Set(current.queries.map((query) => query.class))).sort();
  const splits = Array.from(new Set(current.queries.map((query) => query.split))).sort() as QuerySplit[];

  return {
    all: compareGroup(current.queries),
    byClass: Object.fromEntries(
      classes.map((queryClass) => [
        queryClass,
        compareGroup(current.queries.filter((query) => query.class === queryClass)),
      ]),
    ),
    bySplit: Object.fromEntries(
      splits.map((split) => [split, compareGroup(current.queries.filter((query) => query.split === split))]),
    ),
  };
}
