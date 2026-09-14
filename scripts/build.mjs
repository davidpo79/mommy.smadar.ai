import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const outDir = path.join(root, 'public');
const watch = process.argv.includes('--watch');

async function build() {
  await fs.rm(outDir, { recursive: true, force: true });
  await fs.mkdir(outDir, { recursive: true });

  const result = await esbuild.build({
    entryPoints: [path.join(root, 'client', 'src', 'main.jsx')],
    bundle: true,
    minify: !watch,
    sourcemap: watch ? 'inline' : false,
    format: 'iife',
    target: ['es2020'],
    jsx: 'automatic',
    define: { 'process.env.NODE_ENV': JSON.stringify(watch ? 'development' : 'production') },
    write: false,
    logLevel: 'info',
  });

  const bundle = result.outputFiles[0];
  const hash = createHash('sha256').update(bundle.contents).digest('hex').slice(0, 10);
  const fileName = `app.${hash}.js`;
  await fs.writeFile(path.join(outDir, fileName), bundle.contents);

  const html = await fs.readFile(path.join(root, 'client', 'index.html'), 'utf8');
  await fs.writeFile(path.join(outDir, 'index.html'), html.replace('__BUNDLE__', fileName));

  console.log(`[build] public/${fileName} (${(bundle.contents.length / 1024).toFixed(1)} kB)`);
}

await build();

if (watch) {
  const { watch: fsWatch } = await import('node:fs');
  let timer = null;
  for (const dir of ['client']) {
    fsWatch(path.join(root, dir), { recursive: true }, () => {
      clearTimeout(timer);
      timer = setTimeout(() => build().catch((err) => console.error(err.message)), 120);
    });
  }
  console.log('[build] watching client/ for changes');
}
