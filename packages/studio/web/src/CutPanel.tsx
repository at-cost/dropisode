import { FPS, MIN_KEEP_F, framesTo, latestInS, planCut, takeOutS } from "@reel/core/cut";
import { type KeyboardEvent, type PointerEvent, useEffect, useMemo, useRef, useState } from "react";
import { type Episode, type Shot, type Take, type View, api, mediaUrl } from "./api";
import { useProject } from "./ProjectView";
import { Spinner } from "./ui";

const FRAME = 1 / FPS;
/** How wide a second of video is drawn on the strip. */
const PX = 46;

const r2 = (x: number) => Math.round(x * 100) / 100;
const secs = (x: number) => `${x.toFixed(x < 10 ? 2 : 1)} s`;

interface Clip {
  shot: Shot;
  take: Take;
  /** Scene and shot numbers, for labels. */
  scene: number;
  n: number;
  /** The clip's whole length. */
  len: number;
  /** The part the edit keeps, on whole frames, exactly as the assembly cuts it. */
  inS: number;
  outS: number;
  inF: number;
  outF: number;
  lengthS: number;
  /** Seconds this take dissolves in over the one before. */
  dissolveS: number;
  /** The cut the studio would make (s), and the frames it comes to. */
  sugIn: number;
  sugOut: number;
  sugInF: number;
  sugOutF: number;
  /** Not measured yet: its length is the shot's until it is. */
  unmeasured: boolean;
  /** It was made from the last frame of the shot before, so its first frame repeats that one. */
  chained: boolean;
  /** A later shot was made to start on this take's last frame. */
  next?: string;
}

type TakeEdit = { inS?: number | null; outS?: number | null };

/** The episode with edits still on their way to the server laid over it, applied as the server will apply them. */
function withEdits(ep: Episode, edits: Record<string, TakeEdit>): Episode {
  if (Object.keys(edits).length === 0) return ep;
  const apply = (t: Take, shot: Shot): Take => {
    const e = edits[t.id];
    if (!e) return t;
    const n: Take = { ...t };
    const len = t.analysis?.durationS;
    if (e.outS === null) {
      if (len) n.outS = len;
      else delete n.outS;
    } else if (e.outS !== undefined) n.outS = len ? Math.min(e.outS, len) : e.outS;
    if (e.inS === null || e.inS === 0) delete n.inS;
    else if (e.inS !== undefined) n.inS = e.inS;
    if (n.inS !== undefined) {
      const latest = latestInS(takeOutS(n, shot));
      if (Math.round(n.inS * FPS) > Math.round(latest * FPS)) {
        if (latest > 0) n.inS = latest;
        else delete n.inS;
      }
    }
    return n;
  };
  return {
    ...ep,
    scenes: ep.scenes.map((sc) => ({ ...sc, shots: sc.shots.map((sh) => ({ ...sh, takes: sh.takes.map((t) => apply(t, sh)) })) })),
  };
}

