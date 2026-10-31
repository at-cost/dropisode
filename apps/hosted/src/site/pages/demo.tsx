/** @jsxImportSource hono/jsx */
import type { CostLine, Project, Shot } from "@reel/core";
import { generationCharge } from "@reel/money";
import type { Ctx } from "../../context";
import type { Demo } from "../demo";
import { TableWrap, int, page, usd, usdPrecise } from "../ui";

const PURPOSE: Record<string, string> = {
  script: "Script",
  cast_extract: "Cast list",
  storyboard: "Storyboard",
  cast_image: "Cast image",
  frame: "First frame",
  video: "Clip",
  tts: "Voice line",
};

const STATUS: Record<CostLine["status"], string> = {
  charged: "charged",
  refunded: "refunded",
  failed_billed: "failed, billed",
  pending: "pending",
};

function mediaUrl(project: Project, id: string | undefined): string | null {
  if (!id) return null;
  const ref = project.media.find((m) => m.id === id);
  if (!ref || ref.hidden || !ref.path.startsWith("media/")) return null;
  return `/demo/media/${ref.path.slice("media/".length)}`;
}

export function demoPage(c: Ctx, demo: Demo | null) {
  const { catalog, platform } = c.get("deps");
  const label = (id: string) => catalog.models.get(id)?.label ?? id;
  if (!demo) {
    return page(c, {
      title: "Demo",
      description: "A finished example Dropisode project.",
      body: (
        <>
          <h1>Demo</h1>
          <p class="notice">The demo project isn't installed on this server yet.</p>
        </>
      ),
    });
  }
  const p = demo.project;
  const episode = p.episodes.find((e) => e.id === demo.meta.episodeId) ?? p.episodes[0];
  const shots: Shot[] = episode ? episode.scenes.flatMap((s) => s.shots) : [];
  const shotNo = new Map(shots.map((s, i) => [s.id, i + 1]));
  const castName = new Map(p.cast.map((m) => [m.id, m.name]));
  const charge = (l: CostLine) => generationCharge(l.providerCostMicro, platform);
  const totalProvider = p.costLog.reduce((a, l) => a + l.providerCostMicro, 0);
  const totalCharge = p.costLog.reduce((a, l) => a + charge(l), 0);
  const markupPct = Math.round(platform.markup * 100);
  const groups = [
    { name: "Script, cast list and storyboard", test: (l: CostLine) => l.kind === "llm" },
    { name: "Cast reference images", test: (l: CostLine) => l.purpose === "cast_image" },
    { name: "Drafts (frames and clips)", test: (l: CostLine) => l.tier === "draft" },
    { name: "Finals (frames and clips)", test: (l: CostLine) => l.tier === "final" },
    { name: "Voice lines", test: (l: CostLine) => l.kind === "tts" },
  ]
    .map((g) => {
      const lines = p.costLog.filter(g.test);
      return {
        name: g.name,
        n: lines.length,
        provider: lines.reduce((a, l) => a + l.providerCostMicro, 0),
        charge: lines.reduce((a, l) => a + charge(l), 0),
      };
    })
    .filter((g) => g.n > 0);
  const episodeUrl = demo.exports.includes("episode.mp4") ? "/demo/exports/episode.mp4" : null;
  const poster = shots[0] ? mediaUrl(p, shots[0].takes.find((t) => t.id === shots[0]!.selectedTakeId)?.frameMediaId) : null;

  return page(c, {
    title: "Demo",
    description:
      "Walk through a finished Dropisode project: the script, the cast, the storyboard, the cost log with its total, and the final episode.",
    cache: "public, max-age=600",
    body: (
      <>
        <h1>Demo: {p.name}</h1>
        {demo.meta.placeholder ? (
          <p class="muted small" id="placeholder-notice" role="note">
            These clips are placeholders made without spending anything; prices are fal.ai's real list prices. A real episode replaces them
            soon.
          </p>
        ) : null}
        <p class="lede">
          A finished project, start to end, without signing up: one{" "}
          {Math.round(demo.meta.episodeDurationS ?? shots.reduce((a, s) => a + s.durationS, 0))} second vertical episode in {shots.length}{" "}
          shots.
        </p>
        <p>
          Total for this project: <strong data-k="demo-total">{usd(totalCharge)}</strong> on Dropisode, or {usd(totalProvider)} at fal's
          price.
        </p>
        <div class="toc">
          <a href="#script">Script</a>
          <a href="#cast">Cast</a>
          <a href="#storyboard">Storyboard</a>
          <a href="#costs">Cost log</a>
          <a href="#episode">Episode</a>
        </div>

        <h2 id="script">1. The script</h2>
        <p class="muted">
          Started from the idea "{p.idea.replace(/[.\s]+$/, "")}". The script model wrote this. It could also have been pasted or written by
          hand, and it stays editable.
        </p>
        <ScriptView text={episode?.script ?? ""} />

        <h2 id="cast">2. The cast</h2>
        <p class="muted">
          Each character, location and prop has a description and reference images. Dropisode uses them in every shot they appear in.
        </p>
        <div class="media-grid">
          {p.cast.map((m) => {
            const img = mediaUrl(p, m.refImageIds[0]);
            return (
              <div class="card cast">
                {img ? <img src={img} alt={`${m.name}, the reference the shots use`} loading="lazy" width={300} height={400} /> : null}
                <p style="margin:8px 0 2px">
                  <strong>{m.name}</strong> <span class="tag">{m.kind}</span>
                </p>
                <p class="small muted" style="margin:0">
                  {m.description}
                </p>
              </div>
            );
          })}
        </div>

        <h2 id="storyboard">3. The storyboard</h2>
        <p class="muted">
          The scene became {shots.length} shot cards. Each shot was drafted on a cheap model first, approved, then rendered once on a
          premium model. Prices are what you would pay on Dropisode.
        </p>
        <div class="media-grid shots-grid">
          {shots.map((s, i) => {
            const sel = s.takes.find((t) => t.id === s.selectedTakeId);
            const frame = mediaUrl(p, sel?.frameMediaId);
            const clip = mediaUrl(p, sel?.videoMediaId);
            const lines = p.costLog.filter((l) => l.shotId === s.id);
            const drafts = s.takes.filter((t) => t.tier === "draft");
            const finals = s.takes.filter((t) => t.tier === "final");
            return (
              <div class="card shot" data-shot={String(i + 1)}>
                {clip ? (
                  <video controls preload="none" playsinline src={clip} {...(frame ? { poster: frame } : {})} />
                ) : frame ? (
                  <img src={frame} alt={`First frame of shot ${i + 1}`} loading="lazy" />
                ) : null}
                <p style="margin:8px 0 2px">
                  <strong>Shot {i + 1}</strong> <span class="muted small">{s.durationS} s</span>{" "}
                  {s.approved ? <span class="tag ok">approved</span> : null}
                </p>
                <p class="small" style="margin:2px 0">
                  {s.description}
                </p>
                {s.camera ? (
                  <p class="small muted" style="margin:2px 0">
                    Camera: {s.camera}
                  </p>
                ) : null}
                {s.dialogue.map((d) => (
                  <p class="small" style="margin:2px 0">
                    <strong>{d.castId ? (castName.get(d.castId) ?? "") : "Narrator"}:</strong> {d.text}
                  </p>
                ))}
                <p class="small muted" style="margin:6px 0 0">
                  {drafts.length} draft{drafts.length === 1 ? "" : "s"}
                  {drafts[0] ? ` on ${label(drafts[0].videoModel)}` : ""}, {finals.length} final{finals.length === 1 ? "" : "s"}
                  {finals[0] ? ` on ${label(finals[0].videoModel)}` : ""}. {usd(lines.reduce((a, l) => a + charge(l), 0))}
                </p>
              </div>
            );
          })}
        </div>

        <h2 id="costs">4. The cost log</h2>
        <p class="muted">
          Every request, its model, units and price. "You pay" is the fal price plus {markupPct}%, worked out per job as billing does.
        </p>
        <TableWrap label="Cost summary">
          <table>
            <thead>
              <tr>
                <th>Step</th>
                <th class="num">Requests</th>
                <th class="num">fal price</th>
                <th class="num">You pay</th>
              </tr>
            </thead>
            <tbody>
              {groups.map((g) => (
                <tr>
                  <td>{g.name}</td>
                  <td class="num">{int(g.n)}</td>
                  <td class="num">{usd(g.provider)}</td>
                  <td class="num">{usd(g.charge)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <td>Total</td>
                <td class="num">{int(p.costLog.length)}</td>
                <td class="num">{usd(totalProvider)}</td>
                <td class="num">{usd(totalCharge)}</td>
              </tr>
            </tfoot>
          </table>
        </TableWrap>
        <details>
          <summary>Every line ({p.costLog.length})</summary>
          <TableWrap label="Cost log">
            <table>
              <thead>
                <tr>
                  <th>Step</th>
                  <th>Model</th>
                  <th>Tier</th>
                  <th class="num">Units</th>
                  <th class="num">fal price</th>
                  <th class="num">You pay</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {p.costLog.map((l) => (
                  <tr>
                    <td>
                      {PURPOSE[l.purpose] ?? l.purpose}
                      {l.shotId && shotNo.has(l.shotId) ? `, shot ${shotNo.get(l.shotId)}` : ""}
                      {l.castId && castName.has(l.castId) ? `, ${castName.get(l.castId)}` : ""}
                    </td>
                    <td>{label(l.model)}</td>
                    <td>{l.tier ?? ""}</td>
                    <td class="num">
                      {int(l.units)} {l.unit === "second" ? "s" : l.unit}
                    </td>
                    <td class="num">{usdPrecise(l.providerCostMicro)}</td>
                    <td class="num">{usdPrecise(charge(l))}</td>
                    <td>{STATUS[l.status]}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableWrap>
        </details>

        <h2 id="episode">5. The episode</h2>
        <p class="muted">The approved finals, joined in order with burned-in subtitles.</p>
        {episodeUrl ? (
          <div class="player">
            <video controls preload="metadata" playsinline src={episodeUrl} {...(poster ? { poster } : {})} />
          </div>
        ) : (
          <p class="notice">The episode file is missing from this demo.</p>
        )}
        <p>Assembly also writes these files, for finishing in another editor:</p>
        <ul>
          {demo.exports.map((f) => (
            <li>
              <a href={`/demo/exports/${f}?download=1`}>{f}</a>
            </li>
          ))}
        </ul>
        <div class="actions">
          {c.get("user") ? (
            <a class="button" href="/studio/">
              Open the studio
            </a>
          ) : (
            <a class="button" href="/sign-up">
              Sign up to make your own
            </a>
          )}
          <a class="button secondary" href="/pricing">
            See prices
          </a>
        </div>
      </>
    ),
  });
}

/** A screenplay in the body font: scene headings stand out, speaker names in small caps. */
function ScriptView(p: { text: string }) {
  return (
    <div class="script">
      {p.text.split("\n").map((line) => {
        const scene = /^(SCENE \d+|INT\.|EXT\.)/.test(line);
        const speech = /^([A-Z][A-Z .'-]{1,30}):\s(.*)$/.exec(line);
        if (scene) return <div class="sh">{line}</div>;
        if (speech && !/^(TITLE|CAST)$/.test(speech[1]!)) {
          return (
            <div>
              <b>{speech[1]!.toLowerCase()}</b>: {speech[2]}
            </div>
          );
        }
        const cast = /^\s*-\s*(.*)$/.exec(line);
        if (cast) return <div class="cast-line">· {cast[1]}</div>;
        return <div>{line || "\u00a0"}</div>;
      })}
    </div>
  );
}
