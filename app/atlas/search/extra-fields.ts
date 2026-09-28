import type { ExportAtlasTreeDocument } from '@/app/server/atlas/export/types';
import { extraFieldsByDocumentType } from '@/app/server/atlas/export/types';
import {
  NEEDED_RESEARCH_PROPERTY_MAPPING,
  SCENARIO_PROPERTY_MAPPING,
  SCENARIO_VARIATION_PROPERTY_MAPPING,
  TYPE_SPECIFICATION_PROPERTY_MAPPING,
} from '@/app/server/atlas/notion-mapping/notion-database-properties-and-relationships';
import { foldText } from './fold';

export interface MatchedExtraField {
  /** Human-readable field name, e.g. "Description". */
  label: string;
  value: string;
}

/** Maps a document type to its Notion property mapping, for field-key → label lookup. */
export function getPropertyMappingForDocumentType(docType: string): Record<string, string> | null {
  switch (docType) {
    case 'Type Specification':
      return TYPE_SPECIFICATION_PROPERTY_MAPPING as unknown as Record<string, string>;
    case 'Scenario':
      return SCENARIO_PROPERTY_MAPPING as unknown as Record<string, string>;
    case 'Scenario Variation':
      return SCENARIO_VARIATION_PROPERTY_MAPPING as unknown as Record<string, string>;
    case 'Needed Research':
      return NEEDED_RESEARCH_PROPERTY_MAPPING as unknown as Record<string, string>;
    default:
      return null;
  }
}

/**
 * Finds the first extra field containing any of the matched terms, so the result row can
 * preview it under its label instead of showing unrelated content (spec §6).
 */
export function findMatchingExtraField(doc: ExportAtlasTreeDocument, terms: string[]): MatchedExtraField | null {
  const fieldKeys = extraFieldsByDocumentType[doc.type];
  if (!fieldKeys || fieldKeys.length === 0 || terms.length === 0) return null;

  const record = doc as unknown as Record<string, unknown>;
  const propertyMapping = getPropertyMappingForDocumentType(doc.type);
  const foldedTerms = terms.map(foldText);

  for (const fieldKey of fieldKeys) {
    const value = record[fieldKey];
    if (typeof value !== 'string' || value.length === 0) continue;

    const foldedValue = foldText(value);
    if (foldedTerms.some((term) => foldedValue.includes(term))) {
      return { label: propertyMapping?.[fieldKey] ?? fieldKey, value };
    }
  }

  return null;
}