/** The episode as the next assembly will cut it: the final takes once every shot has one, else the rough cut. */
function clipsOf(ep: Episode, hidden: Set<string>): { clips: Clip[]; totalS: number; source: "final" | "rough" } {
  const shots = ep.scenes.flatMap((s) => s.shots);
  const allFinal =
    shots.length > 0 && shots.every((s) => s.approved && s.takes.some((t) => t.tier === "final" && t.status === "done" && t.videoMediaId));
  const source = allFinal ? "final" : "rough";
  const plan = planCut(ep, source, { usable: (t) => !hidden.has(t.videoMediaId ?? "") });
  const where = new Map(ep.scenes.flatMap((sc, si) => sc.shots.map((sh, i) => [sh.id, { si, i, sc }] as const)));
  const clips = plan.shots
    // A cutaway laid over the shot before it adds no time and is cut by its own settings.
    .filter((p) => !p.overShotId)
    .map((p): Clip => {
      const { si, i, sc } = where.get(p.shot.id)!;
      const take = p.take;
      const len = take.analysis?.durationS ?? p.shot.durationS;
      const after = sc.shots[i + 1];
      const next = after?.continueFromPrevious && after.takes.length > 0 ? `Shot ${i + 2}` : undefined;
      const chained = !!p.shot.continueFromPrevious && i > 0;
      const inS = p.inF / FPS;
      const outS = p.outF / FPS;
      // A shot that continues from the last one opens on the very frame that one ended on: drop it.
      const wantIn = Math.max(take.analysis?.suggestedInS ?? 0, chained ? FRAME : 0);
      // Never suggest moving an end a later shot was made to start from: that shot would jump.
      const sugOut = next ? outS : Math.min(take.analysis?.suggestedOutS ?? len, len);
      const sugOutF = framesTo(sugOut);
      const sugInF = sugOutF - Math.round(wantIn * FPS) >= MIN_KEEP_F ? Math.round(wantIn * FPS) : 0;
      return {
        shot: p.shot,
        take,
        scene: si + 1,
        n: i + 1,
        len,
        inS,
        outS,
        inF: p.inF,
        outF: p.outF,
        lengthS: p.lengthF / FPS,
        dissolveS: p.dissolveF / FPS,
        chained,
        sugIn: sugInF / FPS,
        sugOut,
        sugInF,
        sugOutF,
        unmeasured: !take.analysis,
        ...(next ? { next } : {}),
      };
    });
  return { clips, totalS: plan.totalF / FPS, source };
}

/** Compared in whole frames: what the edit would actually keep. */
const inDiffers = (c: Clip) => c.inF !== c.sugInF;
const outDiffers = (c: Clip) => c.outF !== c.sugOutF;
const differs = (c: Clip) => inDiffers(c) || outDiffers(c);

/**
 * The cut: every take on one strip, with where the edit starts and ends it, how it joins the take before,
 * and what the studio would do. The total is worked out exactly as the assembly does it.
 */
