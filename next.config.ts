import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  poweredByHeader: false,
  reactStrictMode: true,
  typedRoutes: true,
  // The dense route imports transformers.js (and the Atlas page reaches its dynamic
  // import transitively), whose default model cache lives inside its package directory.
  // Never trace that cache into any server bundle: a refresh-then-build deploy would
  // otherwise ship hundreds of MB of model files.
  // Vercel functions run on linux/x64: the win32/darwin ONNX Runtime binaries are dead
  // weight against the function size limit.
  // `public/ort/` (browser-only WASM) is never needed server-side, and only the dense
  // route needs the vendored model; filesystem reads in the Atlas loader make the
  // tracer sweep `public/` into other functions otherwise.
  outputFileTracingExcludes: {
    '*': [
      './node_modules/@huggingface/transformers/.cache/**/*',
      './node_modules/onnxruntime-node/bin/napi-v6/win32/**/*',
      './node_modules/onnxruntime-node/bin/napi-v6/darwin/**/*',
      './public/ort/**/*',
    ],
    '/': ['./public/models/**/*'],
    '/atlas': ['./public/models/**/*'],
    '/proposal': ['./public/models/**/*'],
    '/api/search/answer': ['./public/models/**/*'],
    '/api/search/rewrite': ['./public/models/**/*'],
  },
  // The dense route embeds queries with the vendored model (see
  // app/atlas/search/embedding-model.ts); `public/` is not in function bundles by default.
  // onnxruntime-node loads its native addon by a runtime-built path
  // (bin/napi-v6/<platform>/<arch>/), and the addon dlopens libonnxruntime.so.1, so
  // the tracer finds neither; ship the linux/x64 runtime Vercel functions execute on.
  outputFileTracingIncludes: {
    '/api/search/dense': ['./public/models/**/*', './node_modules/onnxruntime-node/bin/napi-v6/linux/x64/**/*'],
  },
  experimental: {
    typedEnv: true,
  },
};

export default nextConfig;
