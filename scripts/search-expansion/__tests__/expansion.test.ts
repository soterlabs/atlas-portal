import { describe, expect, it } from 'vitest';
import { createDoc, createFixtureTree } from '../../../app/atlas/search/__tests__/fixtures';
import { flattenAtlasDocuments } from '../../../app/atlas/search/flatten-documents';
import { EXPANSION_WORD_LIMIT, buildPrompt, findLeaks, parseExpansionResponse } from '../prompt';
import { type ExpansionStore, documentHash, documentKey, expansionMap, expansionText, staleDocuments } from '../store';

const docs = flattenAtlasDocuments(createFixtureTree());
const target = docs.find((doc) => doc.doc_no === 'A.1.6.4')!;

function storeWith(entries: ExpansionStore['entries']): ExpansionStore {
  return { version: 1, entries };
}

describe('store', () => {
  it('keys a document by uuid, falling back to doc_no', () => {
    // Fixture documents carry uuid: null, so the fallback applies.
    expect(documentKey(target)).toBe('A.1.6.4');
  });

  it('changes the hash when body, name, extras or location change', () => {
    const base = documentHash(target);
    const moved = { ...target, breadcrumb: ['Somewhere', 'Else'] };
    const renamed = { ...target, name: 'Renamed' };
    expect(documentHash(moved)).not.toBe(base);
    expect(documentHash(renamed)).not.toBe(base);
    expect(documentHash({ ...target })).toBe(base);
  });

  it('treats missing and out-of-date entries as stale, current ones as fresh', () => {
    const fresh = storeWith({
      [documentKey(target)]: { hash: documentHash(target), paraphrase: 'p', questions: ['q'], model: 'm' },
    });
    expect(staleDocuments([target], fresh)).toEqual([]);
    const outdated = storeWith({
      [documentKey(target)]: { hash: 'stale', paraphrase: 'p', questions: ['q'], model: 'm' },
    });
    expect(staleDocuments([target], outdated)).toEqual([target]);
    expect(staleDocuments([target], storeWith({}))).toEqual([target]);
  });

  it('yields expansion text only for entries whose hash is current', () => {
    const current = storeWith({
      [documentKey(target)]: {
        hash: documentHash(target),
        paraphrase: 'How delegates get paid.',
        questions: ['who pays delegates?'],
        model: 'm',
      },
    });
    expect(expansionText(target, current)).toBe('How delegates get paid.\nwho pays delegates?');
    const stale = storeWith({
      [documentKey(target)]: { hash: 'stale', paraphrase: 'x', questions: ['y'], model: 'm' },
    });
    expect(expansionText(target, stale)).toBe('');
    expect(expansionMap([target], current)).toEqual({
      'A.1.6.4': 'How delegates get paid.\nwho pays delegates?',
    });
  });
});

describe('prompt', () => {
  it('includes the document, its location and the parent context', () => {
    const prompt = buildPrompt({ doc: target, parentContent: 'Parent body here.' });
    expect(prompt).toContain('A.1.6.4');
    expect(prompt).toContain('AD Compensation Cycle');
    expect(prompt).toContain('Governance Scope › Aligned Delegates');
    expect(prompt).toContain('Parent body here.');
    expect(prompt).toContain(String(EXPANSION_WORD_LIMIT));
  });

  it('parses a well-formed response, tolerating surrounding prose', () => {
    const parsed = parseExpansionResponse(
      'Here you go:\n{"paraphrase": "How delegates get paid.", "questions": ["who pays delegates?", ""]}\nDone.',
    );
    expect(parsed.paraphrase).toBe('How delegates get paid.');
    expect(parsed.questions).toEqual(['who pays delegates?']);
  });

  it('rejects malformed or empty responses', () => {
    expect(() => parseExpansionResponse('no json at all')).toThrow();
    expect(() => parseExpansionResponse('{"paraphrase": ""}')).toThrow();
    expect(() => parseExpansionResponse('{"paraphrase": "p", "questions": []}')).toThrow();
  });

  it('flags numbers and document numbers absent from the source, and only those', () => {
    const input = { doc: target };
    const clean = { paraphrase: 'Delegates receive compensation from their buffers.', questions: ['who pays?'] };
    expect(findLeaks(clean, input)).toEqual([]);

    const leaking = {
      paraphrase: 'Delegates receive 25,000,000 USDS under A.9.9.9.',
      questions: ['how much is the payout?'],
    };
    const leaks = findLeaks(leaking, input);
    expect(leaks).toContain('25,000,000');
    expect(leaks).toContain('A.9.9.9');
  });

  it('accepts numbers that do appear in the source', () => {
    const doc = flattenAtlasDocuments([createDoc('Scope', 'B.1', 'Budget', 'The cap is 5,000 USDS per month.')])[0];
    expect(findLeaks({ paraphrase: 'A 5,000 monthly cap.', questions: ['what is the cap?'] }, { doc })).toEqual([]);
  });
});
