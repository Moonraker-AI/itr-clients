#!/usr/bin/env node
import { mkdir, copyFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
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
  console.log(`copied ${outName}`);
}
