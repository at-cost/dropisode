import { type CSSProperties, useCallback, useEffect, useState } from "react";
import { type Aspect, type Project, type ProjectSummary, api, mediaUrl } from "./api";
import { go } from "./App";
import { Icon, MoreMenu, Spinner, ago, money, plural, useApp, useBusy, when, Why } from "./ui";

/** A per-project gradient, so posters without a frame still look different. */
export function posterStyle(id: string): CSSProperties {
  let h = 2166136261;
  for (const ch of id) h = Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0;
  const pick = (shift: number, mod: number) => (h >>> shift) % mod;
  return {
    "--gx": `${15 + pick(0, 70)}%`,
    "--gy": `${pick(7, 40)}%`,
    "--rx": `${pick(13, 60)}%`,
    "--ry": `${60 + pick(19, 40)}%`,
    "--ga": `${120 + pick(25, 100)}deg`,
  } as CSSProperties;
}

/** A project's poster: its cover frame when it has one, otherwise its own gradient. */
export function Poster({ p }: { p: ProjectSummary }) {
  const wide = p.aspect === "16:9";
  return (
    <span className={`poster ${wide ? "wide" : "tall"}${p.coverMediaId ? " has-cover" : ""}`} style={posterStyle(p.id)}>
      {p.coverMediaId && <img className="poster-img" src={mediaUrl(p.id, p.coverMediaId)} alt="" loading="lazy" />}
      <span className="poster-title">{p.name}</span>
      <span className="poster-format">{wide ? "16:9" : "9:16"}</span>
    </span>
  );
}

/** The three steps, for a studio with no projects yet. */
export function WelcomeSteps() {
  return (
    <div className="welcome">
      <h2>How an episode comes together</h2>
      <ol className="welcome-steps">
        <li>
          <span className="step-n">1</span>
          <div>
            <strong>Script and cast</strong>
            <p>Your idea becomes a script. Each character gets a reference portrait that keeps their face the same in every shot.</p>
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
  );
}

export const firstName = (name: string) => name.trim().split(/\s+/)[0] ?? "";

export function Projects() {
  const app = useApp();
  const { busy, run } = useBusy();
  const [list, setList] = useState<ProjectSummary[] | null>(null);
  const [name, setName] = useState("");
  const [idea, setIdea] = useState("");
  const [aspect, setAspect] = useState<Aspect>("9:16");
  // On a phone the form folds into one button once there are projects.
  const [formOpen, setFormOpen] = useState(false);

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

  const remove = async (p: ProjectSummary) => {
    if (!(await app.confirm(`Delete "${p.name}"? Its media and exports are deleted for good.`, { ok: "Delete project", danger: true })))
      return;
    void run(`del-${p.id}`, async () => {
      await api.del(`/projects/${p.id}`);
      await load();
    });
  };

  const empty = list !== null && list.length === 0;

  return (
    <div className="home">
      <section className="home-hero">
        <div>
          <h1>Projects</h1>
          <p className="home-sub">
            {empty
              ? "Name your first project, give it a one-line idea, and the script is written for you."
              : "Every episode you are making."}
          </p>
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
            <WelcomeSteps />
          ) : (
            <div className="project-grid">
              {list.map((p) => (
                <article key={p.id} className={`project-card ${p.aspect === "16:9" ? "wide" : "tall"}`}>
                  <a className="poster-stage" href={`#/p/${p.id}/script`} aria-label={`Open ${p.name}`}>
                    <Poster p={p} />
                  </a>
                  <div className="project-info">
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
        </section>

        <aside className={`new-project${!empty && !formOpen ? " collapsible" : ""}`} aria-label="New project">
          <button type="button" className="primary new-toggle" onClick={() => setFormOpen(true)}>
            <Icon name="plus" /> New project
          </button>
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
              <input value={name} onChange={(e) => setName(e.target.value)} maxLength={200} required placeholder="e.g. Midnight Courier" />
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
            <div className="create-wrap">
              <button type="submit" className="primary solid big-btn" disabled={!name.trim() || busy === "create"}>
                {busy === "create" ? <Spinner /> : null} Create project
              </button>
              {!name.trim() && <Why>Name your project first</Why>}
            </div>
          </form>
        </aside>
      </div>
    </div>
  );
}
