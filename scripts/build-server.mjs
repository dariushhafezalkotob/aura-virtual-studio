// Bundles server/prod.ts into dist-server/prod.mjs.
// node_modules stay external, so deploying means shipping dist/, dist-server/, package.json and
// running `npm ci --omit=dev` on the server.
import { build } from 'esbuild';

await build({
  entryPoints: ['server/prod.ts'],
  outfile: 'dist-server/prod.mjs',
  platform: 'node',
  target: 'node20',
  format: 'esm',
  bundle: true,
  packages: 'external',
  sourcemap: true,
  logLevel: 'info',
});
