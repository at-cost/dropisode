import { useState } from "react";
import { api } from "./api";
import { Spinner, Why, useApp, useBusy } from "./ui";

const FFMPEG_FIX =
  "ffmpeg was not found. Install it (macOS: brew install ffmpeg; Windows: winget install ffmpeg; Linux: your package manager), or set REEL_FFMPEG to its path, then restart Dropisode.";

export function Settings() {
  const app = useApp();
  const { busy, run } = useBusy();
  const s = app.settings;
  const [key, setKey] = useState("");
  const [billing, setBilling] = useState("");

  const save = (k: string, body: Record<string, string | null>, done: string) =>
    run(k, async () => {
      await api.put("/local/settings", body);
      await app.refreshSettings();
      app.toast(done);
      setKey("");
      setBilling("");
    });

  if (!s) return <p className="muted">Loading settings</p>;

  return (
    <div className="page settings-page">
      <section className="panel narrow">
        <h2>fal.ai key</h2>
        {s.provider === "mock" && <p className="note">Test mode: no key is used and nothing is spent.</p>}
        <p className="muted">
          Generations run on fal.ai with your own key, at fal's price. The key is saved on this computer in <code>{s.configPath}</code> and
          never sent to the browser.
        </p>
        <p>
          Status: {s.hasKey ? <strong className="ok-text">Key saved ({s.keyHint})</strong> : <strong className="warn-text">No key</strong>}
        </p>
        <form
          className="form"
          onSubmit={(e) => {
            e.preventDefault();
            if (key.trim()) void save("key", { falKey: key.trim() }, "Key saved");
          }}
        >
          <label>
            {s.hasKey ? "Replace key" : "Key"}
            <input
              type="password"
              value={key}
              onChange={(e) => setKey(e.target.value)}
              autoComplete="off"
              placeholder="fal key id:secret"
            />
          </label>
          <div className="row">
            <button type="submit" className="primary" disabled={!key.trim() || busy === "key"}>
              {busy === "key" && <Spinner />} Save
            </button>
            {!key.trim() && <Why>Paste a key first</Why>}
            {s.hasKey && (
              <button
                type="button"
                className="danger-text"
                disabled={busy === "rmkey"}
                onClick={() => {
                  if (window.confirm("Remove your fal.ai key from this computer?")) void save("rmkey", { falKey: null }, "Key removed");
                }}
              >
                Remove
              </button>
            )}
          </div>
        </form>

        <h3>Billing key (optional)</h3>
        <p className="muted">An admin key lets Dropisode read what fal actually billed, instead of the published price.</p>
        <p>Status: {s.hasBillingKey ? <strong className="ok-text">Saved</strong> : <span className="muted">Not set</span>}</p>
        <form
          className="form"
          onSubmit={(e) => {
            e.preventDefault();
            if (billing.trim()) void save("bill", { falBillingKey: billing.trim() }, "Billing key saved");
          }}
        >
          <label>
            Billing key
            <input type="password" value={billing} onChange={(e) => setBilling(e.target.value)} autoComplete="off" />
          </label>
          <div className="row">
            <button type="submit" disabled={!billing.trim() || busy === "bill"}>
              Save
            </button>
            {s.hasBillingKey && (
              <button
                type="button"
                className="danger-text"
                onClick={() => void save("rmbill", { falBillingKey: null }, "Billing key removed")}
              >
                Remove
              </button>
            )}
          </div>
        </form>
      </section>

      <section className="panel narrow">
        <h2>This computer</h2>
        <dl className="facts">
          <dt>Projects folder</dt>
          <dd>
            <code>{s.projectsDir}</code>
            <div className="muted small-text">Start Dropisode with --dir to use another folder.</div>
          </dd>
          <dt>ffmpeg</dt>
          <dd>
            {s.ffmpeg ? (
              <>
                <span className="ok-text">Found</span> <code>{s.ffmpeg.path}</code>
                {!s.ffmpeg.subtitles && (
                  <div className="warn-text">This ffmpeg can't burn in subtitles (no libass). Episodes come with a separate .srt file.</div>
                )}
              </>
            ) : (
              <div className="warn-text">{FFMPEG_FIX}</div>
            )}
          </dd>
        </dl>
      </section>
    </div>
  );
}
