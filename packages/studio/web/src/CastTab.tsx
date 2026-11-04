import { useRef, useState } from "react";
import { type CastKind, type CastMember, type View, api, mediaUrl } from "./api";
import { ModelsPanel } from "./ModelsPanel";
import { useProject } from "./ProjectView";
import { Empty, Icon, Spinner, Ticket, Why, useApp } from "./ui";

const KINDS: [CastKind, string, string][] = [
  ["character", "Characters", "Wardrobe, age, features, style"],
  ["location", "Locations", "Place, time of day, light, mood"],
  ["prop", "Props", "What it looks like, material, size"],
];

const KIND_LABEL: Record<CastKind, string> = { character: "Character", location: "Location", prop: "Prop" };

export function CastTab() {
  const { pid, view, act, isBusy } = useProject();
  const [kind, setKind] = useState<CastKind>("character");
  const [name, setName] = useState("");
  const cast = view.project.cast;
  const ready = cast.length > 0 && cast.every((c) => c.refImageIds.length > 0);

  return (
    <div className="cast-tab">
      <ModelsPanel only={["castImage"]} />
      <form
        className="add-cast row"
        onSubmit={(e) => {
          e.preventDefault();
          if (!name.trim()) return;
          void act("add-cast", () => api.post<View>(`/projects/${pid}/cast`, { kind, name: name.trim() })).then((r) => r && setName(""));
        }}
      >
        <select value={kind} onChange={(e) => setKind(e.target.value as CastKind)} aria-label="Kind">
          <option value="character">Character</option>
          <option value="location">Location</option>
          <option value="prop">Prop</option>
        </select>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Name" maxLength={120} aria-label="Name" />
        <button type="submit" disabled={!name.trim() || isBusy("add-cast")}>
          <Icon name="plus" /> Add
        </button>
        <div className="spacer" />
        {!ready && cast.length > 0 && <Why>Give everyone an image first</Why>}
        <a className={`btn next-btn${ready ? " primary" : ""}`} href={`#/p/${pid}/storyboard`}>
          Next: storyboard <span aria-hidden="true">→</span>
        </a>
      </form>
      {cast.length === 0 ? (
        <Empty>No cast yet. Writing a script lists the cast for you, or add someone above.</Empty>
      ) : (
        <div className="cast-grid">
          {KINDS.flatMap(([k, , hint]) => cast.filter((c) => c.kind === k).map((c) => <CastCard key={c.id} c={c} hint={hint} />))}
        </div>
      )}
    </div>
  );
}

function CastCard({ c, hint }: { c: CastMember; hint: string }) {
  const app = useApp();
  const { pid, view, estimates, act, isBusy } = useProject();
  // Consent is asked for each upload, then reset.
  const [asking, setAsking] = useState(false);
  const [consent, setConsent] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const generating = view.openJobs.some((j) => j.refs.castId === c.id) || isBusy(`gen-${c.id}`);
  const path = `/projects/${pid}/cast/${c.id}`;
  const patch = (body: Partial<CastMember>) => act(`patch-${c.id}`, () => api.patch<View>(path, body));

  const move = (i: number, d: number) => {
    const ids = [...c.refImageIds];
    const j = i + d;
    if (j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j]!, ids[i]!];
    void patch({ refImageIds: ids });
  };

  const upload = (file: File) => {
    const fd = new FormData();
    fd.append("file", file);
    fd.append("consent", consent ? "true" : "false");
    setAsking(false);
    setConsent(false);
    void act(`up-${c.id}`, () => api.raw<View>(`${path}/upload`, fd));
  };

  return (
    <div className={`card cast-card ${c.kind}`}>
      <span className="kind-chip">{KIND_LABEL[c.kind]}</span>
      <div className="cast-head">
        <input
          key={c.name}
          className="title-input"
          defaultValue={c.name}
          maxLength={120}
          aria-label="Name"
          onBlur={(e) => {
            const v = e.target.value.trim();
            if (v && v !== c.name) void patch({ name: v });
          }}
        />
        <button
          type="button"
          className="icon-btn"
          title="Delete"
          aria-label={`Delete ${c.name}`}
          onClick={async () => {
            if (await app.confirm(`Delete ${c.name}? Shots that feature them lose the link.`, { ok: "Delete", danger: true }))
              void act(`del-${c.id}`, () => api.del<View>(path));
          }}
        >
          <Icon name="trash" />
        </button>
      </div>
      <textarea
        key={c.description}
        defaultValue={c.description}
        rows={3}
        maxLength={4000}
        placeholder={hint}
        aria-label="Description"
        onBlur={(e) => {
          if (e.target.value !== c.description) void patch({ description: e.target.value });
        }}
      />
      <div className="refs">
        {c.refImageIds.map((id, i) => (
          <div key={id} className="ref">
            <a href={mediaUrl(pid, id)} target="_blank" rel="noreferrer">
              <img src={mediaUrl(pid, id)} alt={`${c.name} reference ${i + 1}`} loading="lazy" />
            </a>
            {i === 0 && <span className="ref-badge">Main</span>}
            <div className="ref-tools">
              <button type="button" aria-label="Move earlier" title="Move earlier" disabled={i === 0} onClick={() => move(i, -1)}>
                <Icon name="left" size={12} />
              </button>
              <button
                type="button"
                aria-label="Remove image"
                title="Remove image"
                onClick={() => void patch({ refImageIds: c.refImageIds.filter((x) => x !== id) })}
              >
                <Icon name="x" size={12} />
              </button>
              <button
                type="button"
                aria-label="Move later"
                title="Move later"
                disabled={i === c.refImageIds.length - 1}
                onClick={() => move(i, 1)}
              >
                <Icon name="right" size={12} />
              </button>
            </div>
          </div>
        ))}
        {generating && (
          <div className="ref placeholder">
            <Spinner />
          </div>
        )}
        {c.refImageIds.length === 0 && !generating && (
          <div className="ref empty-ref">
            <Icon name="image" size={22} />
            <span>No image yet</span>
          </div>
        )}
      </div>
      <div className="row wrap">
        <button
          type="button"
          className={c.refImageIds.length > 0 ? "" : "primary"}
          disabled={generating}
          onClick={() => void act(`gen-${c.id}`, () => api.post<View>(`${path}/generate`), { kick: true })}
        >
          {generating ? <Spinner /> : <Icon name="image" />}{" "}
          {generating ? "Generating" : c.refImageIds.length > 0 ? "Regenerate" : "Generate"}
          {!generating && <Ticket micro={estimates?.castImage} />}
        </button>
        <input
          ref={fileRef}
          type="file"
          accept="image/png,image/jpeg,image/webp"
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0];
            e.target.value = "";
            if (f) upload(f);
          }}
        />
        {!asking && (
          <button type="button" disabled={isBusy(`up-${c.id}`)} onClick={() => setAsking(true)}>
            {isBusy(`up-${c.id}`) ? <Spinner /> : <Icon name="upload" />} Upload
          </button>
        )}
      </div>
      {c.error && !generating && (
        <p className="danger-text small-text" role="alert">
          {c.error}
        </p>
      )}
      {asking && (
        <div className="consent">
          <label className="check">
            <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} /> Anyone real in this photo agreed to
            its use
          </label>
          <div className="row tight">
            <button type="button" className="small primary" disabled={!consent} onClick={() => fileRef.current?.click()}>
              <Icon name="upload" size={12} /> Choose photo
            </button>
            <button
              type="button"
              className="small link"
              onClick={() => {
                setAsking(false);
                setConsent(false);
              }}
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