export function CutPanel({ ep }: { ep: Episode }) {
  const { pid, view, act, isBusy } = useProject();
  const hidden = useMemo(() => new Set(view.project.media.filter((m) => m.hidden).map((m) => m.id)), [view.project.media]);
  // Edits sent but not yet answered: shown at once, and sent one at a time per take, so quick edits build on each other.
  const [edits, setEdits] = useState<Record<string, TakeEdit>>({});
  const queue = useRef(new Map<string, { last: Promise<unknown>; open: number }>());
  const shown = useMemo(() => withEdits(ep, edits), [ep, edits]);
  const { clips, totalS, source } = useMemo(() => clipsOf(shown, hidden), [shown, hidden]);
  const [selId, setSelId] = useState<string | null>(null);
  const [applying, setApplying] = useState(false);
  const video = useRef<HTMLVideoElement>(null);
  const stopAt = useRef<number | null>(null);
  const seekOnLoad = useRef<number | null>(null);
  const wide = view.project.aspect === "16:9";

  if (clips.length === 0) return null;
  const sel = clips.find((c) => c.shot.id === selId) ?? clips[0]!;
  const pending = clips.filter(differs);

  const patchTake = (c: Clip, body: TakeEdit) => {
    const id = c.take.id;
    setEdits((e) => ({ ...e, [id]: { ...e[id], ...body } }));
    const q = queue.current.get(id) ?? { last: Promise.resolve(), open: 0 };
    q.open++;
    q.last = q.last
      .then(() => act(`cut-${id}`, () => api.patch<View>(`/projects/${pid}/shots/${c.shot.id}/takes/${id}`, body)))
      .finally(() => {
        if (--q.open > 0) return;
        queue.current.delete(id);
        setEdits(({ [id]: _, ...rest }) => rest);
      });
    queue.current.set(id, q);
    return q.last;
  };
  const patchShot = (c: Clip, body: Partial<Pick<Shot, "joinIn" | "joinS" | "move">>) =>
    act(`join-${c.shot.id}`, () => api.patch<View>(`/projects/${pid}/shots/${c.shot.id}`, body));
  const patchEp = (body: Partial<Pick<Episode, "fadeInS" | "fadeOutS" | "soundLead">>) =>
    act("cut-ep", () => api.patch<View>(`/projects/${pid}/episodes/${ep.id}`, body));
  // Only the ends that differ: a suggestion never nudges an end already on the right frame.
  const suggested = (c: Clip) => patchTake(c, { ...(inDiffers(c) ? { inS: c.sugIn } : {}), ...(outDiffers(c) ? { outS: c.sugOut } : {}) });

  const applyAllSuggested = async () => {
    setApplying(true);
    try {
      for (const c of pending) await suggested(c);
    } finally {
      setApplying(false);
    }
  };

  const show = (c: Clip, at: number) => {
    setSelId(c.shot.id);
    stopAt.current = null;
    const v = video.current;
    if (v && sel.shot.id === c.shot.id) {
      v.pause();
      v.currentTime = Math.max(0, Math.min(at, c.len - 0.02));
    } else seekOnLoad.current = at;
  };
  const playKept = () => {
    const v = video.current;
    if (!v) return;
    v.currentTime = sel.inS;
    stopAt.current = sel.outS;
    void v.play().catch(() => {});
  };
  const first = sel === clips[0];

  return (
    <section className="panel cut-panel">
      <div className="cut-head">
        <h2>Cut</h2>
        <span className="cut-total">
          {clips.some((c) => c.unmeasured) ? "About " : ""}
          <strong data-total={totalS}>{secs(totalS)}</strong> from {clips.length} {clips.length === 1 ? "take" : "takes"}
          {source === "final" ? ", final takes" : ""}
        </span>
        <button type="button" disabled={pending.length === 0 || applying} onClick={() => void applyAllSuggested()}>
          {applying && <Spinner />} Use the suggested cuts{pending.length > 0 ? ` (${pending.length})` : ""}
        </button>
      </div>
      <p className="muted small-text">
        Drag the ends of a take to choose where the edit starts and ends it. A dot means the studio suggests a different cut. Cutting is
        free, and the next assembly uses it.
      </p>
      <div className="cut-legend muted small-text" aria-hidden="true">
        <span>
          <i className="cut-key hold" /> Holds still
        </span>
        <span>
          <i className="cut-key jump" /> May jump
        </span>
        <span>
          <i className="cut-key dot" /> Suggested cut differs
        </span>
      </div>

      <ul className="cut-strip">
        {clips.map((c, i) => (
          <li key={c.shot.id} className="cut-item">
            {i > 0 && (
              <button
                type="button"
                className={`cut-join ${c.shot.joinIn === "dissolve" ? "on" : ""}`}
                title={c.shot.joinIn === "dissolve" ? "Dissolve. Click for a straight cut." : "Straight cut. Click to dissolve."}
                aria-label={`Into scene ${c.scene}, shot ${c.n}: ${c.shot.joinIn === "dissolve" ? "dissolve" : "straight cut"}`}
                aria-pressed={c.shot.joinIn === "dissolve"}
                disabled={isBusy(`join-${c.shot.id}`)}
                onClick={() => void patchShot(c, { joinIn: c.shot.joinIn === "dissolve" ? "cut" : "dissolve" })}
              >
                {c.shot.joinIn === "dissolve" ? <DissolveMark /> : <CutMark />}
                <span>{c.shot.joinIn === "dissolve" ? secs(c.dissolveS) : "Cut"}</span>
              </button>
            )}
            <ClipBlock
              pid={pid}
              c={c}
              wide={wide}
              selected={sel.shot.id === c.shot.id}
              onSelect={() => show(c, c.inS)}
              onScrub={(at) => show(c, at)}
              onCommit={(body) => void patchTake(c, body)}
            />
          </li>
        ))}
      </ul>

      <div className="cut-detail">
        <video
          ref={video}
          key={sel.take.id}
          className={`cut-preview ${wide ? "wide" : "tall"}`}
          src={mediaUrl(pid, sel.take.videoMediaId!)}
          controls
          playsInline
          preload="auto"
          onLoadedMetadata={(e) => {
            e.currentTarget.currentTime = seekOnLoad.current ?? sel.inS;
            seekOnLoad.current = null;
          }}
          onTimeUpdate={(e) => {
            if (stopAt.current !== null && e.currentTarget.currentTime >= stopAt.current) {
              e.currentTarget.pause();
              stopAt.current = null;
            }
          }}
        />
        <div className="cut-fields">
          <h3>
            Scene {sel.scene}, shot {sel.n} <span className="status-chip">{sel.take.tier}</span>
          </h3>
          <p className="muted small-text cut-desc">{sel.shot.description}</p>
          <div className="cut-nums">
            <NumField
              label="Starts at (s)"
              value={sel.inS}
              min={0}
              max={latestInS(sel.outS)}
              onSave={(v) => void patchTake(sel, { inS: v })}
              key={`in-${sel.take.id}-${sel.inS}`}
            />
            <NumField
              label="Ends at (s)"
              value={sel.outS}
              min={(sel.inF + MIN_KEEP_F) / FPS}
              max={sel.len}
              onSave={(v) => void patchTake(sel, { outS: v })}
              key={`out-${sel.take.id}-${sel.outS}`}
            />
            <span className="muted small-text cut-keeps">
              Keeps {secs(sel.lengthS)} of {secs(sel.len)}
            </span>
          </div>
          <div className="row">
            <button type="button" onClick={playKept}>
              Play the kept part
            </button>
            {differs(sel) && (
              <button type="button" className="link-btn" onClick={() => void suggested(sel)}>
                Use the suggested cut ({r2(sel.sugIn)} to {r2(sel.sugOut)} s)
              </button>
            )}
            {(sel.inS > 0 || sel.outS < sel.len - FRAME) && (
              <button type="button" className="link-btn" onClick={() => void patchTake(sel, { inS: null, outS: null })}>
                Use the whole clip
              </button>
            )}
          </div>
          <Findings c={sel} />
          <div className="cut-nums">
            <label className="insp-field">
              <span>Camera move added in the edit</span>
              <select value={sel.shot.move ?? "none"} onChange={(e) => void patchShot(sel, { move: e.target.value as Shot["move"] })}>
                <option value="none">None</option>
                <option value="push-in">Slow push in</option>
                <option value="pull-out">Slow pull out</option>
              </select>
            </label>
            {!first && (
              <label className="insp-field">
                <span>Comes in with</span>
                <select
                  value={sel.shot.joinIn ?? "cut"}
                  onChange={(e) => void patchShot(sel, { joinIn: e.target.value as Shot["joinIn"] })}
                >
                  <option value="cut">A straight cut</option>
                  <option value="dissolve">A dissolve</option>
                </select>
              </label>
            )}
            {!first && sel.shot.joinIn === "dissolve" && (
              <NumField
                label="Dissolve length (s)"
                value={sel.shot.joinS ?? 0.5}
                min={0.2}
                max={2}
                onSave={(v) => void patchShot(sel, { joinS: v })}
                key={`js-${sel.shot.id}-${sel.shot.joinS}`}
              />
            )}
          </div>
          {!first && sel.shot.joinIn === "dissolve" && Math.abs(sel.dissolveS - (sel.shot.joinS ?? 0.5)) > FRAME / 2 && (
            <p className="muted small-text">
              {sel.dissolveS > 0
                ? `Runs ${secs(sel.dissolveS)}: a dissolve takes at most half of either take.`
                : "These takes are too short to dissolve: they cut."}
            </p>
          )}
        </div>
      </div>

      <div className="cut-ends">
        <label className="insp-field">
          <span>Fade in at the start</span>
          <select value={ep.fadeInS ?? 0} onChange={(e) => void patchEp({ fadeInS: Number(e.target.value) })}>
            {options(ep.fadeInS ?? 0, [0, 0.5, 1, 1.5, 2])}
          </select>
        </label>
        <label className="insp-field">
          <span>Fade to black at the end</span>
          <select value={ep.fadeOutS ?? 0} onChange={(e) => void patchEp({ fadeOutS: Number(e.target.value) })}>
            {options(ep.fadeOutS ?? 0, [0, 0.5, 1, 1.5, 2, 3])}
          </select>
        </label>
        <label className="insp-field">
          <span>What leads the sound</span>
          <select value={ep.soundLead ?? "voices"} onChange={(e) => void patchEp({ soundLead: e.target.value as Episode["soundLead"] })}>
            <option value="voices">Voices: music dips under them</option>
            <option value="music">Music: for episodes with no talking</option>
          </select>
        </label>
        {ep.soundLead === "music" && ep.music?.status !== "done" && (
          <span className="muted small-text">Make the music below first: until then the clips keep their own sound.</span>
        )}
      </div>
    </section>
  );
}

