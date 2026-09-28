import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveTransformersCacheDir } from '../embedding-eval/transformers-env';

describe('resolveTransformersCacheDir', () => {
  it('defaults to a repo-local .cache directory outside node_modules', () => {
    const dir = resolveTransformersCacheDir({}, '/repo');
    expect(dir).toBe(path.join('/repo', '.cache', 'transformers'));
    expect(dir).not.toContain('node_modules');
  });

  it('honours TRANSFORMERS_CACHE_DIR, resolved against cwd', () => {
    expect(resolveTransformersCacheDir({ TRANSFORMERS_CACHE_DIR: '/tmp/models' }, '/repo')).toBe('/tmp/models');
    expect(resolveTransformersCacheDir({ TRANSFORMERS_CACHE_DIR: 'models' }, '/repo')).toBe('/repo/models');
  });
});
