/**
 * Consent PDF renderer (DESIGN.md §11 — `pdf.ts`).
 *
 * Pipeline:
 *   1. `renderTemplate()` resolves a versioned consent body with vars
 *      already substituted.
 *   2. `marked.lexer()` parses the markdown into a flat token stream.
 *   3. `tokensToReactPdf()` walks the stream and produces React-PDF nodes
 *      for the supported subset (h1–h3, paragraph, ul/ol, hr, strong/em).
 *   4. `pdf(<Document/>).toBuffer()` produces the final PDF bytes.
 *
 * The signature image (data URL captured client-side) and the intake
 * answers are stamped onto a final page so the rendered PDF is a
 * self-contained record. The signature image is ALSO stored separately
 * in GCS via `lib/storage.ts` for evidence purposes — DESIGN §7 calls
 * for signed-PDF + raw-evidence redundancy.
 *
 * Markdown subset is intentionally narrow. Anything richer (tables,
 * fenced code, images-from-URL, raw HTML) is ignored. Adding support
 * later is fine; silently rendering arbitrary markdown into a legal
 * document is not.
 */

import * as React from 'react';
import { Document, Page, Text, View, StyleSheet, Image, pdf } from '@react-pdf/renderer';
import type { Token } from 'marked';
import { marked } from 'marked';

import {
  type RequiredField,
  type TemplateMeta,
  renderTemplate,
} from './consent-templates.js';

const styles = StyleSheet.create({
  page: { padding: 48, fontSize: 11, fontFamily: 'Helvetica', lineHeight: 1.4 },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-end',
    marginBottom: 18,
    paddingBottom: 6,
    borderBottomWidth: 1,
    borderBottomColor: '#dcdcdc',
  },
  brand: { fontSize: 14, fontWeight: 'bold' },
  metaText: { fontSize: 8, color: '#555' },
  h1: { fontSize: 18, fontWeight: 'bold', marginBottom: 12 },
  h2: { fontSize: 14, fontWeight: 'bold', marginTop: 12, marginBottom: 6 },
  h3: { fontSize: 12, fontWeight: 'bold', marginTop: 8, marginBottom: 4 },
  paragraph: { marginBottom: 6 },
  listItem: { flexDirection: 'row', marginLeft: 12, marginBottom: 2 },
  listBullet: { width: 12 },
  listText: { flex: 1 },
  hr: { borderBottomWidth: 1, borderBottomColor: '#cccccc', marginVertical: 8 },
  strong: { fontWeight: 'bold' },
  em: { fontStyle: 'italic' },
  signaturePage: { paddingTop: 32 },
  signatureLabel: { fontSize: 9, color: '#555', marginBottom: 4 },
  signatureImage: { width: 240, height: 80, marginBottom: 4, objectFit: 'contain' },
  signatureLine: { borderBottomWidth: 1, borderBottomColor: '#000', width: 320, marginBottom: 4 },
  intakeRow: { flexDirection: 'row', marginBottom: 4 },
  intakeLabel: { width: '40%', fontSize: 9, color: '#555' },
  intakeValue: { width: '60%', fontSize: 10 },
});

const e = React.createElement;

/**
 * Inline rendering: marked exposes a `tokens` array on the parent token
 * for inline content. We map only `text`, `strong`, `em`, and `br`.
 */
function inlineToReact(tokens: Token[] | undefined): React.ReactNode[] {
  if (!tokens) return [];
  const out: React.ReactNode[] = [];
  tokens.forEach((tok, i) => {
    switch (tok.type) {
      case 'text':
        out.push(e(React.Fragment, { key: i }, (tok as { text: string }).text));
        break;
      case 'strong':
        out.push(
          e(
            Text,
            { key: i, style: styles.strong },
            ...inlineToReact((tok as { tokens?: Token[] }).tokens),
          ),
        );
        break;
      case 'em':
        out.push(
          e(
            Text,
            { key: i, style: styles.em },
            ...inlineToReact((tok as { tokens?: Token[] }).tokens),
          ),
        );
        break;
      case 'br':
        out.push(e(Text, { key: i }, '\n'));
        break;
      case 'codespan':
        out.push(
          e(Text, { key: i }, (tok as { text: string }).text),
        );
        break;
      default:
        // Conservative fallback for unsupported inlines: render their raw text.
        if ('raw' in tok && typeof (tok as { raw: unknown }).raw === 'string') {
          out.push(e(React.Fragment, { key: i }, (tok as { raw: string }).raw));
        }
        break;
    }
  });
  return out;
}