/** Fade lengths, keeping a value set some other way (the API takes any up to 5 s). */
function options(now: number, list: number[]) {
  const all = list.includes(now) ? list : [...list, now].sort((a, b) => a - b);
  return all.map((v) => (
    <option key={v} value={v}>
      {v === 0 ? "None" : `${v} s`}
    </option>
  ));
}

/** What the studio noticed in a take, and what moving its end would break. */
function Findings({ c }: { c: Clip }) {
  const a = c.take.analysis;
  const jumps = (a?.jumps ?? []).filter((j) => j > c.inS && j < c.outS);
  return (
    <>
      {a?.suggestedInS !== undefined && c.inS < a.suggestedInS - FRAME / 2 && (
        <p className="note small-text">Holds its first frame until {r2(a.suggestedInS)} s: starting there avoids a pause.</p>
      )}
      {c.chained && c.inS < FRAME / 2 && (
        <p className="note small-text">Opens on the frame the last shot ended on. Starting one frame in removes the repeat.</p>
      )}
      {a?.stallFromS !== undefined && c.outS > a.stallFromS + 0.15 && (
        <p className="note small-text">Slows to a near stop from {r2(a.stallFromS)} s: ending there avoids a pause.</p>
      )}
      {jumps.length > 0 && (
        <p className="note warn small-text">
          Possible jump at {jumps.map((j) => `${r2(j)} s`).join(", ")}: the video model may have cut or snapped here. Cut around it, or
          remake the shot.
        </p>
      )}
      {c.next && (
        <p className="note warn small-text">
          {c.next} was made to start on this take's last frame. If you move the end, remake {c.next.toLowerCase()} or it will jump.
        </p>
      )}
    </>
  );
}

