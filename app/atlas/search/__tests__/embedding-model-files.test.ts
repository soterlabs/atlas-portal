// @vitest-environment node
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { QUERY_EMBEDDING_MODEL } from '../embedding-model';

const MODELS_DIR = join(process.cwd(), 'public', 'models');

function manifest(): Array<{ sha256: string; file: string }> {
  return readFileSync(join(MODELS_DIR, 'MODELS.sha256'), 'utf8')
    .trim()
    .split('\n')
    .map((line) => {
      const [sha256, file] = line.split(/\s+/);
      return { sha256, file };
    });
}

describe('vendored query-embedding model', () => {
  it('ships every file transformers.js loads for the q8 feature-extraction pipeline', () => {
    const files = manifest().map((entry) => entry.file);
    for (const file of ['config.json', 'tokenizer.json', 'tokenizer_config.json', 'onnx/model_quantized.onnx']) {
      expect(files).toContain(`${QUERY_EMBEDDING_MODEL.repo}/${file}`);
    }
  });

  it('matches MODELS.sha256 byte for byte', () => {
    for (const { sha256, file } of manifest()) {
      const path = join(MODELS_DIR, file);
      expect(existsSync(path), file).toBe(true);
      expect(createHash('sha256').update(readFileSync(path)).digest('hex'), file).toBe(sha256);
    }
  });
});
