/**
 * Versioned consent template loader (DESIGN.md §7).
 *
 * Templates live in `src/consents/<name>-v<version>.md` as plain markdown
 * with YAML frontmatter. Once a template version is published into the DB
 * (`consent_templates` row with `published_at` set) it is immutable —
 * editing the file in-place would break in-flight retreats. Always bump
 * the version filename + add a new row.
 *
 * The frontmatter declares:
 *   - name, version: identity (must match filename)
 *   - title: human-readable for PDF + admin
 *   - requires_signature: boolean
 *   - required_fields: array of intake-question descriptors driving the
 *     public sign form + PDF stamp page
 *   - effective_date (optional, NPP only)
 *
 * Body uses Mustache-lite substitution:
 *   {{var}}                  → vars.var
 *   {{#if var}}…{{/if}}      → block included only when truthy
 *
 * No nesting, no escaping, no `else`. The intentionally tiny grammar means
 * a template typo can't pull in arbitrary code paths.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import yaml from 'js-yaml';

const here = path.dirname(fileURLToPath(import.meta.url));
// In dev (tsx) this resolves to <repo>/src/lib/. In built image it resolves
// to /app/dist/lib/. Templates ship as plain markdown next to the compiled
// JS via a Dockerfile copy step.
const CONSENT_DIR = path.resolve(here, '..', 'consents');

export type FieldKind =
  | 'text'
  | 'longtext'
  | 'choice_multi'
  | 'yesno'
  | 'checkbox'
  | 'date'
  | 'signature';

export interface RequiredField {
  key: string;
  label: string;
  kind: FieldKind;
  required?: boolean;
  options?: string[];
}

export interface TemplateMeta {
  name: string;
  version: number;
  title: string;
  requiresSignature: boolean;
  effectiveDate?: string;
  requiredFields: RequiredField[];
}

export interface LoadedTemplate {
  meta: TemplateMeta;
  /** Raw markdown body (post-frontmatter, pre-substitution). */
  body: string;
  /** Filesystem path — useful for error messages. */
  sourcePath: string;
}

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/;

function parseTemplateFile(filePath: string): LoadedTemplate {
  const raw = readFileSync(filePath, 'utf8');
  const m = raw.match(FRONTMATTER_RE);
  if (!m) throw new Error(`consent template missing frontmatter: ${filePath}`);
  const fm = yaml.load(m[1]!) as Record<string, unknown>;

  const name = String(fm['name'] ?? '');
  const version = Number(fm['version']);
  const title = String(fm['title'] ?? '');
  const requiresSignature = Boolean(fm['requires_signature']);
  const requiredFields = (fm['required_fields'] ?? []) as RequiredField[];
  const effectiveDate = fm['effective_date']
    ? String(fm['effective_date'])
    : undefined;

  if (!name || !Number.isFinite(version) || !title) {
    throw new Error(`consent template frontmatter incomplete: ${filePath}`);
  }
  return {
    meta: {
      name,
      version,
      title,
      requiresSignature,
      requiredFields,
      ...(effectiveDate ? { effectiveDate } : {}),
    },
    body: m[2]!,
    sourcePath: filePath,
  };
}

let cache: Map<string, LoadedTemplate> | null = null;

/**
 * Loads every `.md` file in the consents directory into a name-keyed map.
 * Each `name` keeps its highest-version file. Cached for the lifetime of
 * the process.
 */
export function loadTemplates(): Map<string, LoadedTemplate> {
  if (cache) return cache;
  const files = readdirSync(CONSENT_DIR).filter((f) => f.endsWith('.md'));
  const byName = new Map<string, LoadedTemplate>();
  for (const f of files) {
    const t = parseTemplateFile(path.join(CONSENT_DIR, f));
    const existing = byName.get(t.meta.name);
    if (!existing || existing.meta.version < t.meta.version) {
      byName.set(t.meta.name, t);
    }
  }
  cache = byName;
  return cache;
}

