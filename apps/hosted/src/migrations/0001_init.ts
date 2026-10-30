import { type Kysely, sql } from "kysely";

/**
 * Dropisode hosted schema. Money is integer micro-USD (bigint). Every table that
 * holds customer data carries workspace_id, and every query is scoped by it
 * (see stores.ts and the isolation tests).
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE users (
      id uuid PRIMARY KEY,
      email text NOT NULL UNIQUE,
      name text NOT NULL,
      email_verified_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(),
      deleted_at timestamptz
    );
    CREATE TABLE sessions (
      id uuid PRIMARY KEY,
      user_id uuid NOT NULL REFERENCES users(id),
      token_hash text NOT NULL UNIQUE,
      expires_at timestamptz NOT NULL,
      last_seen_at timestamptz NOT NULL DEFAULT now(),
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE login_tokens (
      token_hash text PRIMARY KEY,
      email text NOT NULL,
      redirect text,
      expires_at timestamptz NOT NULL,
      used_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE oauth_accounts (
      provider text NOT NULL,
      provider_user_id text NOT NULL,
      user_id uuid NOT NULL REFERENCES users(id),
      created_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (provider, provider_user_id)
    );

    CREATE TABLE workspaces (
      id uuid PRIMARY KEY,
      name text NOT NULL,
      created_by uuid NOT NULL REFERENCES users(id),
      created_at timestamptz NOT NULL DEFAULT now(),
      stripe_customer_id text,
      frozen_at timestamptz,
      frozen_reason text,
      flagged_at timestamptz,
      flagged_reason text
    );
    CREATE TABLE workspace_members (
      workspace_id uuid NOT NULL REFERENCES workspaces(id),
      user_id uuid NOT NULL REFERENCES users(id),
      role text NOT NULL CHECK (role IN ('owner', 'member')),
      created_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (workspace_id, user_id)
    );
    CREATE TABLE invites (
      id uuid PRIMARY KEY,
      workspace_id uuid NOT NULL REFERENCES workspaces(id),
      email text NOT NULL,
      token_hash text NOT NULL UNIQUE,
      invited_by uuid NOT NULL REFERENCES users(id),
      expires_at timestamptz NOT NULL,
      accepted_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE TABLE projects (
      id text PRIMARY KEY,
      workspace_id uuid NOT NULL REFERENCES workspaces(id),
      name text NOT NULL,
      doc jsonb NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      deleted_at timestamptz
    );
    CREATE INDEX projects_ws ON projects (workspace_id) WHERE deleted_at IS NULL;

    CREATE TABLE media (
      id text PRIMARY KEY,
      workspace_id uuid NOT NULL REFERENCES workspaces(id),
      project_id text NOT NULL REFERENCES projects(id),
      storage_key text NOT NULL UNIQUE,
      content_type text NOT NULL,
      bytes bigint NOT NULL,
      source text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      moderated_at timestamptz,
      hidden_at timestamptz,
      hidden_reason text,
      deleted_at timestamptz
    );
    CREATE INDEX media_ws ON media (workspace_id) WHERE deleted_at IS NULL;
    CREATE INDEX media_unmoderated ON media (created_at) WHERE moderated_at IS NULL AND deleted_at IS NULL;

    CREATE TABLE jobs (
      id text PRIMARY KEY,
      workspace_id uuid NOT NULL REFERENCES workspaces(id),
      project_id text NOT NULL REFERENCES projects(id),
      state text NOT NULL,
      unfinished boolean NOT NULL,
      record jsonb NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX jobs_unfinished ON jobs (workspace_id) WHERE unfinished;

    CREATE TABLE exports (
      id text PRIMARY KEY,
      workspace_id uuid NOT NULL REFERENCES workspaces(id),
      project_id text NOT NULL REFERENCES projects(id),
      info jsonb NOT NULL,
      bytes bigint NOT NULL DEFAULT 0,
      created_at timestamptz NOT NULL DEFAULT now(),
      deleted_at timestamptz
    );

    -- The wallet. Balance = sum(amount_micro). Credits positive, charges negative.
    CREATE TABLE ledger (
      id bigserial PRIMARY KEY,
      workspace_id uuid NOT NULL REFERENCES workspaces(id),
      at timestamptz NOT NULL DEFAULT now(),
      kind text NOT NULL CHECK (kind IN ('topup', 'generation', 'daily', 'adjustment', 'stripe_refund')),
      amount_micro bigint NOT NULL,
      ref text NOT NULL,
      job_id text,
      provider text,
      model text,
      provider_cost_micro bigint,
      note text NOT NULL DEFAULT '',
      UNIQUE (kind, ref)
    );
    CREATE INDEX ledger_ws ON ledger (workspace_id, at);

    -- A hold per job, placed before submission and released at settlement.
    CREATE TABLE holds (
      job_id text PRIMARY KEY,
      workspace_id uuid NOT NULL REFERENCES workspaces(id),
      amount_micro bigint NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      released_at timestamptz
    );
    CREATE INDEX holds_open ON holds (workspace_id) WHERE released_at IS NULL;

    -- What each job has been charged so far; a second finalize charges only the difference.
    CREATE TABLE settlements (
      job_id text PRIMARY KEY,
      workspace_id uuid NOT NULL REFERENCES workspaces(id),
      charged_micro bigint NOT NULL,
      provider_cost_micro bigint NOT NULL,
      provider_billed boolean NOT NULL,
      succeeded boolean NOT NULL,
      provider text NOT NULL,
      model text NOT NULL,
      revision int NOT NULL DEFAULT 1,
      updated_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE TABLE topups (
      id uuid PRIMARY KEY,
      workspace_id uuid NOT NULL REFERENCES workspaces(id),
      user_id uuid NOT NULL REFERENCES users(id),
      amount_cents int NOT NULL,
      status text NOT NULL CHECK (status IN ('pending', 'paid', 'failed', 'refunded')),
      checkout_session_id text UNIQUE,
      payment_intent_id text,
      fee_cents int,
      created_at timestamptz NOT NULL DEFAULT now(),
      paid_at timestamptz
    );

    CREATE TABLE daily_charges (
      workspace_id uuid NOT NULL REFERENCES workspaces(id),
      day date NOT NULL,
      active boolean NOT NULL,
      storage_gb numeric NOT NULL,
      fixed_share_micro bigint NOT NULL,
      storage_micro bigint NOT NULL,
      markup_micro bigint NOT NULL,
      total_micro bigint NOT NULL,
      PRIMARY KEY (workspace_id, day)
    );

    -- Provider invoices entered by the operator, for the reconciliation line on /finances.
    CREATE TABLE provider_invoices (
      provider text NOT NULL,
      month text NOT NULL,
      amount_micro bigint NOT NULL,
      source text NOT NULL DEFAULT '',
      created_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (provider, month)
    );

    CREATE TABLE email_log (
      kind text NOT NULL,
      ref text NOT NULL,
      workspace_id uuid,
      sent_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (kind, ref)
    );

    CREATE TABLE moderation_events (
      id bigserial PRIMARY KEY,
      at timestamptz NOT NULL DEFAULT now(),
      workspace_id uuid REFERENCES workspaces(id),
      user_id uuid REFERENCES users(id),
      stage text NOT NULL,
      target text NOT NULL,
      blocked boolean NOT NULL,
      reasons jsonb NOT NULL DEFAULT '[]'
    );
    CREATE TABLE abuse_reports (
      id uuid PRIMARY KEY,
      at timestamptz NOT NULL DEFAULT now(),
      reporter_email text,
      url text NOT NULL,
      reason text NOT NULL,
      details text NOT NULL DEFAULT '',
      status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'actioned', 'dismissed'))
    );
    CREATE TABLE admin_log (
      id bigserial PRIMARY KEY,
      at timestamptz NOT NULL DEFAULT now(),
      admin_user_id uuid REFERENCES users(id),
      action text NOT NULL,
      target text NOT NULL,
      details jsonb NOT NULL DEFAULT '{}'
    );
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    DROP TABLE IF EXISTS admin_log, abuse_reports, moderation_events, email_log, provider_invoices, daily_charges, topups,
      settlements, holds, ledger, exports, jobs, media, projects, invites, workspace_members, workspaces, oauth_accounts,
      login_tokens, sessions, users CASCADE;
  `.execute(db);
}
