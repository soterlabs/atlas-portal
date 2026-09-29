/**
 * transformers.js caches downloaded models inside its own package directory by
 * default (node_modules/@huggingface/transformers/.cache). Next.js output tracing
 * sweeps that directory into every server function that imports the package, so a
 * refresh-then-build deploy would ship hundreds of megabytes of model files. Every
 * script-side model load goes through here and caches under a repo-local
 * `.cache/transformers` (gitignored) or `TRANSFORMERS_CACHE_DIR`.
 */
import path from 'node:path';

export function resolveTransformersCacheDir(env: Record<string, string | undefined>, cwd: string): string {
  const configured = env.TRANSFORMERS_CACHE_DIR;
  return configured ? path.resolve(cwd, configured) : path.join(cwd, '.cache', 'transformers');
}

export async function loadTransformers(): Promise<typeof import('@huggingface/transformers')> {
  const transformers = await import('@huggingface/transformers');
  transformers.env.cacheDir = resolveTransformersCacheDir(process.env, process.cwd());
  // Models vendored for the portal (public/models/, pinned + hashed) load from disk, so
  // artifact builds never fetch them; other evaluation models still come from the Hub.
  transformers.env.allowLocalModels = true;
  transformers.env.localModelPath = `${path.join(process.cwd(), 'public', 'models')}/`;
  return transformers;
}
