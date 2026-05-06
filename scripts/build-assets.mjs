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
