import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { type Episode, type View, api } from "./api";
import { useProject } from "./ProjectView";
import { PLACEHOLDER_NAME } from "./progress";
import { Icon, Spinner, Ticket, Why, money, plural, useApp, useAutoGrow } from "./ui";

type StartMode = "ai" | "paste";
const MODE_KEY = "studio.newEpisodeMode";

function readMode(): StartMode {
  try {
    return localStorage.getItem(MODE_KEY) === "paste" ? "paste" : "ai";
  } catch {
    return "ai";
  }
}

export function ScriptTab() {
  const { pid, view, estimates, act, isBusy } = useProject();
  const p = view.project;
  const [idea, setIdea] = useState(p.idea);
  const [seconds, setSeconds] = useState(30);
  const [title, setTitle] = useState("");
  const [pasteTitle, setPasteTitle] = useState("");
  const [paste, setPaste] = useState("");

  // The script price depends on the length asked for.
  const [scriptPrice, setScriptPrice] = useState<number | null>(null);
  useEffect(() => {
    let live = true;
    const t = setTimeout(() => {
      api
        .get<{ script: number }>(`/projects/${pid}/estimates?targetSeconds=${seconds}`)
        .then((e) => live && setScriptPrice(e.script))
        .catch(() => {});
    }, 300);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [pid, seconds]);

  // A project started from the home idea box is renamed after the script's title.
  const adoptTitle = (r: View & { episodeId: string }) => {
    const t = r.project.episodes.find((e) => e.id === r.episodeId)?.title.trim();
    if (r.project.name === PLACEHOLDER_NAME && t && !/^Episode \d+$/i.test(t))
      void act("rename", () => api.patch<View>(`/projects/${pid}`, { name: t }));
  };
  const writing = isBusy("write");
  const pasting = isBusy("paste");
  const hasEpisodes = p.episodes.length > 0;
  const [adding, setAdding] = useState(false);
  const showNew = !hasEpisodes || adding || writing || pasting;
  const price = scriptPrice ?? estimates?.script;
  const [mode, setModeState] = useState<StartMode>(readMode);
  const setMode = (m: StartMode) => {
    setModeState(m);
    try {
      localStorage.setItem(MODE_KEY, m);
    } catch {}
  };
  const pasteRef = useAutoGrow(paste);
  const ideaRef = useAutoGrow(idea);
  // Whatever is running stays visible.
  const shown: StartMode = writing ? "ai" : pasting ? "paste" : mode;

  return (
    <div className="script-tab">
      {hasEpisodes && (
        <div className="section-head">
          <h2 className="section-title inline">Episodes</h2>
          <div className="spacer" />
          {!showNew && (
            <button type="button" onClick={() => setAdding(true)}>
              <Icon name="plus" /> New episode
            </button>
          )}
        </div>
      )}
      {hasEpisodes && p.episodes.map((ep, i) => <EpisodeEditor key={ep.id} ep={ep} n={i + 1} />)}

      {showNew && (
        <div className="new-episode">
          {hasEpisodes && (
            <div className="section-head">
              <h2 className="section-title inline">New episode</h2>
              <div className="spacer" />
              <button type="button" className="link" onClick={() => setAdding(false)}>
                Cancel
              </button>
            </div>
          )}
          <div className="mode-toggle">
            <button
              type="button"
              aria-pressed={shown === "ai"}
              className={shown === "ai" ? "on" : ""}
              disabled={writing || pasting}
              onClick={() => setMode("ai")}
            >
              Let AI write it
            </button>
            <button
              type="button"
              aria-pressed={shown === "paste"}
              className={shown === "paste" ? "on" : ""}
              disabled={writing || pasting}
              onClick={() => setMode("paste")}
            >
              Use your own script
            </button>
          </div>
          {shown === "ai" ? (
            <section className="panel">
              <h2>Let AI write it</h2>
              <p className="muted small-text choice-sub">Give a one-line idea. The script and the cast list are written for you.</p>
              <form
                className="form"
                onSubmit={(e) => {
                  e.preventDefault();
                  void act(
                    "write",
                    () =>
                      api.post<View & { episodeId: string }>(`/projects/${pid}/script`, {
                        idea: idea.trim(),
                        targetSeconds: seconds,
                        ...(title.trim() ? { title: title.trim() } : {}),
                      }),
                    { kick: true },
                  ).then((r) => {
                    if (r) {
                      setTitle("");
                      setAdding(false);
                      adoptTitle(r);
                    }
                  });
                }}
              >
                <label>
                  Idea
                  <textarea
                    ref={ideaRef}
                    value={idea}
                    onChange={(e) => setIdea(e.target.value)}
                    rows={4}
                    maxLength={4000}
                    placeholder="Who wants what, and what stands in the way"
                  />
                </label>
                <div className="row">
                  <label className="grow">
                    Episode title <span className="muted">(optional)</span>
                    <input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={300} />
                  </label>
                  <label className="w-num">
                    Length (s)
                    <input
                      type="number"
                      min={5}
                      max={600}
                      value={seconds}
                      onChange={(e) => setSeconds(Math.max(5, Math.min(600, Number(e.target.value) || 30)))}
                    />
                  </label>
                </div>
                <div className="row">
                  <button type="submit" className="primary" disabled={writing || idea.trim().length < 3}>
                    {writing ? <Spinner /> : null} {writing ? "Writing script" : "Write script"}
                    <Ticket micro={price} />
                  </button>
                  {writing ? (
                    <span className="muted small-text">Takes about a minute. It also lists the cast.</span>
                  ) : (
                    idea.trim().length < 3 && <Why>Add an idea first</Why>
                  )}
                </div>
              </form>
            </section>
          ) : (
            <section className="panel">
              <h2>Use your own script</h2>
              <p className="muted small-text choice-sub">Already have one? Paste it and it's split into scenes and cast for free.</p>
              <form
                className="form"
                onSubmit={(e) => {
                  e.preventDefault();
                  void act("paste", () =>
                    api.post<View & { episodeId: string }>(`/projects/${pid}/episodes`, {
                      script: paste,
                      ...(pasteTitle.trim() ? { title: pasteTitle.trim() } : {}),
                    }),
                  ).then((r) => {
                    if (r) {
                      setPaste("");
                      setPasteTitle("");
                      setAdding(false);
                      adoptTitle(r);
                    }
                  });
                }}
              >
                <label>
                  Episode title <span className="muted">(optional)</span>
                  <input value={pasteTitle} onChange={(e) => setPasteTitle(e.target.value)} maxLength={300} />
                </label>
                <label>
                  Script
                  <textarea
                    ref={pasteRef}
                    value={paste}
                    onChange={(e) => setPaste(e.target.value)}
                    rows={6}
                    placeholder={"INT. KITCHEN - NIGHT\n\nMAYA\nYou came back."}
                  />
                </label>
                <p className="muted small-text">Plain text. A CAST: list and SCENE headings work best.</p>
                <div className="row">
                  <button type="submit" className={paste.trim() ? "primary" : ""} disabled={pasting}>
                    {pasting && <Spinner />} {paste.trim() ? "Use this script" : "Start with a blank episode"}
                  </button>
                  {pasting && <span className="muted small-text">Reading the script into scenes.</span>}
                </div>
              </form>
            </section>
          )}
        </div>
      )}
    </div>
  );
}

function EpisodeEditor({ ep, n }: { ep: Episode; n: number }) {
  const app = useApp();
  const { pid, act, isBusy, view } = useProject();
  const [text, setText] = useState(ep.script);
  const [base, setBase] = useState(ep.script);
  if (ep.script !== base) {
    // The server copy changed: take it unless there are unsaved edits.
    if (text === base) setText(ep.script);
    setBase(ep.script);
  }
  const dirty = text !== ep.script;
  const shots = ep.scenes.reduce((a, s) => a + s.shots.length, 0);
  const spent = view.episodeTotals[ep.id]?.paidMicro ?? 0;

  const save = () => act(`save-${ep.id}`, () => api.patch<View>(`/projects/${pid}/episodes/${ep.id}`, { script: text }));
  const parse = async () => {
    if (
      ep.scenes.length > 0 &&
      !(await app.confirm(`Re-reading replaces this episode's ${ep.scenes.length} scenes and ${shots} shots, including their takes.`, {
        ok: "Re-read",
        danger: true,
      }))
    )
      return;
    if (dirty && !(await save())) return;
    await act(`parse-${ep.id}`, () => api.post<View>(`/projects/${pid}/episodes/${ep.id}/parse`));
  };
  const remove = async () => {
    if (!(await app.confirm(`Delete "${ep.title}" with its scenes and shots?`, { ok: "Delete episode", danger: true }))) return;
    void act(`del-${ep.id}`, () => api.del<View>(`/projects/${pid}/episodes/${ep.id}`));
  };
  const parsing = isBusy(`parse-${ep.id}`);
  const noScenes = ep.scenes.length === 0;

  return (
    <section className="panel episode-editor">
      <div className="panel-head">
        <span className="muted">Episode {n}</span>
        <input
          key={ep.title}
          className="title-input"
          defaultValue={ep.title}
          maxLength={300}
          aria-label="Episode title"
          onBlur={(e) => {
            const v = e.target.value.trim();
            if (v && v !== ep.title) void act(`title-${ep.id}`, () => api.patch<View>(`/projects/${pid}/episodes/${ep.id}`, { title: v }));
          }}
        />
        <div className="spacer" />
        <span className="muted small-text">
          {plural(ep.scenes.length, "scene")} · {plural(shots, "shot")} · {money(spent)} spent
        </span>
      </div>
      <textarea
        className="script-text"
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={Math.min(24, Math.max(8, text.split("\n").length + 1))}
        spellCheck
      />
      <div className="row">
        {dirty ? (
          <>
            <button type="button" className="primary" disabled={isBusy(`save-${ep.id}`)} onClick={() => void save()}>
              {isBusy(`save-${ep.id}`) && <Spinner />} Save script
            </button>
            <button type="button" onClick={() => setText(ep.script)}>
              Undo changes
            </button>
          </>
        ) : (
          <span className="status-text ok-text">
            <Icon name="check" size={12} /> Saved
          </span>
        )}
        <button
          type="button"
          className={noScenes && !dirty ? "primary" : ""}
          disabled={parsing || !text.trim()}
          onClick={() => void parse()}
        >
          {parsing && <Spinner />} {parsing ? "Reading" : noScenes ? "Read into scenes" : "Re-read into scenes"}
        </button>
        {!text.trim() && <Why>Write or paste a script first</Why>}
        <div className="spacer" />
        <button type="button" className="ghost-danger" onClick={remove}>
          <Icon name="trash" /> Delete episode
        </button>
        {!noScenes && (
          <a className={`btn ${dirty ? "" : "primary"} next-btn`} href={`#/p/${pid}/cast`}>
            Next: cast <span aria-hidden="true">→</span>
          </a>
        )}
      </div>
    </section>
  );
}
