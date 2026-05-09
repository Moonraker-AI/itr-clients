#!/usr/bin/env node
import { mkdir, copyFile, readdir } from 'node:fs/promises';
import { dirname, extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// Fonts ----------------------------------------------------------------
const outFonts = resolve(root, 'dist/static/fonts');
await mkdir(outFonts, { recursive: true });

const fonts = [
  ['@fontsource-variable/outfit/files/outfit-latin-wght-normal.woff2', 'outfit-latin-wght-normal.woff2'],
  ['@fontsource/fira-code/files/fira-code-latin-400-normal.woff2', 'fira-code-latin-400-normal.woff2'],
  ['@fontsource/fira-code/files/fira-code-latin-500-normal.woff2', 'fira-code-latin-500-normal.woff2'],
];

for (const [pkgPath, outName] of fonts) {
  const src = resolve(root, 'node_modules', pkgPath);
  const dst = resolve(outFonts, outName);
  await copyFile(src, dst);
  console.log(`font: ${outName}`);
}

// Brand --------------------------------------------------------------
const brandSrc = resolve(root, 'src/assets/brand');
const brandDst = resolve(root, 'dist/static/brand');
await mkdir(brandDst, { recursive: true });

const ASSET_EXTS = new Set(['.svg', '.png', '.ico', '.webp', '.jpg', '.jpeg', '.gif']);

let brandEntries = [];
try {
  brandEntries = await readdir(brandSrc, { withFileTypes: true });
} catch {
  // Folder absent — nothing to copy.
}

for (const entry of brandEntries) {
  if (!entry.isFile()) continue;
  if (!ASSET_EXTS.has(extname(entry.name).toLowerCase())) continue;
  await copyFile(resolve(brandSrc, entry.name), resolve(brandDst, entry.name));
  console.log(`brand: ${entry.name}`);
}

// JS --------------------------------------------------------------
// Inline scripts moved to external files for CSP — drop 'unsafe-inline'.
const jsSrc = resolve(root, 'src/assets/js');
const jsDst = resolve(root, 'dist/static/js');
await mkdir(jsDst, { recursive: true });

let jsEntries = [];
try {
  jsEntries = await readdir(jsSrc, { withFileTypes: true });
} catch {
  // Folder absent — nothing to copy.
}

for (const entry of jsEntries) {
  if (!entry.isFile()) continue;
  if (extname(entry.name).toLowerCase() !== '.js') continue;
  await copyFile(resolve(jsSrc, entry.name), resolve(jsDst, entry.name));
  console.log(`js: ${entry.name}`);
}

// JS Bundles -----------------------------------------------------------
// Anything in src/assets/js-bundles/ is an entry that gets esbuild-
// bundled into a single minified file at dist/static/js/<name>.js.
// CSP stays 'self' because the output is same-origin. v0.28.0 entries
// have no npm imports; esbuild still runs to keep output naming +
// minification consistent and to leave room for future imports.
const jsBundleSrc = resolve(root, 'src/assets/js-bundles');
let bundleEntries = [];
try {
  bundleEntries = await readdir(jsBundleSrc, { withFileTypes: true });
} catch {
  // Folder absent — nothing to bundle.
}

const bundleInputs = bundleEntries
  .filter((e) => e.isFile() && extname(e.name).toLowerCase() === '.js')
  .map((e) => e.name);

if (bundleInputs.length > 0) {
  // Lazy-load esbuild so projects without it (none today) don't fail.
  const esbuild = await import('esbuild');
  for (const name of bundleInputs) {
    const entryPath = resolve(jsBundleSrc, name);
    // Strip "-entry.js" suffix if present so foo-entry.js → foo.js.
    const outName = name.replace(/-entry\.js$/, '.js');
    const outPath = resolve(jsDst, outName);
    await esbuild.build({
      entryPoints: [entryPath],
      bundle: true,
      minify: true,
      format: 'iife',
      target: ['es2020'],
      outfile: outPath,
      logLevel: 'silent',
      sourcemap: false,
    });
    console.log(`bundle: ${outName}`);
  }
}
