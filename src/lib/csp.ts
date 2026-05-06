/**
 * CSP-related constants.
 *
 * The pre-paint theme script must run synchronously in <head> before <body>
 * parses to avoid FOUC. That means it can't be moved to an external file
 * without introducing a flash. We pin it via a SHA-256 hash in the CSP
 * header instead, allowing this exact byte sequence (and nothing else
 * inline) to execute.
 *
 * If you change PREPAINT_THEME, the SHA recomputes automatically at module
 * load — server.ts re-reads it on cold start.
 */

import { createHash } from 'node:crypto';

export const PREPAINT_THEME = `
(function(){
  try {
    var m = document.cookie.match(/(?:^|; )theme=(light|dark)/);
    var t = m ? m[1] : (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
    if (t === 'dark') document.documentElement.classList.add('dark');
  } catch (e) {}
})();
`.trim();

export const PREPAINT_THEME_SHA = `'sha256-${createHash('sha256')
  .update(PREPAINT_THEME)
  .digest('base64')}'`;
