/** @jsxImportSource hono/jsx */
/** The account and billing pages (server-rendered; actions go through the JSON APIs). */
import { balanceLastsDays, formatUsd } from "@reel/money";
import { Hono } from "hono";
import { requireUser } from "../auth/session";
import { currentWorkspace } from "../auth/workspace";
import { projectedDaily } from "../billing/routes";
import { walletState } from "../billing/wallet";
import type { AppEnv, Ctx } from "../context";
import { num } from "../db";
import { accountState, pendingInvites } from "./service";
import { fmtDate, fmtDateTime, fmtMoney, render } from "./render";

const signInFirst = (c: Ctx) => c.redirect(`/sign-in?next=${encodeURIComponent(c.req.path + (new URL(c.req.url).search || ""))}`);

const Err = () => <p class="err" data-error="" />;

export const accountPages = new Hono<AppEnv>();

accountPages.get("/account", async (c) => {
  if (!c.get("user")) return signInFirst(c);
  const s = await accountState(c);
  const ws = s.workspace;
  const owner = ws?.role === "owner";
  const owners = s.members.filter((m) => m.role === "owner").length;
  const invites = owner ? await pendingInvites(c) : [];
  return render(
    c,
    "Account",
    <div class="stack">
      <h1>Account</h1>
      <div class="card row" style="display:flex;gap:12px;align-items:center;flex-wrap:wrap;justify-content:space-between">
        <div>
          Signed in as <strong>{s.user.name}</strong> <span class="muted">({s.user.email})</span>
        </div>
        <form class="row" data-api="/auth/sign-out" data-next="/">
          <button class="secondary" type="submit">
            Sign out
          </button>
        </form>
      </div>

      <h2>Your workspaces</h2>
      <p class="muted small">A workspace holds projects and one balance. Everyone in it shares both.</p>
      <table>
        <thead>
          <tr>
            <th>Workspace</th>
            <th>Your role</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {s.memberships.map((m) => (
            <tr>
              <td>
                {m.name} {m.frozen ? <span class="tag">frozen</span> : null}
              </td>
              <td>{m.role}</td>
              <td class="num">
                {ws && m.workspaceId === ws.workspaceId ? (
                  <span class="tag">current</span>
                ) : (
                  <form class="inline" data-api="/api/account/switch" data-next="/account">
                    <input type="hidden" name="workspaceId" value={m.workspaceId} />
                    <button class="secondary" type="submit">
                      Switch
                    </button>
                  </form>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <h3 style="margin-top:22px">Start another workspace</h3>
      <p class="muted small" style="margin-top:0">
        For a separate team or client, with its own projects and balance.
      </p>
      <form class="row" data-api="/api/account/workspaces" data-next="/account">
        <input class="wide-input" name="name" required maxlength={80} placeholder="Name a new workspace" aria-label="New workspace name" />
        <button type="submit">Create workspace</button>
        <Err />
      </form>

      {ws ? (
        <>
          <h2>{ws.name}</h2>
          {owner ? (
            <form class="row" data-api="/api/account/workspace" data-method="PATCH">
              <input class="wide-input" name="name" required maxlength={80} value={ws.name} aria-label="Workspace name" />
              <button class="secondary" type="submit">
                Rename
              </button>
              <Err />
            </form>
          ) : null}
          <p>
            <strong>Members are free.</strong> <span class="muted">Invite as many people as you like. There are no seats.</span>
          </p>
          <div class="scroll">
            <table class="fit-sm">
              <thead>
                <tr>
                  <th>Name</th>
                  <th class="sm-hide">Email</th>
                  <th>Role</th>
                  <th class="sm-hide">Joined</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {s.members.map((m) => {
                  const me = m.userId === s.user.id;
                  const lastOwner = m.role === "owner" && owners <= 1;
                  return (
                    <tr>
                      <td>
                        {m.name} {me ? <span class="tag">you</span> : null}
                        <span class="sm-only muted small">{m.email}</span>
                      </td>
                      <td class="sm-hide">{m.email}</td>
                      <td>{m.role}</td>
                      <td class="sm-hide nowrap">{fmtDate(m.joinedAt)}</td>
                      <td class="num">
                        {owner && !lastOwner ? (
                          <form class="inline" data-api={`/api/account/members/${m.userId}`} data-method="PATCH" data-next="/account">
                            <input type="hidden" name="role" value={m.role === "owner" ? "member" : "owner"} />
                            <button class="secondary" type="submit">
                              {m.role === "owner" ? "Make member" : "Make owner"}
                            </button>
                          </form>
                        ) : null}{" "}
                        {me && !lastOwner ? (
                          <form
                            class="inline"
                            data-api={`/api/account/members/${m.userId}`}
                            data-method="DELETE"
                            data-next="/account"
                            data-confirm={`Leave ${ws.name}?`}
                          >
                            <button class="secondary" type="submit">
                              Leave
                            </button>
                          </form>
                        ) : null}
                        {!me && owner && !lastOwner ? (
                          <form
                            class="inline"
                            data-api={`/api/account/members/${m.userId}`}
                            data-method="DELETE"
                            data-next="/account"
                            data-confirm={`Remove ${m.email}?`}
                          >
                            <button class="secondary" type="submit">
                              Remove
                            </button>
                          </form>
                        ) : null}
                        {me && lastOwner ? <span class="muted small">Make someone else an owner to leave</span> : null}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {owner ? (
            <>
              <h2>Invite someone</h2>
              <form class="row" data-api="/api/account/invites" data-next="/account">
                <input
                  class="wide-input"
                  type="email"
                  name="email"
                  required
                  maxlength={254}
                  placeholder="name@example.com"
                  aria-label="Email to invite"
                />
                <button type="submit">Send invite</button>
                <Err />
              </form>
              <p class="muted small">They get an email link. It works for 7 days and only for that email address.</p>
              {invites.length ? (
                <table>
                  <thead>
                    <tr>
                      <th>Invited</th>
                      <th>Sent</th>
                      <th>Expires</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {invites.map((i) => (
                      <tr>
                        <td>{i.email}</td>
                        <td>{fmtDate(i.createdAt)}</td>
                        <td>{fmtDate(i.expiresAt)}</td>
                        <td class="num">
                          <form class="inline" data-api={`/api/account/invites/${i.id}`} data-method="DELETE" data-next="/account">
                            <button class="secondary" type="submit">
                              Cancel
                            </button>
                          </form>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : null}
            </>
          ) : (
            <p class="muted small">Only owners can invite or remove people.</p>
          )}
        </>
      ) : (
        <p class="notice">You're not in a workspace. Create one above.</p>
      )}
    </div>,
  );
});

const KIND: Record<string, string> = {
  topup: "Top-up",
  generation: "Generation",
  daily: "Daily charge",
  adjustment: "Adjustment",
  stripe_refund: "Refund to card",
};

/** A model's display name ("MiniMax H3 Max Turbo"), or its id if it's no longer in the catalog. */
function modelLabel(deps: { catalog: { get(id: string): { label: string } } }, id: string): string {
  try {
    return deps.catalog.get(id).label;
  } catch {
    return id;
  }
}

accountPages.get("/billing", async (c) => {
  if (!c.get("user")) return signInFirst(c);
  requireUser(c);
  const deps = c.get("deps");
  const ws = await currentWorkspace(c);
  const w = await walletState(deps.db, ws.workspaceId);
  const daily = await projectedDaily(deps, ws.workspaceId);
  const lasts = balanceLastsDays(w.balanceMicro, daily);
  const ledger = await deps.db
    .selectFrom("ledger")
    .select(["at", "kind", "amountMicro", "model", "note"])
    .where("workspaceId", "=", ws.workspaceId)
    .orderBy("at", "desc")
    .orderBy("id", "desc")
    .limit(200)
    .execute();
  const { minTopupUsd: min, maxTopupUsd: max } = deps.platform;
  const canTopUp = deps.config.BILLING_ENABLED && !!deps.payments && !ws.frozen;
  return render(
    c,
    "Billing",
    <div class="stack">
      <h1>Billing</h1>
      <p class="muted">
        Workspace: <strong>{ws.name}</strong>. <a href="/account">Switch</a>
      </p>
      {c.req.query("paid") === "1" ? <p class="notice">Payment received; it appears here within a minute.</p> : null}
      {ws.frozen ? <p class="notice">This workspace is frozen while we review it. Top-ups and generations are paused.</p> : null}

      <div class="grid">
        <div class="card">
          <div class="muted small">Balance</div>
          <div class="big">{formatUsd(w.balanceMicro)}</div>
        </div>
        <div class="card">
          <div class="muted small">Held for running generations</div>
          <div class="big">{formatUsd(w.heldMicro)}</div>
          <div class="muted small">Available: {formatUsd(w.availableMicro)}</div>
        </div>
        <div class="card">
          <div class="muted small">Daily charge (shared costs + storage)</div>
          <div class="big">{fmtMoney(daily)}</div>
          <div class="muted small">
            {lasts === null
              ? "No daily charge right now."
              : `At this rate, the daily charge alone would use your balance in about ${lasts} ${lasts === 1 ? "day" : "days"}.`}
          </div>
        </div>
      </div>

      <h2>Add credit</h2>
      {canTopUp ? (
        <div class="card topup">
          <div class="presets">
            {[10, 20, 50]
              .filter((v) => v >= min && v <= max)
              .map((v) => (
                <form data-api="/api/billing/topup">
                  <input type="hidden" name="amountUsd" value={String(v)} />
                  <button type="submit" class="preset">
                    ${v}
                  </button>
                </form>
              ))}
          </div>
          <form class="row custom" data-api="/api/billing/topup">
            <label for="amt" class="muted small">
              Or another amount
            </label>
            <span class="usd-input">
              $<input id="amt" type="number" name="amountUsd" min={min} max={max} step="1" placeholder="100" required />
            </span>
            <button type="submit" class="secondary">
              Pay
            </button>
            <Err />
          </form>
        </div>
      ) : (
        <p class="muted">{ws.frozen ? "Top-ups are paused for this workspace." : "Top-ups aren't open yet."}</p>
      )}
      <p class="muted small">
        ${min} to ${max} per top-up. You pay on Stripe's page and come back here.
      </p>

      <h2>How it works</h2>
      <ul>
        <li>Generations cost the provider's price + 20%.</li>
        <li>Failed generations the provider doesn't bill are refunded automatically.</li>
        <li>Credit never expires.</li>
        <li>No subscription.</li>
      </ul>

      <h2>History</h2>
      {ledger.length ? (
        <div class="scroll">
          <table class="fit-sm">
            <thead>
              <tr>
                <th class="sm-hide">When</th>
                <th>What</th>
                <th class="num">Amount</th>
              </tr>
            </thead>
            <tbody>
              {ledger.map((l) => {
                const kind = KIND[l.kind] ?? l.kind;
                const model = l.model ? modelLabel(deps, l.model) : "";
                const note = l.note && l.note !== kind && l.note !== "Top-up" ? l.note : "";
                const amount = num(l.amountMicro);
                return (
                  <tr>
                    <td class="muted small nowrap sm-hide">{fmtDateTime(l.at)}</td>
                    <td>
                      <span class="sm-only muted small">{fmtDateTime(l.at)}</span>
                      {kind}
                      {model ? <span class="muted"> · {model}</span> : null}
                      {note ? <span class="muted"> · {note}</span> : null}
                    </td>
                    <td class={`num${amount > 0 ? " ok-text" : ""}`}>
                      {amount > 0 ? "+" : ""}
                      {fmtMoney(amount)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : (
        <p class="muted">Nothing yet.</p>
      )}
    </div>,
  );
});
