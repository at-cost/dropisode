import { useCallback, useEffect, useState } from "react";
import { type ExportInfo, type Project, type ProjectSummary, type View, api } from "./api";
import { go } from "./App";
import { Poster, WelcomeSteps, firstName } from "./Projects";
import { PLACEHOLDER_NAME, projectStatus } from "./progress";
import { Icon, Spinner, Ticket, Why, ago, money, plural, useApp, useBusy, when } from "./ui";

interface Recent {
  summary: ProjectSummary;
  project: Project | null;
  exports: number;
}

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

const WHAT: Record<string, string> = { frame: "frame", video: "video", tts: "voice" };

/** Which tab an activity line belongs to. */
function tabFor(purpose: string): string {
  if (purpose === "script" || purpose === "cast_extract") return "script";
  if (purpose === "cast_image") return "cast";
  if (purpose === "assemble") return "episode";
  return "storyboard";
}

export function Home() {
  const app = useApp();
  const { busy, run } = useBusy();
  const [list, setList] = useState<ProjectSummary[] | null>(null);
  const [recent, setRecent] = useState<Recent[] | null>(null);
  const [idea, setIdea] = useState("");

  const load = useCallback(async () => {
    try {
      const all = await api.get<ProjectSummary[]>("/projects");
      setList(all);
      const top = [...all].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 3);
      // The full project and its exports give the card its status and progress.
      const rows = await Promise.all(
        top.map(async (summary) => {
          const [v, x] = await Promise.all([
            api.get<View>(`/projects/${summary.id}`).catch(() => null),
            api.get<ExportInfo[]>(`/projects/${summary.id}/exports`).catch(() => []),
          ]);
          return { summary, project: v?.project ?? null, exports: x.filter((e) => e.source === "final" && e.skipped.length === 0).length };
        }),
      );
      setRecent(rows);
    } catch (err) {
      app.fail(err);
      setList([]);
      setRecent([]);
    }
  }, [app]);
  useEffect(() => {
    void load();
  }, [load]);

  const create = () =>
    run("create", async () => {
      const p = await api.post<Project>("/projects", { name: PLACEHOLDER_NAME, idea: idea.trim(), aspect: "9:16" });
      go(`#/p/${p.id}/script`);
    });

  const account = app.config.account;
  const wallet = app.config.wallet;
  const dash = app.dash;
  const empty = list !== null && list.length === 0;
  const greeting = `${empty ? "Welcome" : "Welcome back"}${account ? `, ${firstName(account.name)}` : ""}`;

  return (
    <div className="dash">
      <section className="dash-hero">
        <div>
          <h1>{greeting}</h1>
          <p className="dash-sub">{empty ? "Start with a one-line idea." : "Your next episode is taking shape."}</p>
        </div>
        {dash && dash.running.length > 0 && (
          <div className="queue-strip" aria-live="polite">
            <Spinner />
            {dash.running.map((r) => (
              <a key={r.projectId} href={`#/p/${r.projectId}/storyboard`}>
                {r.count} generating in <strong>{r.projectName}</strong>
              </a>
            ))}
          </div>
        )}
      </section>

      <section className="start-band" aria-label="Start a new episode">
        <div className="start-copy">
          <h2>Start a new episode</h2>
          <p>A one-line idea is enough. The script is written for you.</p>
        </div>
        <form
          className="start-form"
          onSubmit={(e) => {
            e.preventDefault();
            if (idea.trim().length >= 3) void create();
          }}
        >
          <div className="start-row">
            <input
              value={idea}
              onChange={(e) => setIdea(e.target.value)}
              maxLength={4000}
              aria-label="Your idea"
              placeholder="e.g. A stranger boards the last train and knows everyone's name"
            />
            <button type="submit" className="primary solid" disabled={idea.trim().length < 3 || busy === "create"}>
              {busy === "create" ? <Spinner /> : <Icon name="plus" />} New episode
            </button>
          </div>
          <p className="start-note">
            {idea.trim().length > 0 && idea.trim().length < 3 ? (
              <Why>A few more words</Why>
            ) : (
              <span>Free to set up. Every generation is priced before you press it.</span>
            )}{" "}
            <a href="#/projects">More options</a>
          </p>
        </form>
      </section>

      {empty ? (
        <WelcomeSteps />
      ) : (
        <section className="continue" aria-label="Continue working">
          <div className="section-head">
            <h2 className="section-title inline">Continue working</h2>
            <div className="spacer" />
            <a href="#/projects" className="see-all">
              All projects
            </a>
          </div>
          <div className="continue-grid">
            {recent === null
              ? [0, 1, 2].map((i) => <div key={i} className="continue-card skeleton" />)
              : recent.map((r) => <ContinueCard key={r.summary.id} r={r} />)}
          </div>
        </section>
      )}

      <div className="dash-pair">
        <section className="panel usage" aria-label="Credit and usage">
          <div className="panel-head">
            <h2>{wallet ? "Credit & usage" : "Usage"}</h2>
            <div className="spacer" />
            {wallet && (
              <a href="/billing" className="see-all">
                View usage
              </a>
            )}
          </div>
          <div className="usage-body">
            <div className="usage-figures">
              {wallet && (
                <div>
                  <span className="fig-label">Available credit</span>
                  <strong className="fig">{money(wallet.balanceMicro)}</strong>
                </div>
              )}
              <div>
                <span className="fig-label">Spent this month</span>
                <strong className="fig">{dash ? money(dash.month.totalMicro) : "…"}</strong>
              </div>
            </div>
            {dash && dash.month.days.filter((d) => d.paidMicro > 0).length >= 3 && <MonthChart month={dash.month} />}
          </div>
          {wallet && <p className="muted small-text">Pay as you create. No subscription.</p>}
        </section>

        <section className="panel activity" aria-label="Recent activity">
          <div className="panel-head">
            <h2>Recent activity</h2>
          </div>
          {!dash ? (
            <p className="muted">Loading</p>
          ) : dash.recent.length === 0 ? (
            <p className="muted">Nothing yet. Drafts, finals and portraits show up here with their price.</p>
          ) : (
            <ul className="activity-list">
              {dash.recent.slice(0, 6).map((l) => (
                <li key={`${l.projectId}-${l.at}-${l.label}`}>
                  <a href={`#/p/${l.projectId}/${tabFor(l.purpose)}`}>
                    <span className={`act-icon ${l.status === "refunded" ? "refunded" : ""}`} aria-hidden="true">
                      <Icon name={l.status === "refunded" ? "x" : "check"} size={12} />
                    </span>
                    <span className="act-text">
                      <strong>
                        {l.label}
                        {/^Shot /.test(l.label) && WHAT[l.purpose] ? ` ${WHAT[l.purpose]}` : ""}
                      </strong>
                      <span>{l.projectName}</span>
                    </span>
                    {l.status === "refunded" ? <span className="muted small-text">Refunded</span> : <Ticket micro={l.paidMicro} />}
                    <span className="act-when" title={when(l.at)}>
                      {ago(l.at)}
                    </span>
                  </a>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}

function ContinueCard({ r }: { r: Recent }) {
  const s = r.summary;
  const status = r.project ? projectStatus(r.project, r.exports) : null;
  return (
    <article className="continue-card">
      <a className="continue-poster" href={`#/p/${s.id}/script`} aria-label={`Open ${s.name}`}>
        <Poster p={s} />
      </a>
      <div className="continue-info">
        <a className="continue-name" href={`#/p/${s.id}/script`}>
          {s.name}
        </a>
        {status && <span className={`status-chip ${status.tone}`}>{status.label}</span>}
        <p className="continue-counts">
          {plural(s.episodes, "episode")} · {plural(s.shots, "shot")}
        </p>
        <p className="continue-spent">{money(s.paidMicro)} spent</p>
        {status && status.shots > 0 && (
          <p className="continue-finals">
            {status.finals} of {plural(status.shots, "shot")} final
          </p>
        )}
        <div
          className="progress"
          role="progressbar"
          aria-label="Shots with a final take"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round((status?.progress ?? 0) * 100)}
        >
          <span style={{ width: `${(status?.progress ?? 0) * 100}%` }} />
        </div>
        <p className="continue-when" title={when(s.updatedAt)}>
          Edited {ago(s.updatedAt)}
        </p>
      </div>
    </article>
  );
}

/** A bar per day of this month so far; today in rouge. */
function MonthChart({ month }: { month: { month: string; days: { day: string; paidMicro: number }[] } }) {
  const [y, m] = month.month.split("-").map(Number) as [number, number];
  const now = new Date();
  const thisMonth = now.getUTCFullYear() === y && now.getUTCMonth() + 1 === m;
  const last = thisMonth ? now.getUTCDate() : new Date(Date.UTC(y, m, 0)).getUTCDate();
  const by = new Map(month.days.map((d) => [Number(d.day.slice(8, 10)), d.paidMicro]));
  const max = Math.max(1, ...month.days.map((d) => d.paidMicro));
  const days = Array.from({ length: last }, (_, i) => i + 1);
  return (
    <figure className="month-chart" aria-label={`Spend per day in ${MONTHS[m - 1]}`}>
      <div className="bars">
        {days.map((d) => {
          const v = by.get(d) ?? 0;
          return (
            <span
              key={d}
              className={`bar${d === last && thisMonth ? " today" : ""}${v === 0 ? " zero" : ""}`}
              style={{ height: `${v === 0 ? 3 : Math.max(8, (v / max) * 100)}%` }}
              title={`${d} ${MONTHS[m - 1]}: ${money(v)}`}
            />
          );
        })}
      </div>
      <figcaption>{MONTHS[m - 1]}</figcaption>
    </figure>
  );
}
