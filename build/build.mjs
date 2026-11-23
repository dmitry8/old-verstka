import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const outfile = path.join(root, 'vendor', 'codemirror.bundle.js');

await build({
  entryPoints: ['src/entry.js'],
  bundle: true,
  format: 'esm',
  target: ['es2020'],
  minify: true,
  outfile,
  logLevel: 'info',
});

console.log('OK ->', outfile);