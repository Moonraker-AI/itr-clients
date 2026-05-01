/**
 * Local smoke harness — render every consent template to /tmp and verify
 * each emits a non-trivial PDF with a `%PDF` magic header.
 *
 *   npm run smoke:pdf
 */

import { writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { renderConsentPdf } from '../src/lib/pdf.js';
import { formatCents } from '../src/lib/pricing.js';

interface SampleCase {
  templateName: string;
  vars: Record<string, string>;
  withHalfDay: boolean;
}

const fullDayCents = 155_000;
const halfDayCents = 83_000;
const depositCents = fullDayCents;
const affirmUpliftPct = 0.1;
const cancellationAdminFeeCents = 10_000;
const halfDayAffirm = Math.round(halfDayCents * (1 + affirmUpliftPct));

const samples: SampleCase[] = [
  {
    templateName: 'informed-consent',
    vars: {
      therapist_name: 'Bambi Rattner',
      full_day_rate_formatted: formatCents(fullDayCents),
      half_day_rate_formatted: formatCents(halfDayCents),
      half_day_rate_affirm_formatted: formatCents(halfDayAffirm),
      affirm_uplift_pct_formatted: `${(affirmUpliftPct * 100).toFixed(0)}%`,
      deposit_rate_formatted: formatCents(depositCents),
      cancellation_admin_fee_formatted: formatCents(cancellationAdminFeeCents),
      npp_version_label: 'v1, effective 2020-07-14',
    },
    withHalfDay: true,
  },
  {
    templateName: 'informed-consent',
    vars: {
      therapist_name: 'Ross Hackerson',
      full_day_rate_formatted: formatCents(240_000),
      half_day_rate_formatted: '',
      half_day_rate_affirm_formatted: '',
      affirm_uplift_pct_formatted: '10%',
      deposit_rate_formatted: formatCents(240_000),
      cancellation_admin_fee_formatted: formatCents(cancellationAdminFeeCents),
      npp_version_label: 'v1, effective 2020-07-14',
    },
    withHalfDay: false,
  },
  { templateName: 'notice-of-privacy-practices', vars: {}, withHalfDay: false },
  { templateName: 'emergency-contact-release', vars: {}, withHalfDay: false },
];

const outDir = os.tmpdir();
let failed = 0;

for (const s of samples) {
  const tag = s.templateName + (s.withHalfDay ? '-with-halfday' : '');
  try {
    const buf = await renderConsentPdf({
      templateName: s.templateName,
      vars: s.vars,
      signature: {
        signatureDataUrl: undefined,
        signedName: 'Sample Client',
        signedAt: new Date('2026-05-01T12:00:00Z'),
      },
      intakeAnswers: [],
    });
    if (buf.length < 1024 || buf.subarray(0, 4).toString('ascii') !== '%PDF') {
      throw new Error(
        `PDF magic check failed: bytes=${buf.length} prefix=${buf.subarray(0, 4).toString('ascii')}`,
      );
    }
    const outPath = path.join(outDir, `sample-${tag}.pdf`);
    writeFileSync(outPath, buf);
    console.log(`OK  ${tag.padEnd(40)} ${buf.length}B → ${outPath}`);
  } catch (err) {
    failed += 1;
    console.error(`FAIL ${tag}:`, (err as Error).message);
  }
}

if (failed > 0) {
  console.error(`${failed} sample(s) failed`);
  process.exit(1);
}
