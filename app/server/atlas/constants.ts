/**
 * Atlas constants used by the portal and export pipeline.
 */
import type { AtlasDocumentType } from './atlas-types';

// Re-export types for backward compatibility
export type { AtlasDatabaseName, AtlasDatabaseID, AtlasDocumentType, MasterStatus } from './atlas-types';

export const ATLAS_DOCUMENT_TYPES: AtlasDocumentType[] = [
  'Section',
  'Core',
  'Type Specification',
  'Active Data Controller',
  'Action Tenet',
  'Active Data',
  'Annotation',
  'Scope',
  'Article',
  'Scenario',
  'Scenario Variation',
  'Needed Research',
] as const;

/**
 * Hard-coded document name used to identify Agent Scope Database context during markdown import.
 *
 * PURPOSE: The markdown importer (`atlas-markdown-importer.ts`) uses this constant in
 * `mapTypeToDatabase()` to detect whether a Core or Active Data Controller document
 * belongs to Agent Scope Database or Sections & Primary Docs.
 *
 * DETECTION LOGIC: A Core/ADC document belongs to Agent Scope Database if:
 * 1. Its immediate parent's name matches AGENT_ROOT_DOCUMENT_NAME, OR
 * 2. Any ancestor in the chain is from Agent Scope Database
 * Otherwise, it belongs to Sections & Primary Docs.
 */
export const AGENT_ROOT_DOCUMENT_NAME = 'List Of Prime Agent Artifacts';

/**
 * Owner of the canonical Atlas repository on GitHub.
 * Repository: https://github.com/sky-ecosystem/next-gen-atlas
 */
export const ATLAS_REPO_OWNER = 'sky-ecosystem';
export const ATLAS_REPO_NAME = 'next-gen-atlas';
export const ATLAS_REPO_BRANCH = 'main';

/**
 * The Atlas commit this deployment serves, pinned at build time by
 * `scripts/pin-atlas-snapshot.mjs` (inlined through `next.config.ts`). The page, the
 * `/api/atlas.*` exports and the search artifacts are all built from this one commit,
 * so the served text and the search index can never disagree. Unset (local dev,
 * tests) → the live branch head.
 */
export function atlasRepoRef(pinned: string | undefined = process.env.ATLAS_PINNED_SHA): string {
  return pinned && /^[0-9a-f]{40}$/.test(pinned) ? pinned : ATLAS_REPO_BRANCH;
}
export const ATLAS_REPO_REF = atlasRepoRef();

/**
 * GitHub API URL for downloading the repo as a tarball at the given branch.
 *
 * The portal extracts this tarball, walks its `content/` directory, and composes
 * the decomposed Atlas tree back into a monolithic markdown stream — replacing
 * the older direct-fetch of `Sky Atlas/Sky Atlas.md`.
 */
export const ATLAS_REPO_TARBALL_URL = `https://api.github.com/repos/${ATLAS_REPO_OWNER}/${ATLAS_REPO_NAME}/tarball/${ATLAS_REPO_REF}`;

/**
 * GitHub API URL for the latest commit on the canonical branch.
 *
 * Used to derive a SHA for cache invalidation: when the SHA changes, the
 * tarball is re-fetched and the composed monolith is recomputed.
 */
export const ATLAS_REPO_COMMITS_URL = `https://api.github.com/repos/${ATLAS_REPO_OWNER}/${ATLAS_REPO_NAME}/commits/${ATLAS_REPO_REF}`;
