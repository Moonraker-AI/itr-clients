import type { Context } from 'hono';
import { getCookie } from 'hono/cookie';

export type Theme = 'light' | 'dark';

/** Read the user's chosen theme from the `theme` cookie. Returns null if unset
 * (caller should fall back to system pref via prefers-color-scheme). */
export function getTheme(c: Context): Theme | null {
  const v = getCookie(c, 'theme');
  return v === 'light' || v === 'dark' ? v : null;
}
