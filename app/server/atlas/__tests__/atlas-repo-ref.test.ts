import { describe, expect, it } from 'vitest';
import { ATLAS_REPO_BRANCH, atlasRepoRef } from '../constants';

describe('atlasRepoRef', () => {
  it('serves the commit pinned at build time', () => {
    const sha = '3d51f6d19ce55dcc0ad23c27a115cf695359d28d';
    expect(atlasRepoRef(sha)).toBe(sha);
  });

  it('falls back to the live branch when nothing (or nothing valid) is pinned', () => {
    expect(atlasRepoRef(undefined)).toBe(ATLAS_REPO_BRANCH);
    expect(atlasRepoRef('')).toBe(ATLAS_REPO_BRANCH);
    expect(atlasRepoRef('main')).toBe(ATLAS_REPO_BRANCH);
    expect(atlasRepoRef('3d51f6d1')).toBe(ATLAS_REPO_BRANCH);
    expect(atlasRepoRef('../../etc/passwd')).toBe(ATLAS_REPO_BRANCH);
  });
});
