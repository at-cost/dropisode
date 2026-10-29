import { useCallback, useEffect, useRef, useState } from "react";
import { type Aspect, type Project, type ProjectSummary, api } from "./api";
import { go } from "./App";
import { Empty, Icon, Spinner, money, useApp, useBusy } from "./ui";

export function Projects() {
  const app = useApp();
  const { busy, run } = useBusy();
  const [list, setList] = useState<ProjectSummary[] | null>(null);
  const [name, setName] = useState("");
  const [idea, setIdea] = useState("");
  const [aspect, setAspect] = useState<Aspect>("9:16");
  const fileRef = useRef<HTMLInputElement>(null);

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

  const importZip = (file: File) =>
    run("import", async () => {
      const p = await api.raw<Project>("/projects/import", file);
      app.toast(`Imported "${p.name}"`);
      await load();
    });

  const remove = (p: ProjectSummary) => {
    if (!window.confirm(`Delete "${p.name}"? Its folder, media and exports are deleted for good.`)) return;
    void run(`del-${p.id}`, async () => {
      await api.del(`/projects/${p.id}`);
      await load();
    });
  };

  return (
    <div className="page projects-page">
      <section className="panel">
        <div className="panel-head">
          <h2>Projects</h2>
          <div className="spacer" />
          <input
            ref={fileRef}
            type="file"
            accept=".zip,application/zip"
            hidden
            onChange={(e) => {
              const f = e.target.files?.[0];
              e.target.value = "";
              if (f) void importZip(f);
            }}
          />
          <button type="button" onClick={() => fileRef.current?.click()} disabled={busy === "import"}>
            {busy === "import" ? <Spinner /> : <Icon name="upload" />} Import .zip
          </button>
        </div>
        {list === null ? (
          <Empty>Loading</Empty>
        ) : list.length === 0 ? (
          <Empty>No projects yet. Start one on the right.</Empty>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Format</th>
                <th className="num">Episodes</th>
                <th className="num">Shots</th>
                <th className="num">Spent</th>
                <th>Updated</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {list.map((p) => (
                <tr key={p.id}>
                  <td>
                    <a href={`#/p/${p.id}/script`}>
                      <strong>{p.name}</strong>
                    </a>
                  </td>
                  <td>{p.aspect}</td>
                  <td className="num">{p.episodes}</td>
                  <td className="num">{p.shots}</td>
                  <td className="num">{money(p.paidMicro)}</td>
                  <td className="muted">{new Date(p.updatedAt).toLocaleString()}</td>
                  <td className="actions">
                    <a className="btn small" href={`/api/projects/${p.id}/export`}>
                      <Icon name="download" /> Export
                    </a>
                    <button type="button" className="small danger-text" onClick={() => remove(p)} disabled={busy === `del-${p.id}`}>
                      <Icon name="trash" /> Delete
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <p className="muted small-text">Money shown: {app.config.priceLabel}</p>
      </section>

      <section className="panel narrow">
        <h2>New project</h2>
        <form
          className="form"
          onSubmit={(e) => {
            e.preventDefault();
            if (name.trim()) void create();
          }}
        >
          <label>
            Name
            <input value={name} onChange={(e) => setName(e.target.value)} maxLength={200} required placeholder="The Last Train" />
          </label>
          <label>
            Idea <span className="muted">(optional)</span>
            <textarea
              value={idea}
              onChange={(e) => setIdea(e.target.value)}
              rows={4}
              maxLength={4000}
              placeholder="A one or two line logline"
            />
          </label>
          <fieldset className="radio-row">
            <legend>Format</legend>
            <label>
              <input type="radio" name="aspect" checked={aspect === "9:16"} onChange={() => setAspect("9:16")} /> 9:16 vertical
            </label>
            <label>
              <input type="radio" name="aspect" checked={aspect === "16:9"} onChange={() => setAspect("16:9")} /> 16:9 wide
            </label>
          </fieldset>
          <button type="submit" className="primary" disabled={!name.trim() || busy === "create"}>
            {busy === "create" && <Spinner />} Create project
          </button>
        </form>
      </section>
    </div>
  );
}
