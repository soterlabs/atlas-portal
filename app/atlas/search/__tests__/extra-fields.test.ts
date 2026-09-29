import { describe, expect, it } from 'vitest';
import { findMatchingExtraField } from '../extra-fields';
import { createDoc } from './fixtures';

describe('findMatchingExtraField', () => {
  it('returns the matching field under its human-readable label', () => {
    const doc = createDoc('Type Specification', 'A.2.1', 'Budget Specification', 'body', undefined, {
      type_specification_type_overview: 'Describes how treasury allocation is decided.',
    });
    expect(findMatchingExtraField(doc, ['treasury'])).toEqual({
      label: 'Type Overview',
      value: 'Describes how treasury allocation is decided.',
    });
  });

  it('matches case-insensitively', () => {
    const doc = createDoc('Type Specification', 'A.2.1', 'Spec', 'body', undefined, {
      type_specification_type_overview: 'TREASURY matters',
    });
    expect(findMatchingExtraField(doc, ['treasury'])?.value).toBe('TREASURY matters');
  });

  it('matches accent-insensitively', () => {
    const doc = createDoc('Type Specification', 'A.2.1', 'Spec', 'body', undefined, {
      type_specification_type_overview: 'Liaison with the Société.',
    });
    expect(findMatchingExtraField(doc, ['societe'])?.value).toBe('Liaison with the Société.');
  });

  it('returns null when no extra field matches', () => {
    const doc = createDoc('Type Specification', 'A.2.1', 'Spec', 'body', undefined, {
      type_specification_type_overview: 'unrelated text',
    });
    expect(findMatchingExtraField(doc, ['treasury'])).toBeNull();
  });

  it('returns null for types that have no extra fields', () => {
    const doc = createDoc('Scope', 'A.1', 'Governance Scope', 'treasury allocation');
    expect(findMatchingExtraField(doc, ['treasury'])).toBeNull();
  });

  it('returns the first matching field in mapping order', () => {
    const doc = createDoc('Scenario', 'A.5.1', 'A Scenario', 'body', undefined, {
      scenario_description: 'treasury note',
      scenario_finding: 'treasury finding',
    });
    expect(findMatchingExtraField(doc, ['treasury'])).toEqual({
      label: 'Description',
      value: 'treasury note',
    });
  });
});
