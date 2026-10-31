import { type Kysely, sql } from "kysely";

/** Email + password accounts. A sign-up's password waits on its confirmation link until the email is proved. */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE users ADD COLUMN password_hash text;
    ALTER TABLE login_tokens ADD COLUMN purpose text NOT NULL DEFAULT 'signin';
    ALTER TABLE login_tokens ADD COLUMN password_hash text;
    ALTER TABLE login_tokens ADD COLUMN name text;
    ALTER TABLE login_tokens ADD COLUMN browser_hash text;
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE login_tokens DROP COLUMN browser_hash, DROP COLUMN name, DROP COLUMN password_hash, DROP COLUMN purpose;
    ALTER TABLE users DROP COLUMN password_hash;
  `.execute(db);
}
