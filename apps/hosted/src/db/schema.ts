/** Table types for Kysely (camelCase; the CamelCasePlugin maps to snake_case columns). */
import type { ColumnType, Generated } from "kysely";

type Ts = ColumnType<Date, Date | string | undefined, Date | string>;
type TsNull = ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;
/** bigint columns come back as strings (see db/index.ts); write numbers. */
type Big = ColumnType<string, number | bigint | string, number | bigint | string>;
type Json<T> = ColumnType<T, string, string>;

export interface DB {
  users: {
    id: string;
    email: string;
    name: string;
    emailVerifiedAt: TsNull;
    createdAt: Generated<Date>;
    deletedAt: TsNull;
    passwordHash: Generated<string | null>;
  };
  sessions: { id: string; userId: string; tokenHash: string; expiresAt: Ts; lastSeenAt: Generated<Date>; createdAt: Generated<Date> };
  loginTokens: {
    tokenHash: string;
    email: string;
    redirect: string | null;
    expiresAt: Ts;
    usedAt: TsNull;
    createdAt: Generated<Date>;
    /** "signin" (email link), "signup" (confirms a new account; carries its password), "reset" (password reset). */
    purpose: Generated<"signin" | "signup" | "reset">;
    passwordHash: Generated<string | null>;
    name: Generated<string | null>;
  };
  oauthAccounts: { provider: string; providerUserId: string; userId: string; createdAt: Generated<Date> };
  workspaces: {
    id: string;
    name: string;
    createdBy: string;
    createdAt: Generated<Date>;
    stripeCustomerId: string | null;
    frozenAt: TsNull;
    frozenReason: string | null;
    flaggedAt: TsNull;
    flaggedReason: string | null;
  };
  workspaceMembers: { workspaceId: string; userId: string; role: "owner" | "member"; createdAt: Generated<Date> };
  invites: {
    id: string;
    workspaceId: string;
    email: string;
    tokenHash: string;
    invitedBy: string;
    expiresAt: Ts;
    acceptedAt: TsNull;
    createdAt: Generated<Date>;
  };
  projects: {
    id: string;
    workspaceId: string;
    name: string;
    doc: Json<unknown>;
    createdAt: Generated<Date>;
    updatedAt: Generated<Date>;
    deletedAt: TsNull;
  };
  media: {
    id: string;
    workspaceId: string;
    projectId: string;
    storageKey: string;
    contentType: string;
    bytes: Big;
    source: string;
    createdAt: Generated<Date>;
    moderatedAt: TsNull;
    hiddenAt: TsNull;
    hiddenReason: string | null;
    deletedAt: TsNull;
  };
  jobs: {
    id: string;
    workspaceId: string;
    projectId: string;
    state: string;
    unfinished: boolean;
    record: Json<unknown>;
    createdAt: Generated<Date>;
    updatedAt: Generated<Date>;
  };
  exports: {
    id: string;
    workspaceId: string;
    projectId: string;
    info: Json<unknown>;
    bytes: ColumnType<string, number | undefined, number>;
    createdAt: Generated<Date>;
    deletedAt: TsNull;
  };
  ledger: {
    id: Generated<string>;
    workspaceId: string;
    at: Generated<Date>;
    kind: "topup" | "generation" | "daily" | "adjustment" | "stripe_refund";
    amountMicro: Big;
    ref: string;
    jobId: string | null;
    provider: string | null;
    model: string | null;
    providerCostMicro: Big | null;
    note: Generated<string>;
  };
  holds: { jobId: string; workspaceId: string; amountMicro: Big; createdAt: Generated<Date>; releasedAt: TsNull };
  settlements: {
    jobId: string;
    workspaceId: string;
    chargedMicro: Big;
    providerCostMicro: Big;
    providerBilled: boolean;
    succeeded: boolean;
    provider: string;
    model: string;
    revision: Generated<number>;
    updatedAt: Generated<Date>;
  };
  topups: {
    id: string;
    workspaceId: string;
    userId: string;
    amountCents: number;
    status: "pending" | "paid" | "failed" | "refunded";
    checkoutSessionId: string | null;
    paymentIntentId: string | null;
    feeCents: number | null;
    createdAt: Generated<Date>;
    paidAt: TsNull;
  };
  dailyCharges: {
    workspaceId: string;
    day: string;
    active: boolean;
    storageGb: string | number;
    fixedShareMicro: Big;
    storageMicro: Big;
    markupMicro: Big;
    totalMicro: Big;
  };
  providerInvoices: { provider: string; month: string; amountMicro: Big; source: Generated<string>; createdAt: Generated<Date> };
  emailLog: { kind: string; ref: string; workspaceId: string | null; sentAt: Generated<Date> };
  moderationEvents: {
    id: Generated<string>;
    at: Generated<Date>;
    workspaceId: string | null;
    userId: string | null;
    stage: string;
    target: string;
    blocked: boolean;
    reasons: Json<string[]>;
  };
  abuseReports: {
    id: string;
    at: Generated<Date>;
    reporterEmail: string | null;
    url: string;
    reason: string;
    details: Generated<string>;
    status: Generated<"open" | "actioned" | "dismissed">;
  };
  adminLog: {
    id: Generated<string>;
    at: Generated<Date>;
    adminUserId: string | null;
    action: string;
    target: string;
    details: Json<unknown>;
  };
}
