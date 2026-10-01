import { configDefaults, defineConfig } from 'vitest/config';

// Relative base so the build works on GitHub Pages under /KinePath/.
export default defineConfig({
  base: './',
  worker: { format: 'es' },
  // archivio/: local copies of older versions, not part of the project.
  test: { environment: 'node', testTimeout: 120000, exclude: [...configDefaults.exclude, 'archivio/**'] },
});