function tokensToReactPdf(tokens: Token[]): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  tokens.forEach((tok, i) => {
    switch (tok.type) {
      case 'heading': {
        const t = tok as { depth: number; tokens?: Token[] };
        const style =
          t.depth <= 1 ? styles.h1 : t.depth === 2 ? styles.h2 : styles.h3;
        out.push(e(Text, { key: i, style }, ...inlineToReact(t.tokens)));
        break;
      }
      case 'paragraph': {
        const t = tok as { tokens?: Token[] };
        out.push(
          e(Text, { key: i, style: styles.paragraph }, ...inlineToReact(t.tokens)),
        );
        break;
      }
      case 'list': {
        const t = tok as {
          ordered: boolean;
          items: { tokens: Token[] }[];
        };
        t.items.forEach((item, j) => {
          const bullet = t.ordered ? `${j + 1}.` : '•';
          out.push(
            e(
              View,
              { key: `${i}-${j}`, style: styles.listItem },
              e(Text, { style: styles.listBullet }, bullet),
              e(
                Text,
                { style: styles.listText },
                ...inlineToReact(flattenItemTokens(item.tokens)),
              ),
            ),
          );
        });
        break;
      }
      case 'hr':
        out.push(e(View, { key: i, style: styles.hr }));
        break;
      case 'space':
        break;
      default:
        // Unsupported block — emit raw text rather than dropping silently.
        if ('raw' in tok && typeof (tok as { raw: unknown }).raw === 'string') {
          out.push(
            e(Text, { key: i, style: styles.paragraph }, (tok as { raw: string }).raw),
          );
        }
        break;
    }
  });
  return out;
}

/**
 * marked emits list items as a wrapper containing nested `paragraph` /
 * `text` tokens. For our flat inline renderer we want the inline tokens
 * one level up.
 */
function flattenItemTokens(tokens: Token[]): Token[] {
  const flat: Token[] = [];
  for (const t of tokens) {
    if (t.type === 'text' && 'tokens' in t && (t as { tokens?: Token[] }).tokens) {
      flat.push(...(t as { tokens: Token[] }).tokens);
    } else if (
      t.type === 'paragraph' &&
      'tokens' in t &&
      (t as { tokens?: Token[] }).tokens
    ) {
      flat.push(...(t as { tokens: Token[] }).tokens);
    } else {
      flat.push(t);
    }
  }
  return flat;
}

export interface SignatureBlock {
  /** PNG data URL captured by the public sign form. */
  signatureDataUrl?: string;
  signedName: string;
  signedAt: Date;
  /** Optional: representative authority description (guardian flow). */
  representativeAuthority?: string;
}

export interface IntakeAnswer {
  field: RequiredField;
  /** Display value — always already-stringified for the PDF stamp. */
  value: string;
}

export interface RenderConsentPdfInput {
  templateName: string;
  /** Variables for Mustache-lite substitution in the template body. */
  vars: Record<string, string | number | boolean | null | undefined>;
  signature?: SignatureBlock;
  /** Stamped onto the final page in field order. */
  intakeAnswers?: IntakeAnswer[];
  /** "ITR Client HQ — informed-consent v1" header line. */
  brandLine?: string;
}

export async function renderConsentPdf(
  input: RenderConsentPdfInput,
): Promise<Buffer> {
  const rendered = renderTemplate({
    templateName: input.templateName,
    vars: input.vars,
  });
  const tokens = marked.lexer(rendered.body);
  const bodyNodes = tokensToReactPdf(tokens);

  const headerLine =
    input.brandLine ??
    `Intensive Therapy Retreats — ${rendered.meta.title} v${rendered.meta.version}`;

  const docProps = { title: rendered.meta.title } as const;

  const doc = e(
    Document,
    docProps,
    e(
      Page,
      { size: 'LETTER' as const, style: styles.page },
      e(
        View,
        { style: styles.header },
        e(Text, { style: styles.brand }, headerLine),
        e(
          Text,
          { style: styles.metaText },
          rendered.meta.effectiveDate
            ? `Effective ${rendered.meta.effectiveDate}`
            : '',
        ),
      ),
      ...bodyNodes,
      ...(input.signature || input.intakeAnswers
        ? [signaturePage(rendered.meta, input)]
        : []),
    ),
  );

  const stream = await pdf(doc).toBuffer();
  return await streamToBuffer(stream);
}

function signaturePage(
  meta: TemplateMeta,
  input: RenderConsentPdfInput,
): React.ReactNode {
  const intake = input.intakeAnswers ?? [];
  const sig = input.signature;
  return e(
    View,
    { key: 'sig', style: styles.signaturePage },
    e(Text, { style: styles.h2 }, `Signature & Intake — ${meta.title}`),
    ...intake.map((a, idx) =>
      e(
        View,
        { key: `intake-${idx}`, style: styles.intakeRow },
        e(Text, { style: styles.intakeLabel }, `${a.field.label}:`),
        e(Text, { style: styles.intakeValue }, a.value || '—'),
      ),
    ),
    sig
      ? e(
          View,
          { key: 'sig-block', style: { marginTop: 16 } },
          e(Text, { style: styles.signatureLabel }, 'Signature:'),
          sig.signatureDataUrl
            ? e(Image, { style: styles.signatureImage, src: sig.signatureDataUrl })
            : e(View, { style: styles.signatureLine }),
          e(Text, { style: styles.intakeValue }, sig.signedName),
          e(
            Text,
            { style: styles.signatureLabel },
            `Signed at ${sig.signedAt.toISOString()}`,
          ),
          sig.representativeAuthority
            ? e(
                Text,
                { style: styles.intakeValue },
                `Representative authority: ${sig.representativeAuthority}`,
              )
            : null,
        )
      : null,
  );
}

async function streamToBuffer(
  stream: NodeJS.ReadableStream | Buffer,
): Promise<Buffer> {
  if (Buffer.isBuffer(stream)) return stream;
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
  }
  return Buffer.concat(chunks);
}
