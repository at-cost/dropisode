import { type CatalogEntry, type ProjectModels, type View, api } from "./api";
import { useProject } from "./ProjectView";
import { money, useApp } from "./ui";

type Slot = keyof ProjectModels;

const SLOTS: { key: Slot; label: string; kind: "video" | "image"; tier?: "draft" | "final"; hint: string }[] = [
  { key: "draftVideo", label: "Draft video", kind: "video", tier: "draft", hint: "Cheap tries while you get a shot right." },
  { key: "finalVideo", label: "Final video", kind: "video", tier: "final", hint: "The take that goes in the episode." },
  { key: "image", label: "First frames", kind: "image", hint: "The still each shot starts from, and the scene still." },
  { key: "castImage", label: "Cast pictures", kind: "image", hint: "Each character, place and prop." },
];

function priceText(m: CatalogEntry): string {
  const p = m.audioUnitPaidMicro ?? m.unitPaidMicro;
  if (p == null) return "";
  const per = m.unit === "second" ? "/s" : m.unit === "image" ? " per image" : m.unit === "video" ? " per clip" : "";
  return `${money(p)}${per}`;
}

/** Which model each step uses: every model we offer, with the recommended one marked. */
export function ModelsPanel({ only }: { only?: Slot[] }) {
  const { pid, view, act } = useProject();
  const { config } = useApp();
  const all = config.models ?? [];
  const chosen = view.project.models ?? {};
  const rec: Record<Slot, string | undefined> = {
    draftVideo: config.defaults?.draft?.video,
    finalVideo: config.defaults?.final?.video,
    image: config.defaults?.draft?.image,
    castImage: config.defaults?.castImage,
  };
  const slots = SLOTS.filter((s) => !only || only.includes(s.key));
  const label = (id?: string) => all.find((m) => m.id === id)?.label ?? id ?? "";
  const summary = slots.map((s) => `${s.label}: ${label(chosen[s.key] ?? rec[s.key])}`).join(" · ");
  const save = (key: Slot, id: string) =>
    void act(`models-${key}`, () => api.patch<View>(`/projects/${pid}`, { models: { [key]: id === rec[key] ? null : id } }));
  return (
    <details className="models-panel">
      <summary>
        <span className="models-title">Models</span> <span className="muted">{summary}</span>
      </summary>
      <div className="models-grid">
        {slots.map((s) => {
          const options = all.filter((m) => m.kind === s.kind && (!s.tier || m.tiers?.includes(s.tier)));
          const value = chosen[s.key] ?? rec[s.key] ?? "";
          return (
            <label key={s.key} className="models-field">
              <span>{s.label}</span>
              <select value={value} onChange={(e) => save(s.key, e.target.value)}>
                {options.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.label}
                    {m.id === rec[s.key] ? " (recommended)" : ""}
                    {priceText(m) ? ` · ${priceText(m)}` : ""}
                    {s.kind === "video" && m.nativeAudio ? " · sound" : ""}
                  </option>
                ))}
              </select>
              <small className="muted">{s.hint}</small>
            </label>
          );
        })}
      </div>
    </details>
  );
}
