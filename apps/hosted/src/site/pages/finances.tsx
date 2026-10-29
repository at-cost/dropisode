/** @jsxImportSource hono/jsx */
import { usdToMicro } from "@reel/money";
import type { Ctx } from "../../context";
import type { FinancesSummary } from "../../finances";
import { Ext, StatusTag, TableWrap, int, page, usd } from "../ui";

export function financesPage(c: Ctx, f: FinancesSummary) {
  const { platform } = c.get("deps");
  const markupPct = Math.round(platform.markup * 100);
  const genCost = f.generation.reduce((a, g) => a + g.providerCostMicro, 0);
  const genCharged = f.generation.reduce((a, g) => a + g.chargedMicro, 0);
  const assumed = f.fixed.items.filter((i) => i.status === "assumed").length;
  const atCap = f.currentShareMicro >= f.shareCapMicro;
  return page(c, {
    title: "Finances",
    description:
      "Reel's live finances: top-ups, what providers billed, refunds, fixed costs, the reserve and reconciliation with provider invoices.",
    cache: "public, max-age=60",
    body: (
      <>
        <h1>Finances</h1>
        <p class="lede">
          Live figures from Reel's ledger, worked out with the same code that bills you. We charge the provider's price plus {markupPct}%.
          This page shows where that money goes. The same data is at <a href="/finances.json">/finances.json</a>.
        </p>

        <div class="grid" style="margin-top:16px">
          <div class="stat">
            <span class="muted small">Top-ups received</span>
            <span class="big" data-k="topups">
              {usd(f.topupsMicro)}
            </span>
            <span class="small muted">
              {int(f.topupCount)} payments{f.paymentReversalsMicro > 0 ? `, ${usd(f.paymentReversalsMicro)} refunded or disputed` : ""}
            </span>
          </div>
          <div class="stat">
            <span class="muted small">Stripe fees paid</span>
            <span class="big">{usd(f.stripeFeesMicro)}</span>
          </div>
          <div class="stat">
            <span class="muted small">Providers billed us</span>
            <span class="big" data-k="provider-cost">
              {usd(genCost)}
            </span>
            <span class="small muted">we charged {usd(genCharged)}</span>
          </div>
          <div class="stat">
            <span class="muted small">Reserve</span>
            <span class={`big ${f.reserveMicro < 0 ? "bad-text" : ""}`}>{usd(f.reserveMicro)}</span>
            <span class="small muted">all time</span>
          </div>
        </div>

        <h2>Generation spend by provider and model</h2>
        <p class="muted">
          All time. "Provider cost" is what the provider billed us. "Charged" is what creators paid: that cost plus {markupPct}%.
        </p>
        {f.generation.length === 0 ? (
          <p class="card muted">No generations yet.</p>
        ) : (
          <TableWrap label="Generation spend">
            <table>
              <thead>
                <tr>
                  <th>Provider</th>
                  <th>Model</th>
                  <th class="num">Jobs</th>
                  <th class="num">Provider cost</th>
                  <th class="num">Charged</th>
                </tr>
              </thead>
              <tbody>
                {f.generation.map((g) => (
                  <tr data-model={g.model}>
                    <td>{g.provider}</td>
                    <td>{g.model}</td>
                    <td class="num">{int(g.jobs)}</td>
                    <td class="num">{usd(g.providerCostMicro)}</td>
                    <td class="num">{usd(g.chargedMicro)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <td>Total</td>
                  <td />
                  <td class="num">{int(f.generation.reduce((a, g) => a + g.jobs, 0))}</td>
                  <td class="num">{usd(genCost)}</td>
                  <td class="num">{usd(genCharged)}</td>
                </tr>
              </tfoot>
            </table>
          </TableWrap>
        )}

        <h2>Failures and refunds</h2>
        <ul>
          <li>
            <strong>{int(f.refunds.count)}</strong> failed jobs the provider didn't bill: {usd(f.refunds.releasedMicro)} of holds released
            back to creators.
          </li>
          <li>
            <strong>{int(f.failedBilled)}</strong> failed jobs the provider did bill. These were charged, and each one says so in its cost
            log.
          </li>
        </ul>

        <h2>Daily charges</h2>
        <p>
          Storage and fixed-cost shares charged to workspaces so far: <strong>{usd(f.dailyChargesMicro)}</strong>.
        </p>

        <h2>Fixed costs</h2>
        <p>
          {usd(f.fixed.monthlyMicro)} a month.{" "}
          {assumed > 0 ? `${assumed} of these are assumed: placeholders until the host and tools are chosen.` : ""}
        </p>
        <TableWrap label="Fixed costs">
          <table>
            <thead>
              <tr>
                <th>Item</th>
                <th class="num">Per month</th>
                <th>Status</th>
                <th>Notes</th>
              </tr>
            </thead>
            <tbody>
              {f.fixed.items.map((i) => (
                <tr>
                  <td>
                    {i.name}
                    <div class="small">
                      <Ext href={i.source}>source</Ext>
                    </div>
                  </td>
                  <td class="num">{usd(usdToMicro(i.monthlyUsd))}</td>
                  <td>
                    <StatusTag status={i.status} />
                  </td>
                  <td class="small muted">{i.notes ?? ""}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <td>Total</td>
                <td class="num">{usd(f.fixed.monthlyMicro)}</td>
                <td />
                <td />
              </tr>
            </tfoot>
          </table>
        </TableWrap>

        <h2>The share per workspace</h2>
        <p>
          <strong data-k="active">{int(f.activeWorkspaces)}</strong> workspaces generated something in {f.month}. Each pays{" "}
          <strong data-k="share">{usd(f.currentShareMicro)}</strong> a month towards fixed costs{atCap ? ", which is the cap" : ""}. The cap
          is {usd(f.shareCapMicro)} and can only go down. Workspaces that generate nothing in a month pay no share, only their storage.{" "}
          <a href="/pricing#daily">How the daily charge works</a>.
        </p>

        <h2>Reserve</h2>
        <p>
          The reserve is what we charged (generation and daily charges) minus what providers billed, Stripe fees, and fixed costs for every
          month so far: <strong>{usd(f.reserveMicro)}</strong>. It pays for months when fixed costs are more than the shares, and for
          refunds. Our target is {platform.reserveTargetMonths} months of fixed costs.
        </p>

        <h2>Reconciliation with provider invoices</h2>
        <p class="muted">
          Each month we compare what we recorded for every job with the provider's invoice. Any difference is shown here, not hidden.
        </p>
        {f.reconciliation.length === 0 ? (
          <p class="card muted">No provider invoices recorded yet.</p>
        ) : (
          <TableWrap label="Reconciliation">
            <table>
              <thead>
                <tr>
                  <th>Month</th>
                  <th>Provider</th>
                  <th class="num">Invoice</th>
                  <th class="num">Recorded</th>
                  <th class="num">Difference</th>
                </tr>
              </thead>
              <tbody>
                {f.reconciliation.map((r) => (
                  <tr>
                    <td>{r.month}</td>
                    <td>{r.provider}</td>
                    <td class="num">{usd(r.invoiceMicro)}</td>
                    <td class="num">{usd(r.recordedMicro)}</td>
                    <td class={`num ${r.differenceMicro !== 0 ? "warn-text" : ""}`}>{usd(r.differenceMicro)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableWrap>
        )}
        <p class="small muted">Figures are rounded to the cent here. The JSON has exact amounts in micro-dollars.</p>
      </>
    ),
  });
}
