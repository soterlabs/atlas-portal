import { describe, expect, it } from 'vitest';
import { loadSpecFile } from '../embedding-eval/models';

const VALID = {
  key: 'tuned-arm-07',
  repo: '/abs/path/to/artifact',
  dims: 384,
  pooling: 'cls',
  queryPrefix: 'Represent this sentence for searching relevant passages: ',
  passagePrefix: '',
};

describe('loadSpecFile', () => {
  it('accepts a valid spec, forces kind local, and ignores unknown extra fields', () => {
    const spec = loadSpecFile(JSON.stringify({ ...VALID, trainingRun: 'arm-07', epochs: 3 }));
    expect(spec).toEqual({ ...VALID, kind: 'local' });
  });

  it('accepts an optional dtype and validates it', () => {
    expect(loadSpecFile(JSON.stringify({ ...VALID, dtype: 'fp32' }))).toMatchObject({ dtype: 'fp32' });
    expect(() => loadSpecFile(JSON.stringify({ ...VALID, dtype: 'int4' }))).toThrow(/dtype.*q8, fp32, fp16/);
  });

  it('refuses pooling outside the known values', () => {
    expect(() => loadSpecFile(JSON.stringify({ ...VALID, pooling: 'max' }))).toThrow(
      /pooling must be one of: cls, mean/,
    );
  });

  it('refuses a key that collides with a registry model (cache poisoning guard)', () => {
    expect(() => loadSpecFile(JSON.stringify({ ...VALID, key: 'bge-small' }))).toThrow(
      /collides with a registry model/,
    );
  });

  it('refuses missing or malformed required fields', () => {
    expect(() => loadSpecFile('not json')).toThrow(/not valid JSON/);
    expect(() => loadSpecFile('[]')).toThrow(/JSON object/);
    expect(() => loadSpecFile(JSON.stringify({ ...VALID, key: '  ' }))).toThrow(
      /key \(or name\) must be a non-empty string/,
    );
    expect(() => loadSpecFile(JSON.stringify({ ...VALID, dims: 384.5 }))).toThrow(/dims must be a positive integer/);
    expect(() => loadSpecFile(JSON.stringify({ ...VALID, queryPrefix: undefined }))).toThrow(
      /queryPrefix must be a string/,
    );
  });
});
