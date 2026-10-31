import { useMemo, useState } from "react";
import { useProject } from "./ProjectView";
import { StatusBadge, shotLabel } from "./StoryboardTab";
import { Empty, When, modelLabel, money, plural, providerLabel, unitLabel, useApp } from "./ui";

const PURPOSE: Record<string, string> = {
  script: "Script",
  cast_extract: "Cast list",
  storyboard: "Storyboard",
  cast_image: "Cast image",
  frame: "First frame",
  video: "Video",
  tts: "Voice",
};

export function CostsTab() {
  const app = useApp();
  const { view } = useProject();
  const p = view.project;
  const [episode, setEpisode] = useState<string>("all");
  const lines = useMemo(() => {
    const all = [...view.costLog].sort((a, b) => b.at.localeCompare(a.at));
    if (episode === "all") return all;
    if (episode === "none") return all.filter((l) => !l.episodeId);
    return all.filter((l) => l.episodeId === episode);
  }, [view.costLog, episode]);
  const castName = (id: string | null) => (id ? (p.cast.find((c) => c.id === id)?.name ?? "removed") : "");
  const hasNotes = lines.some((l) => l.note);
  const refunded = view.costLog.filter((l) => l.status === "refunded");

  return (
    <div className="costs-tab">
      <div className="totals">
        <div className="stat">
          <span className="muted">Project total</span>
          <strong>{money(view.totals.paidMicro)}</strong>
          <span className="muted small-text">
            {plural(view.totals.tries, "charge")} · {view.totals.refunds} refunded
            {view.totals.pending ? ` · ${view.totals.pending} pending` : ""}
          </span>
        </div>
        {p.episodes.map((e, i) => {
          const t = view.episodeTotals[e.id];
          return (
            <div key={e.id} className="stat">
              <span className="muted">
                Episode {i + 1}: {e.title}
              </span>
              <strong>{money(t?.paidMicro ?? 0)}</strong>
              <span className="muted small-text">
                {plural(t?.tries ?? 0, "charge")} · {t?.refunds ?? 0} refunded
              </span>
            </div>
          );
        })}
        <div className="stat">
          <span className="muted">Refunded</span>
          <strong>{money(refunded.reduce((a, l) => a + l.estimatePaidMicro, 0))}</strong>
          <span className="muted small-text">{refunded.length} failed, not charged</span>
        </div>
      </div>

      <div className="row">
        <label className="inline-label">
          Show
          <select value={episode} onChange={(e) => setEpisode(e.target.value)}>
            <option value="all">Everything</option>
            {p.episodes.map((e, i) => (
              <option key={e.id} value={e.id}>
                Episode {i + 1}
              </option>
            ))}
            <option value="none">Not tied to an episode (cast, script)</option>
          </select>
        </label>
      </div>

      {lines.length === 0 ? (
        <Empty>Nothing spent yet.</Empty>
      ) : (
        <div className="table-wrap">
          <table className="table costs">
            <thead>
              <tr>
                <th>Time</th>
                <th>Purpose</th>
                <th>For</th>
                <th>Model</th>
                <th>Provider</th>
                <th>Tier</th>
                <th className="num">Units</th>
                <th className="num">Estimate</th>
                <th className="num">Paid</th>
                <th>Status</th>
                {hasNotes && <th>Note</th>}
              </tr>
            </thead>
            <tbody>
              {lines.map((l) => (
                <tr key={l.id} className={l.status === "refunded" ? "refunded" : ""}>
                  <td className="nowrap">
                    <When iso={l.at} />
                  </td>
                  <td>{PURPOSE[l.purpose] ?? l.purpose}</td>
                  <td className="muted">{l.shotId ? shotLabel(p, l.shotId) : castName(l.castId)}</td>
                  <td>{modelLabel(app.config, l.model)}</td>
                  <td>{providerLabel(l.provider)}</td>
                  <td>{l.tier === "final" ? "Final" : l.tier === "draft" ? "Draft" : ""}</td>
                  <td className="num nowrap">{unitLabel(l.units, l.unit)}</td>
                  <td className="num muted">{money(l.estimatePaidMicro)}</td>
                  <td className="num">
                    <strong>{money(l.paidMicro)}</strong>
                  </td>
                  <td>
                    <StatusBadge status={l.status} />
                  </td>
                  {hasNotes && <td className="muted">{l.note}</td>}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
