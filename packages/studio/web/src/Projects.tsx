import { useCallback, useEffect, useState } from "react";
import { type Aspect, type Project, type ProjectSummary, api } from "./api";
import { go } from "./App";
import { Icon, MoreMenu, Spinner, ago, money, plural, useApp, useBusy, when } from "./ui";

const firstName = (name: string) => name.trim().split(/\s+/)[0] ?? "";

export function Projects() {
  const app = useApp();
  const { busy, run } = useBusy();
  const [list, setList] = useState<ProjectSummary[] | null>(null);
  const [name, setName] = useState("");
  const [idea, setIdea] = useState("");
  const [aspect, setAspect] = useState<Aspect>("9:16");

  const load = useCallback(async () => {
    try {
      setList(await api.get<ProjectSummary[]>("/projects"));
    } catch (err) {
      app.fail(err);
      setList([]);
    }
  }, [app]);
  useEffect(() => {
    void load();
  }, [load]);

  const create = () =>
    run("create", async () => {
      const p = await api.post<Project>("/projects", { name: name.trim(), ...(idea.trim() ? { idea: idea.trim() } : {}), aspect });
      go(`#/p/${p.id}/script`);
    });

  const remove = (p: ProjectSummary) => {
    if (!window.confirm(`Delete "${p.name}"? Its media and exports are deleted for good.`)) return;
    void run(`del-${p.id}`, async () => {
      await api.del(`/projects/${p.id}`);
      await load();
    });
  };

  const account = app.config.account;
  const wallet = app.config.wallet;
  const empty = list !== null && list.length === 0;

  return (
    <div className="home">
      <section className="home-hero">
        <div>
          <p className="eyebrow">Your studio</p>
          <h1>{account ? `Welcome back, ${firstName(account.name)}` : "Your projects"}</h1>
          <p className="home-sub">
            {empty
              ? "Start your first episode. Name it, give it a one-line idea, and the script is written for you."
              : "Pick up where you left off, or start a new episode."}
          </p>
        </div>
        <div className="home-stats">
          {wallet && (
            <a className="stat-chip" href="/billing">
              <span>Credit</span>
              <strong>{money(wallet.balanceMicro)}</strong>
            </a>
          )}
          <div className="stat-chip">
            <span>Projects</span>
            <strong>{list === null ? "…" : list.length}</strong>
          </div>
        </div>
      </section>

      <div className="home-grid">
        <section className="home-main" aria-label="Projects">
          {list === null ? (
            <div className="project-grid">
              {[0, 1, 2].map((i) => (
                <div key={i} className="project-card skeleton" />
              ))}
            </div>
          ) : empty ? (
            <div className="welcome">
              <h2>How an episode comes together</h2>
              <ol className="welcome-steps">
                <li>
                  <span className="step-n">1</span>
                  <div>
                    <strong>Script and cast</strong>
                    <p>
                      Your idea becomes a script. Each character gets a reference portrait that keeps their face the same in every shot.
                    </p>
                  </div>
                </li>
                <li>
                  <span className="step-n">2</span>
                  <div>
                    <strong>Storyboard and drafts</strong>
                    <p>Every scene is split into shots. Try each one as a cheap draft and keep the ones you like.</p>
                  </div>
                </li>
                <li>
                  <span className="step-n">3</span>
                  <div>
                    <strong>Finals and the episode</strong>
                    <p>Render the approved shots in full quality and get the finished episode with subtitles.</p>
                  </div>
                </li>
              </ol>
              <p className="muted">
                Every button shows its exact price before you press it. <a href="/demo">See a finished example</a>
              </p>
            </div>
          ) : (
            <div className="project-grid">
              {list.map((p) => (
                <article key={p.id} className="project-card">
                  <a
                    className={`poster ${p.aspect === "16:9" ? "wide" : "tall"}`}
                    href={`#/p/${p.id}/script`}
                    aria-label={`Open ${p.name}`}
                  >
                    <span className="poster-title">{p.name}</span>
                    <span className="poster-format">{p.aspect === "16:9" ? "16:9" : "9:16"}</span>
                  </a>
                  <div className="project-info">
                    <a className="project-name" href={`#/p/${p.id}/script`}>
                      {p.name}
                    </a>
                    <p className="project-meta">
                      {plural(p.episodes, "episode")} · {plural(p.shots, "shot")} · {money(p.paidMicro)} spent
                    </p>
                    <p className="project-updated" title={when(p.updatedAt)}>
                      Updated {ago(p.updatedAt)}
                    </p>
                  </div>
                  <div className="project-actions">
                    <div className="spacer" />
                    <MoreMenu label={`More for ${p.name}`}>
                      <a role="menuitem" href={`/api/projects/${p.id}/export`}>
                        <Icon name="download" /> Export as .zip
                      </a>
                      <button
                        type="button"
                        role="menuitem"
                        className="danger-item"
                        onClick={() => remove(p)}
                        disabled={busy === `del-${p.id}`}
                      >
                        <Icon name="trash" /> Delete project
                      </button>
                    </MoreMenu>
                  </div>
                </article>
              ))}
            </div>
          )}
          <p className="muted small-text price-note">
            Prices shown are what you pay: {app.config.priceLabel.replace(/^Price you pay: /, "")}.
          </p>
        </section>

        <aside className="new-project" aria-label="New project">
          <h2>Start a new episode</h2>
          <form
            className="form"
            onSubmit={(e) => {
              e.preventDefault();
              if (name.trim()) void create();
            }}
          >
            <label>
              Project name
              <input value={name} onChange={(e) => setName(e.target.value)} maxLength={200} required placeholder="The Last Train" />
            </label>
            <label>
              <span>
                The idea <span className="muted">(optional)</span>
              </span>
              <textarea
                value={idea}
                onChange={(e) => setIdea(e.target.value)}
                rows={3}
                maxLength={4000}
                placeholder="A night conductor realises every passenger is someone she once let down."
              />
            </label>
            <fieldset className="format-pick">
              <legend>Format</legend>
              <button
                type="button"
                className={aspect === "9:16" ? "picked" : ""}
                aria-pressed={aspect === "9:16"}
                onClick={() => setAspect("9:16")}
              >
                <span className="frame tall" aria-hidden="true" />
                <span>
                  <strong>Vertical 9:16</strong>
                  <small>TikTok, Reels, Shorts</small>
                </span>
              </button>
              <button
                type="button"
                className={aspect === "16:9" ? "picked" : ""}
                aria-pressed={aspect === "16:9"}
                onClick={() => setAspect("16:9")}
              >
                <span className="frame wide" aria-hidden="true" />
                <span>
                  <strong>Wide 16:9</strong>
                  <small>YouTube, TV</small>
                </span>
              </button>
            </fieldset>
            <button type="submit" className="primary big-btn" disabled={!name.trim() || busy === "create"}>
              {busy === "create" ? <Spinner /> : null} Create project
            </button>
          </form>
        </aside>
      </div>
    </div>
  );
}
