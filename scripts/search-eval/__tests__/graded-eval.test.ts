// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  type EvaluatedQuery,
  GRADED_REPORT_SCHEMA_VERSION,
  type GradedQuery,
  type GradedReport,
  compareReports,
  groupByClass,
  isGradedReport,
  pairedBootstrap,
  percentile,
  scoreRanking,
  summarizeQueries,
} from '../graded-eval';

function query(overrides: Partial<GradedQuery> = {}): GradedQuery {
  return {
    id: 'P01',
    query: 'reader phrasing',
    class: 'paraphrase',
    split: 'development',
    judgments: [
      { docNos: ['primary'], grade: 2 },
      { docNos: ['secondary'], grade: 1 },
    ],
    ...overrides,
  };
}

function evaluated(id: string, ndcg10: number, precision5?: number): EvaluatedQuery {
  return {
    id,
    query: id,
    class: precision5 === undefined ? 'paraphrase' : 'must-not-match',
    split: 'development',
    ndcg10,
    reciprocalRank: ndcg10,
    recall10: ndcg10,
    recall50: ndcg10,
    ...(precision5 === undefined ? {} : { precision5 }),
    queryMs: 1,
  };
}

function report(queries: EvaluatedQuery[], overrides: Partial<GradedReport> = {}): GradedReport {
  const development = queries.filter((query) => query.split === 'development');
  const heldOut = queries.filter((query) => query.split === 'held-out');
  return {
    schemaVersion: GRADED_REPORT_SCHEMA_VERSION,
    label: 'test report',
    generatedAt: '2026-08-30T00:00:00.000Z',
    corpus: { url: 'test://corpus', documents: 10, sha256: 'a'.repeat(64) },
    engine: 'test engine',
    querySet: {
      total: queries.length,
      development: development.length,
      heldOut: heldOut.length,
      evaluated: queries.length,
      heldOutIncluded: heldOut.length > 0,
      sha256: 'b'.repeat(64),
    },
    evaluation: {
      resultLimit: 100,
      ndcgCutoff: 10,
      recallCutoffs: [10, 50],
      precisionCutoff: 5,
    },
    performance: {
      indexBuildMs: 1,
      timeToFirstSearchMs: 2,
      queryP50Ms: 1,
      queryP95Ms: 2,
      peakRssMb: 10,
      payloadMb: { index: 1, vectors: 0, model: 0, total: 1 },
    },
    summary: summarizeQueries(queries),
    byClass: groupByClass(queries),
    bySplit: {
      ...(development.length === 0 ? {} : { development: summarizeQueries(development) }),
      ...(heldOut.length === 0 ? {} : { 'held-out': summarizeQueries(heldOut) }),
    },
    queries,
    ...overrides,
  };
}

describe('scoreRanking', () => {
  it('scores an ideal ranking as one', () => {
    expect(scoreRanking(query(), ['primary', 'secondary'])).toEqual({
      ndcg10: 1,
      reciprocalRank: 1,
      recall10: 1,
      recall50: 1,
    });
  });

  it('counts an interchangeable duplicate family once', () => {
    const duplicateQuery = query({
      class: 'duplicate-family',
      judgments: [
        { docNos: ['copy-a', 'copy-b', 'copy-c'], grade: 2 },
        { docNos: ['support'], grade: 1 },
      ],
    });

    const metrics = scoreRanking(duplicateQuery, ['copy-a', 'copy-b', 'copy-c', 'support']);
    expect(metrics.recall10).toBe(1);
    expect(metrics.ndcg10).toBeLessThan(1);
    expect(metrics.ndcg10).toBeGreaterThan(0.9);
  });

  it('computes reciprocal rank beyond the nDCG cutoff', () => {
    const results = [...Array.from({ length: 19 }, (_, index) => `other-${index}`), 'primary'];
    expect(scoreRanking(query(), results)).toMatchObject({ ndcg10: 0, reciprocalRank: 0.05 });
  });

  it('uses graded gains and rank discounts for nDCG', () => {
    const metrics = scoreRanking(query(), ['secondary', 'primary']);
    const expected = (1 + 3 / Math.log2(3)) / (3 + 1 / Math.log2(3));
    expect(metrics.ndcg10).toBeCloseTo(expected);
  });

  it('penalizes explicit wrong documents only on must-not-match precision', () => {
    const trap = query({
      class: 'must-not-match',
      judgments: [
        { docNos: ['right'], grade: 2 },
        { docNos: ['wrong'], grade: -1 },
      ],
    });

    expect(scoreRanking(trap, ['unjudged', 'wrong', 'right']).precision5).toBeCloseTo(2 / 3);
  });
});

