/** Server-only loader for the committed SEARCH-19 vector artifacts (SEARCH-20). */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import 'server-only';
import { QUERY_EMBEDDING_MODEL } from '@/app/atlas/search/embedding-model';
import { type VectorManifest, VectorStore } from '@/app/atlas/search/vector-store';

const MANIFEST_PATH = join(process.cwd(), 'public', 'atlas-search-vectors.json');
const BLOB_PATH = join(process.cwd(), 'public', 'atlas-search-vectors.bin');

let storePromise: Promise<VectorStore> | null = null;

async function readStore(): Promise<VectorStore> {
  const [manifestJson, blob] = await Promise.all([readFile(MANIFEST_PATH, 'utf8'), readFile(BLOB_PATH)]);
  const manifest = JSON.parse(manifestJson) as VectorManifest;
  if (manifest.model !== QUERY_EMBEDDING_MODEL.key) {
    throw new Error(`vector model ${manifest.model} does not match ${QUERY_EMBEDDING_MODEL.key}`);
  }
  const bytes = blob.buffer.slice(blob.byteOffset, blob.byteOffset + blob.byteLength) as ArrayBuffer;
  return VectorStore.decode(manifest, bytes);
}

/**
 * One decoded store per server process. A failed read is not cached permanently, so a
 * transient deployment/filesystem problem can recover on the next request.
 */
export function loadSearchVectorStore(): Promise<VectorStore> {
  storePromise ??= readStore().catch((error) => {
    storePromise = null;
    throw error;
  });
  return storePromise;
}
