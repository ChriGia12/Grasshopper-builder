import { defineConfig } from 'vitest/config';

// Relative base so the build works on GitHub Pages under /KinePath/.
export default defineConfig({
  base: './',
  worker: { format: 'es' },
  test: { environment: 'node', testTimeout: 120000 },
});