describe('report helpers', () => {
  it('summarizes precision only across queries where it is defined', () => {
    expect(summarizeQueries([evaluated('one', 1), evaluated('two', 0.5, 0.8)])).toMatchObject({
      queries: 2,
      ndcg10: 0.75,
      precision5: 0.8,
    });
  });

  it('uses deterministic nearest-rank percentiles', () => {
    expect(percentile([4, 1, 3, 2], 0.5)).toBe(2);
  });

  it('returns zero-width intervals when comparing a report with itself', () => {
    const report = [evaluated('one', 1), evaluated('two', 0.5, 0.8)];
    const comparison = pairedBootstrap(report, report, 100);
    expect(comparison.ndcg10).toEqual({ difference: 0, low: 0, high: 0 });
    expect(comparison.precision5).toEqual({ difference: 0, low: 0, high: 0 });
  });

  it('bootstraps paired differences rather than unrelated samples', () => {
    const baseline = [evaluated('one', 0.2), evaluated('two', 0.4)];
    const current = [evaluated('one', 0.4), evaluated('two', 0.6)];
    expect(pairedBootstrap(current, baseline, 100).ndcg10).toEqual({
      difference: 0.19999999999999998,
      low: 0.19999999999999996,
      high: 0.2,
    });
  });

  it('rejects invalid bootstrap iteration counts', () => {
    expect(() => pairedBootstrap([evaluated('one', 1)], [evaluated('one', 1)], 0)).toThrow('positive integer');
  });
});

describe('report validation and comparison', () => {
  it('accepts a complete schema-v2 report and rejects duplicate ids or invalid metrics', () => {
    const valid = report([evaluated('one', 1), evaluated('two', 0.5)]);
    expect(isGradedReport(valid)).toBe(true);

    const duplicate = structuredClone(valid);
    duplicate.queries[1].id = 'one';
    expect(isGradedReport(duplicate)).toBe(false);

    const invalidMetric = structuredClone(valid);
    invalidMetric.queries[0].ndcg10 = Number.NaN;
    expect(isGradedReport(invalidMetric)).toBe(false);

    const inconsistentSummary = structuredClone(valid);
    inconsistentSummary.summary.mrr = 0;
    expect(isGradedReport(inconsistentSummary)).toBe(false);

    const inconsistentSplitCounts = structuredClone(valid);
    inconsistentSplitCounts.querySet.development -= 1;
    inconsistentSplitCounts.querySet.heldOut += 1;
    expect(isGradedReport(inconsistentSplitCounts)).toBe(false);

    const misplacedPrecision = structuredClone(valid);
    misplacedPrecision.queries[0].precision5 = 1;
    expect(isGradedReport(misplacedPrecision)).toBe(false);

    const withServerRoundTrip = structuredClone(valid);
    withServerRoundTrip.performance.serverRoundTripP50Ms = 12;
    withServerRoundTrip.performance.serverRoundTripP95Ms = 20;
    expect(isGradedReport(withServerRoundTrip)).toBe(true);

    const incompleteServerRoundTrip = structuredClone(valid);
    incompleteServerRoundTrip.performance.serverRoundTripP50Ms = 12;
    expect(isGradedReport(incompleteServerRoundTrip)).toBe(false);
  });

  it('rejects query-set drift, corpus drift, and missing baseline queries', () => {
    const current = report([evaluated('one', 0.8)]);

    const changedSet = report([evaluated('one', 0.5)]);
    changedSet.querySet.sha256 = 'c'.repeat(64);
    expect(() => compareReports(current, changedSet)).toThrow('different graded query-set revisions');

    const changedCorpus = report([evaluated('one', 0.5)]);
    changedCorpus.corpus.sha256 = 'd'.repeat(64);
    expect(() => compareReports(current, changedCorpus)).toThrow('different corpora');
    expect(compareReports(current, changedCorpus, true).all.ndcg10?.difference).toBeCloseTo(0.3);

    const changedCutoff = report([evaluated('one', 0.5)]);
    changedCutoff.evaluation.resultLimit = 50;
    expect(() => compareReports(current, changedCutoff)).toThrow('different evaluation cutoffs');

    const missing = report([evaluated('two', 0.5)]);
    expect(() => compareReports(current, missing)).toThrow('missing evaluated query one');
  });

  it('reports paired intervals overall, per class, and per split', () => {
    const before = [evaluated('one', 0.2), evaluated('two', 0.4, 0.8)];
    const after = [evaluated('one', 0.4), evaluated('two', 0.6, 1)];
    const comparison = compareReports(report(after), report(before));

    expect(comparison.all.ndcg10?.difference).toBeCloseTo(0.2);
    expect(comparison.byClass.paraphrase.ndcg10?.difference).toBeCloseTo(0.2);
    expect(comparison.byClass['must-not-match'].precision5?.difference).toBeCloseTo(0.2);
    expect(comparison.bySplit.development?.ndcg10?.difference).toBeCloseTo(0.2);
  });
});
