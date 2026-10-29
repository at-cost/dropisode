import { useEffect, useState } from "react";
import { type Episode, type View, api } from "./api";
import { useProject } from "./ProjectView";
import { Empty, Icon, Spinner, money, plural } from "./ui";

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

  const writing = isBusy("write");
  const pasting = isBusy("paste");

  return (
    <div className="script-tab">
      <div className="two-col">
        <section className="panel">
          <h2>Write from an idea</h2>
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
                if (r) setTitle("");
              });
            }}
          >
            <label>
              Idea
              <textarea
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
                {(scriptPrice ?? estimates?.script) != null && <span className="price">{money(scriptPrice ?? estimates!.script)}</span>}
              </button>
              {writing && <span className="muted">This can take a minute. It also lists the cast.</span>}
            </div>
          </form>
        </section>

        <section className="panel">
          <h2>Paste a script</h2>
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
                value={paste}
                onChange={(e) => setPaste(e.target.value)}
                rows={6}
                placeholder={"INT. KITCHEN - NIGHT\n\nMAYA\nYou came back."}
              />
            </label>
            <div className="row">
              <button type="submit" disabled={pasting}>
                {pasting && <Spinner />} {paste.trim() ? "Add episode" : "Add empty episode"}
              </button>
              {pasting && <span className="muted">Reading the script into scenes.</span>}
            </div>
          </form>
        </section>
      </div>

      <h2 className="section-title">Episodes</h2>
      {p.episodes.length === 0 ? (
        <Empty>No episodes yet.</Empty>
      ) : (
        p.episodes.map((ep, i) => <EpisodeEditor key={ep.id} ep={ep} n={i + 1} />)
      )}
    </div>
  );
}

function EpisodeEditor({ ep, n }: { ep: Episode; n: number }) {
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
      !window.confirm(`Re-reading replaces this episode's ${ep.scenes.length} scenes and ${shots} shots, including their takes. Continue?`)
    )
      return;
    if (dirty && !(await save())) return;
    await act(`parse-${ep.id}`, () => api.post<View>(`/projects/${pid}/episodes/${ep.id}/parse`));
  };
  const remove = () => {
    if (!window.confirm(`Delete "${ep.title}" with its scenes and shots?`)) return;
    void act(`del-${ep.id}`, () => api.del<View>(`/projects/${pid}/episodes/${ep.id}`));
  };
  const parsing = isBusy(`parse-${ep.id}`);

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
        <span className="muted">
          {plural(ep.scenes.length, "scene")}, {plural(shots, "shot")}, {money(spent)} spent
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
        <button type="button" className="primary" disabled={!dirty || isBusy(`save-${ep.id}`)} onClick={() => void save()}>
          {dirty ? "Save script" : "Saved"}
        </button>
        {dirty && (
          <button type="button" onClick={() => setText(ep.script)}>
            Undo changes
          </button>
        )}
        <button type="button" disabled={parsing || !text.trim()} onClick={() => void parse()}>
          {parsing && <Spinner />} {parsing ? "Reading" : "Re-read into scenes"}
        </button>
        <a className="btn" href={`#/p/${pid}/storyboard`}>
          Storyboard
        </a>
        <div className="spacer" />
        <button type="button" className="danger-text" onClick={remove}>
          <Icon name="trash" /> Delete episode
        </button>
      </div>
    </section>
  );
}