export function getTemplate(name: string): LoadedTemplate {
  const t = loadTemplates().get(name);
  if (!t) throw new Error(`consent template not found: ${name}`);
  return t;
}

/**
 * Mustache-lite substitution. Resolves `{{key}}` to vars[key] and
 * `{{#if key}}…{{/if}}` to its inner block when vars[key] is truthy.
 *
 * Block tags must NOT nest. Variable names match `[A-Za-z_][A-Za-z0-9_]*`.
 * Unknown variables resolve to empty string (logged once per render so a
 * missing var does not silently corrupt a legal document).
 */
export function substitute(
  body: string,
  vars: Record<string, string | number | boolean | null | undefined>,
): string {
  const missing = new Set<string>();

  let out = body.replace(
    /\{\{#if ([A-Za-z_][A-Za-z0-9_]*)\}\}([\s\S]*?)\{\{\/if\}\}/g,
    (_, key: string, inner: string) => {
      const v = vars[key];
      const truthy = v !== null && v !== undefined && v !== '' && v !== false;
      return truthy ? inner : '';
    },
  );

  out = out.replace(
    /\{\{([A-Za-z_][A-Za-z0-9_]*)\}\}/g,
    (_, key: string) => {
      const v = vars[key];
      if (v === null || v === undefined) {
        missing.add(key);
        return '';
      }
      return String(v);
    },
  );

  if (missing.size > 0) {
    // Best-effort breadcrumb. Caller decides whether to fail-hard.
    process.stderr.write(
      `${JSON.stringify({
        severity: 'WARNING',
        message: 'consent_template_missing_vars',
        missing: [...missing],
      })}\n`,
    );
  }
  return out;
}

export interface RenderTemplateInput {
  templateName: string;
  vars: Record<string, string | number | boolean | null | undefined>;
}

export interface RenderedTemplate {
  meta: TemplateMeta;
  body: string;
}

export function renderTemplate(input: RenderTemplateInput): RenderedTemplate {
  const t = getTemplate(input.templateName);
  return { meta: t.meta, body: substitute(t.body, input.vars) };
}

/**
 * Idempotent: ensure every (name, version) loaded from disk exists in
 * `consent_templates`. Existing rows are NEVER modified — DESIGN.md §7
 * requires published versions to be immutable. New rows are inserted with
 * `published_at = now()`.
 *
 * Returns a map keyed by template name → DB row id of the LATEST version
 * known on disk (which is also the latest in DB after this call).
 */
export async function syncConsentTemplatesToDb(): Promise<
  Map<string, { id: string; version: number; requiresSignature: boolean }>
> {
  // Late import — keep this module DB-free for the smoke harness.
  const { getDb } = await import('../db/client.js');
  const { consentTemplates } = await import('../db/schema.js');
  const { and, eq } = await import('drizzle-orm');

  const { db } = await getDb();
  const out = new Map<
    string,
    { id: string; version: number; requiresSignature: boolean }
  >();

  for (const t of loadTemplates().values()) {
    const existing = await db
      .select({
        id: consentTemplates.id,
        version: consentTemplates.version,
        requiresSignature: consentTemplates.requiresSignature,
      })
      .from(consentTemplates)
      .where(
        and(
          eq(consentTemplates.name, t.meta.name),
          eq(consentTemplates.version, t.meta.version),
        ),
      );

    let row = existing[0];
    if (!row) {
      const inserted = await db
        .insert(consentTemplates)
        .values({
          name: t.meta.name,
          version: t.meta.version,
          bodyMarkdown: t.body,
          requiredFields: t.meta.requiredFields,
          requiresSignature: t.meta.requiresSignature,
          publishedAt: new Date(),
          active: true,
        })
        .returning({
          id: consentTemplates.id,
          version: consentTemplates.version,
          requiresSignature: consentTemplates.requiresSignature,
        });
      row = inserted[0]!;
    }
    out.set(t.meta.name, row);
  }
  return out;
}