function NumField({ label, value, min, max, onSave }: { label: string; value: number; min: number; max: number; onSave(v: number): void }) {
  return (
    <label className="insp-field cut-num">
      <span>{label}</span>
      <input
        type="number"
        inputMode="decimal"
        min={r2(min)}
        max={r2(max)}
        step="any"
        defaultValue={r2(value)}
        onBlur={(e) => {
          const v = Number(e.target.value);
          if (e.target.value.trim() && Number.isFinite(v) && Math.abs(v - value) > 0.004) onSave(Math.min(max, Math.max(min, v)));
          else e.target.value = String(r2(value));
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur();
        }}
      />
    </label>
  );
}

/** One take on the strip: its frames, the part the edit keeps, and the ends to drag. */
function ClipBlock({
  pid,
  c,
  wide,
  selected,
  onSelect,
  onScrub,
  onCommit,
}: {
  pid: string;
  c: Clip;
  wide: boolean;
  selected: boolean;
  onSelect(): void;
  onScrub(at: number): void;
  onCommit(body: { inS?: number; outS?: number }): void;
}) {
  const H = wide ? 72 : 104;
  const tw = Math.round(wide ? (H * 16) / 9 : (H * 9) / 16);
  const W = Math.max(tw, Math.round(c.len * PX));
  const canvas = useRef<HTMLCanvasElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<{ inS: number; outS: number } | null>(null);
  // The latest drag, read on release (state may not have rendered yet).
  const dragRef = useRef<{ inS: number; outS: number } | null>(null);
  // Where on the handle it was grabbed (s), so it doesn't jump to the pointer.
  const grab = useRef(0);
  const inS = drag?.inS ?? c.inS;
  const outS = drag?.outS ?? c.outS;
  const url = mediaUrl(pid, c.take.videoMediaId!);

  // The frames along the clip, drawn by stepping a hidden player through it.
  useEffect(() => {
    const cv = canvas.current;
    if (!cv) return;
    const scale = Math.min(2, window.devicePixelRatio || 1);
    cv.width = W * scale;
    cv.height = H * scale;
    const ctx = cv.getContext("2d");
    if (!ctx) return;
    const v = document.createElement("video");
    v.muted = true;
    v.playsInline = true;
    v.preload = "auto";
    let dead = false;
    const n = Math.ceil(W / tw);
    const step = async () => {
      for (let i = 0; i < n && !dead; i++) {
        const at = Math.min(Math.max(0, c.len - 0.05), ((i + 0.5) * tw) / PX);
        await new Promise<void>((res) => {
          const done = () => {
            v.removeEventListener("seeked", done);
            res();
          };
          v.addEventListener("seeked", done);
          v.currentTime = at;
          setTimeout(done, 1500);
        });
        if (dead) return;
        try {
          // Cover the tile, cropping the middle, so a clip of another shape still fills it.
          const vw = v.videoWidth || tw;
          const vh = v.videoHeight || H;
          const k = Math.max(tw / vw, H / vh);
          const sw = tw / k;
          const sh = H / k;
          ctx.drawImage(v, (vw - sw) / 2, (vh - sh) / 2, sw, sh, i * tw * scale, 0, tw * scale, H * scale);
        } catch {}
      }
    };
    v.addEventListener("loadeddata", () => void step(), { once: true });
    v.src = url;
    return () => {
      dead = true;
      v.removeAttribute("src");
      v.load();
    };
  }, [url, W, H, tw, c.len]);

  /** The clip time under the pointer; unclamped, since the handles sit just outside the frames. */
  const rawAt = (clientX: number) => {
    const rect = box.current!.getBoundingClientRect();
    return ((clientX - rect.left) / rect.width) * c.len;
  };
  const timeAt = (clientX: number) => Math.min(c.len, Math.max(0, rawAt(clientX)));
  const snap = (x: number) => Math.round(x * FPS) / FPS;
  const move = (which: "in" | "out", at: number) => {
    const now = dragRef.current ?? { inS, outS };
    const next =
      which === "in"
        ? { inS: snap(Math.min(at, now.outS - 0.5)), outS: now.outS }
        : { inS: now.inS, outS: snap(Math.max(at, now.inS + 0.5)) };
    next.inS = Math.max(0, next.inS);
    next.outS = Math.min(c.len, next.outS);
    dragRef.current = next;
    setDrag(next);
    onScrub(which === "in" ? next.inS : Math.max(next.inS, next.outS - FRAME));
    return next;
  };
  const commit = () => {
    const d = dragRef.current;
    dragRef.current = null;
    setDrag(null);
    if (!d) return;
    // Only the end that moved, so it can't undo an edit to the other end still on its way.
    const body = {
      ...(Math.round(d.inS * FPS) !== c.inF ? { inS: d.inS } : {}),
      ...(framesTo(d.outS) !== c.outF ? { outS: d.outS } : {}),
    };
    if (Object.keys(body).length) onCommit(body);
  };
  const handle = (which: "in" | "out") => ({
    onPointerDown: (e: PointerEvent<HTMLButtonElement>) => {
      e.preventDefault();
      e.currentTarget.setPointerCapture(e.pointerId);
      grab.current = rawAt(e.clientX) - (which === "in" ? inS : outS);
      dragRef.current = { inS, outS };
      setDrag(dragRef.current);
    },
    onPointerMove: (e: PointerEvent<HTMLButtonElement>) => {
      if (e.currentTarget.hasPointerCapture(e.pointerId)) move(which, rawAt(e.clientX) - grab.current);
    },
    onPointerUp: (e: PointerEvent<HTMLButtonElement>) => {
      if (!e.currentTarget.hasPointerCapture(e.pointerId)) return;
      e.currentTarget.releasePointerCapture(e.pointerId);
      commit();
    },
    onPointerCancel: () => {
      dragRef.current = null;
      setDrag(null);
    },
    onKeyDown: (e: KeyboardEvent<HTMLButtonElement>) => {
      const by = e.key === "ArrowLeft" ? -1 : e.key === "ArrowRight" ? 1 : 0;
      if (!by) return;
      e.preventDefault();
      move(which, (which === "in" ? inS : outS) + by * (e.shiftKey ? 0.5 : FRAME));
      commit();
    },
  });
  const pct = (x: number) => `${(x / c.len) * 100}%`;
  const a = c.take.analysis;

  return (
    <div className={`cut-clip ${selected ? "sel" : ""}`}>
      <button type="button" className="cut-label" onClick={onSelect} aria-pressed={selected}>
        <strong>
          {c.scene}.{c.n}
        </strong>{" "}
        {secs(drag ? Math.floor((outS - inS) * FPS + 1e-6) / FPS : c.lengthS)}
        {differs(c) && !drag && <span className="cut-dot" title="The studio suggests a different cut" />}
      </button>
      {/* biome-ignore lint/a11y/useKeyWithClickEvents lint/a11y/noStaticElementInteractions: a click only shows that moment in the preview; the handles are the keyboard route */}
      <div
        ref={box}
        className="cut-film"
        style={{ width: W, height: H }}
        onClick={(e) => {
          if ((e.target as HTMLElement).closest(".cut-handle")) return;
          onScrub(timeAt(e.clientX));
        }}
      >
        <canvas ref={canvas} style={{ width: W, height: H }} />
        {a?.suggestedInS !== undefined && <span className="cut-hold" style={{ left: 0, width: pct(a.suggestedInS) }} title="Holds still" />}
        {a?.stallFromS !== undefined && (
          <span className="cut-hold" style={{ left: pct(a.stallFromS), right: 0 }} title="Slows to a near stop" />
        )}
        {(a?.jumps ?? []).map((j) => (
          <span key={j} className="cut-jump" style={{ left: pct(j) }} title={`Possible jump at ${r2(j)} s`} />
        ))}
        <span className="cut-shade" style={{ left: 0, width: pct(inS) }} />
        <span className="cut-shade" style={{ left: pct(outS), right: 0 }} />
        <span className="cut-keep" style={{ left: pct(inS), width: pct(outS - inS) }} />
        <button
          type="button"
          className="cut-handle in"
          style={{ left: pct(inS) }}
          role="slider"
          aria-label={`Scene ${c.scene}, shot ${c.n}: start`}
          aria-valuemin={0}
          aria-valuemax={r2(outS - 0.5)}
          aria-valuenow={r2(inS)}
          aria-valuetext={`${r2(inS)} seconds`}
          {...handle("in")}
        />
        <button
          type="button"
          className="cut-handle out"
          style={{ left: pct(outS) }}
          role="slider"
          aria-label={`Scene ${c.scene}, shot ${c.n}: end`}
          aria-valuemin={r2(inS + 0.5)}
          aria-valuemax={r2(c.len)}
          aria-valuenow={r2(outS)}
          aria-valuetext={`${r2(outS)} seconds`}
          {...handle("out")}
        />
      </div>
    </div>
  );
}

/** Two frames butted together: a straight cut. Drawn, since the studio uses no emoji. */
function CutMark() {
  return (
    <svg width="18" height="14" viewBox="0 0 18 14" aria-hidden="true">
      <rect x="1" y="2" width="7" height="10" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
      <rect x="10" y="2" width="7" height="10" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  );
}

/** Two frames overlapping: a dissolve. */
function DissolveMark() {
  return (
    <svg width="18" height="14" viewBox="0 0 18 14" aria-hidden="true">
      <rect x="1" y="2" width="10" height="10" rx="1.5" fill="currentColor" opacity="0.45" />
      <rect x="7" y="2" width="10" height="10" rx="1.5" fill="currentColor" opacity="0.8" />
    </svg>
  );
}
