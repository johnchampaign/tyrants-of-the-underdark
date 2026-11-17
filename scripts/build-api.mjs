// npm run build:api — bundle server/linode.ts (and everything it imports) into
// one self-contained ESM file, dist-api/tyrants-api.mjs, so the Linode needs
// no npm install. Shipped by scripts/deploy-api.sh.
import { build } from 'esbuild';

await build({
  entryPoints: ['server/linode.ts'],
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  outfile: 'dist-api/tyrants-api.mjs',
  // CommonJS dependencies inside an ESM bundle still call require()
  banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
  logLevel: 'warning',
});
