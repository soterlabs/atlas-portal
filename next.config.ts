import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  poweredByHeader: false,
  reactStrictMode: true,
  typedRoutes: true,
  // The dense route imports transformers.js (and the Atlas page reaches its dynamic
  // import transitively), whose default model cache lives inside its package directory.
  // Never trace that cache into any server bundle: a refresh-then-build deploy would
  // otherwise ship hundreds of MB of model files.
  outputFileTracingExcludes: {
    '*': ['./node_modules/@huggingface/transformers/.cache/**/*'],
  },
  experimental: {
    typedEnv: true,
  },
};

export default nextConfig;
