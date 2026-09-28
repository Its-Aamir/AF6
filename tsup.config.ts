import { defineConfig } from 'tsup';

export default defineConfig({
  entry: { 'server/main': 'src/server/main.ts', 'worker/main': 'src/worker/main.ts', 'server/migrate': 'src/server/db/migrate.ts' },
  format: ['esm'],
  platform: 'node',
  target: 'node22',
  outDir: 'dist',
  sourcemap: true,
  clean: false,
  splitting: false,
  skipNodeModulesBundle: true,
});
