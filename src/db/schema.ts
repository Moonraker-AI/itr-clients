/**
 * Drizzle schema scaffold.
 *
 * Tables are added per-milestone (see DESIGN.md §9 for the full target).
 * M0 ships empty so the migration tooling has something real to run.
 *
 * PHI-bearing columns live exclusively in itr-clients-prod-phi.
 * Dev gets synthetic data only — see CONTRIBUTING.md.
 */

// Examples once we start adding tables in M1:
// import { pgTable, uuid, text, timestamp } from 'drizzle-orm/pg-core';
// export const therapists = pgTable('therapists', {
//   id: uuid('id').primaryKey().defaultRandom(),
//   ...
// });

export {};
