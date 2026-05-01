/**
 * Schema-agnostic read-only DB peek (raw SQL). Use when local schema.ts
 * may not match the deployed shape.
 */
import pg from 'pg';

const DSN = process.env.LOCAL_DB_URL;
if (!DSN) {
  console.error('LOCAL_DB_URL not set');
  process.exit(2);
}
const RID = process.argv[2];
if (!RID) {
  console.error('usage: inspect-retreat-sql <retreat_id>');
  process.exit(2);
}

const pool = new pg.Pool({ connectionString: DSN });
try {
  const r = await pool.query(
    `select id, state, client_token, total_planned_cents, deposit_cents, client_id, therapist_id from retreats where id = $1`,
    [RID],
  );
  if (r.rows.length === 0) {
    console.log('retreat not found');
    process.exit(1);
  }
  console.log('retreat:', r.rows[0]);
  const c = await pool.query(
    `select id, first_name, last_name, email from clients where id = $1`,
    [r.rows[0].client_id],
  );
  console.log('client:', c.rows[0]);
  const sigs = await pool.query(
    `select id, template_id, signed_name, signed_at, pdf_storage_path from consent_signatures where retreat_id = $1`,
    [RID],
  );
  console.log('signatures:', sigs.rows.length, sigs.rows);
  const audits = await pool.query(
    `select event_type, actor_type, actor_id, created_at from audit_events where retreat_id = $1 order by created_at`,
    [RID],
  );
  console.log('audit events:', audits.rows);
  const emails = await pool.query(
    `select recipient, template_name, gmail_message_id, sent_at from email_log where retreat_id = $1 order by sent_at`,
    [RID],
  );
  console.log('email log:', emails.rows);
  const required = await pool.query(
    `select rrc.template_id, ct.name, ct.version, ct.requires_signature
       from retreat_required_consents rrc
       join consent_templates ct on ct.id = rrc.template_id
      where rrc.retreat_id = $1`,
    [RID],
  );
  console.log('required consents:', required.rows);
} finally {
  await pool.end();
}
