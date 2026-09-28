import { beforeEach, describe, expect, it, vi } from 'vitest';
import { QUERY_EMBEDDING_MODEL, embedQueryLocal } from '../embedding-model';

const model = vi.hoisted(() => ({
  data: new Float32Array(384),
  dispose: vi.fn(),
  extract: vi.fn(),
}));

vi.mock('@huggingface/transformers', () => ({
  env: {},
  pipeline: vi.fn(async () => model.extract),
}));

beforeEach(() => {
  model.data = new Float32Array(QUERY_EMBEDDING_MODEL.dims).fill(1 / Math.sqrt(QUERY_EMBEDDING_MODEL.dims));
  model.dispose.mockClear();
  model.extract.mockReset().mockImplementation(async () => ({ data: model.data, dispose: model.dispose }));
});

describe('embedQueryLocal', () => {
  it('returns a finite normalised vector and releases model output', async () => {
    await expect(embedQueryLocal('governance')).resolves.toHaveLength(QUERY_EMBEDDING_MODEL.dims);
    expect(model.dispose).toHaveBeenCalledOnce();
  });

  it('rejects corrupt model output and still releases it', async () => {
    model.data = new Float32Array(QUERY_EMBEDDING_MODEL.dims);
    await expect(embedQueryLocal('governance')).rejects.toThrow(/non-normalised/);
    expect(model.dispose).toHaveBeenCalledOnce();

    model.data.fill(1 / Math.sqrt(QUERY_EMBEDDING_MODEL.dims));
    model.data[7] = Number.NaN;
    await expect(embedQueryLocal('governance')).rejects.toThrow(/non-finite/);
    expect(model.dispose).toHaveBeenCalledTimes(2);
  });

  it('does not start inference when the caller aborted during model loading', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(embedQueryLocal('stale query', controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(model.extract).not.toHaveBeenCalled();
  });
});
