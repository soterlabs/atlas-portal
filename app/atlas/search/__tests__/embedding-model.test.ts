import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ORT_WASM_PUBLIC_PATH,
  QUERY_EMBEDDING_MODEL,
  configureFirstPartyAssets,
  embedQueryLocal,
} from '../embedding-model';

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

describe('configureFirstPartyAssets', () => {
  const jsdelivr = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.26.0/dist/';

  it('in the browser, disables the Hub and moves the ONNX Runtime files to /ort/, keeping the chosen variant', () => {
    const env = {
      allowRemoteModels: true,
      allowLocalModels: false,
      localModelPath: '',
      backends: {
        onnx: {
          wasm: {
            wasmPaths: {
              mjs: `${jsdelivr}ort-wasm-simd-threaded.asyncify.mjs`,
              wasm: `${jsdelivr}ort-wasm-simd-threaded.asyncify.wasm`,
            } as string | Record<string, string>,
          },
        },
      },
    };
    configureFirstPartyAssets(env);
    expect(env.allowRemoteModels).toBe(false);
    expect(env.allowLocalModels).toBe(true);
    expect(env.localModelPath).toBe('/models/');
    expect(env.backends?.onnx.wasm.wasmPaths).toEqual({
      mjs: `${ORT_WASM_PUBLIC_PATH}ort-wasm-simd-threaded.asyncify.mjs`,
      wasm: `${ORT_WASM_PUBLIC_PATH}ort-wasm-simd-threaded.asyncify.wasm`,
    });
  });

  it('on the server, reads the vendored model from the deployment and never the Hub', () => {
    vi.stubGlobal('window', undefined);
    try {
      const env = { allowRemoteModels: true, allowLocalModels: false, localModelPath: '', backends: {} };
      configureFirstPartyAssets(env);
      expect(env.allowRemoteModels).toBe(false);
      expect(env.localModelPath).toBe(`${process.cwd()}/public/models/`);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
