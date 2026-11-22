/**
 * The prompt writer: turns a planned sequence (several shots with hard cuts inside one generation)
 * into the final video prompt for one video model, and checks finished takes against the plan.
 *
 * The structure is the one that works best on multi-shot video models: a logline, the world (PLATE),
 * the characters with real sizes and anatomy, timecoded shots that each end on an outgoing state and
 * are separated by "Hard cut.", the camera rules, grade and sound, then explicit counts. An LLM writes
 * the prose from a guide for the model's family; the counts and constraints are added here, in code,
 * so they can never be dropped.
 */
import type { CatalogModel } from "./catalog";
import { modelFamily } from "./catalog";
import type { LlmPrompt } from "./prompts";
import type { Aspect, Beat, CastMember, CastNote, CountRule, Scene, Shot } from "./project";

/** What the writer needs to know about one sequence. */
export interface SequenceContext {
  shot: Shot;
  scene: Pick<Scene, "heading" | "script" | "staging" | "plate" | "grade" | "castNotes" | "counts" | "whitelist">;
  /** Everyone and everything visible in the shot (characters, props, the place). */
  cast: CastMember[];
  /** The scene's place, if it has one. */
  location?: CastMember | undefined;
  aspect: Aspect;
  /** The model makes its own sound. */
  nativeAudio: boolean;
  /** Names of the reference pictures sent with the prompt, in order (empty: it starts from a first frame). */
  references?: string[];
  /** How the model names the n-th picture ("@Image{n}"). */
  imageToken?: string;
}

// Guides, by model family. Our own words; add a family by adding a guide.

const SEEDANCE_GUIDE = [
  "You are writing for ByteDance Seedance 2.5. It renders one generation of 4 to 30 seconds and can cut inside it: a timecoded shot list with 'Hard cut.' between shots gives several shots in one clip, and the world, light and characters stay consistent across those cuts.",
  "What Seedance follows well: exact timecodes (0.00-4.00), standard shot sizes (EWS, WS, MWS, MS, MCU, CU, ECU), named angles and camera heights, lenses in millimetres, one named camera movement per shot, physical cause and effect told in order, and an 'End with ...' sentence that fixes the last frame of each shot so the next cut lands.",
  "What goes wrong if you don't say otherwise: it adds a second copy of a character, invents extra animals or people, makes a split screen or picture-in-picture, adds music, adds speech nobody wrote, gives animals human hands or poses, and drifts to centred eye-level coverage. Say the counts, say who stays on which side of the screen, and give each animal its real anatomy and real size in numbers.",
  "Physical comedy and action read best played completely straight, with real mass, momentum, inertia and follow-through: spray and debris carry weight, a heavy body is slow to start and slow to stop.",
  "Reference pictures, when given, are named @Image1, @Image2 in the prompt: say once which picture is which character, and that each keeps its picture's species, markings and colours.",
  "Sound: it makes diegetic sound with the picture. List the specific sounds, each once where it happens (one huff-snort, one splash), and end the audio paragraph with 'No music, no score, no bgm.'",
].join("\n");

const GENERIC_GUIDE = [
  "You are writing for an image-to-video model. Many such models render one continuous shot and may ignore cuts; still keep the timecoded structure, but make each shot's action flow into the next so the clip reads even if the model renders it as one camera move.",
  "Be concrete: shot size, angle, camera height, lens in millimetres, one camera movement, and physical action told in order. End each shot with the state it leaves.",
  "Say how many of each character may be visible, who stays on which side of the screen, and each character's real size and anatomy. Ask for no music, no on-screen text and no split screen.",
].join("\n");

export const PROMPT_GUIDES: Record<string, string> = { seedance: SEEDANCE_GUIDE, generic: GENERIC_GUIDE };

export function guideFor(model: CatalogModel): { family: string; guide: string } {
  const family = modelFamily(model);
  return { family, guide: PROMPT_GUIDES[family] ?? GENERIC_GUIDE };
}

// Small helpers

const WORDS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve"];
export const numberWord = (n: number): string => WORDS[n] ?? String(n);

/** Em and en dashes out: the house style, and Seedance reads commas just as well. */
export function noDashes(t: string): string {
  return t.replace(EM_RE, ", ").replace(EN_RANGE_RE, "$1-$2").replace(EN_RE, ", ").replace(/,\s*,/g, ",");
}
// Built from code points, so this file holds no dash characters itself.
const EM = String.fromCodePoint(0x2014);
const EN = String.fromCodePoint(0x2013);
const EM_RE = new RegExp(`\\s*${EM}\\s*`, "g");
const EN_RANGE_RE = new RegExp(`(\\d)\\s*${EN}\\s*(\\d)`, "g");
const EN_RE = new RegExp(`\\s*${EN}\\s*`, "g");

const sentence = (t: string): string => {
  const x = t.trim().replace(/\s+/g, " ");
  if (!x) return "";
  const s = `${x.charAt(0).toUpperCase()}${x.slice(1)}`;
  return /[.!?]$/.test(s) ? s : `${s}.`;
};
const lowerFirst = (t: string) => (t ? `${t.charAt(0).toLowerCase()}${t.slice(1)}` : t);
const fmtS = (s: number) => s.toFixed(2);
const label = (c: CastMember) => c.name.trim().toUpperCase();
const norm = (t: string) =>
  t
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, " ")
    .trim();
const stem = (w: string) => w.replace(/(es|s)$/, "");

/** Whether a count rule ("grey seals") is about this cast member ("Seal"). */
function countMatches(rule: CountRule, c: CastMember): boolean {
  const what = norm(rule.what).split(/\s+/).map(stem);
  const name = norm(c.name).split(/\s+/).map(stem);
  return name.length > 0 && name.every((w) => what.includes(w));
}

function noteFor(notes: CastNote[], c: CastMember): CastNote | undefined {
  const n = norm(c.name);
  return notes.find((x) => norm(x.name) === n) ?? notes.find((x) => norm(x.name).includes(n) || n.includes(norm(x.name)));
}

const side = (s: string) => {
  const x = s.toLowerCase();
  return /left/.test(x) ? "screen-left" : /right/.test(x) ? "screen-right" : /cent/.test(x) ? "centre frame" : s.trim();
};

/** One line of camera facts for a beat: "MCU, low front-left angle, camera at the ice edge, 85mm lens, handheld". */
export function beatCamera(b: Beat): string {
  return [
    b.size.trim(),
    b.angle.trim() ? (/angle/i.test(b.angle) ? b.angle.trim() : `${b.angle.trim()} angle`) : "",
    b.height.trim() ? (/camera/i.test(b.height) ? b.height.trim() : `camera ${b.height.trim()}`) : "",
    b.lens.trim() ? (/lens/i.test(b.lens) ? b.lens.trim() : `${b.lens.trim()} lens`) : "",
    b.movement.trim()
      ? /camera|mount|zoom|dolly|track|pan|tilt|crane|handheld/i.test(b.movement)
        ? b.movement.trim()
        : `${b.movement.trim()} camera`
      : "",
  ]
    .filter(Boolean)
    .join(", ");
}

/** The "References: @Image1 is ..." line, when the cast's pictures go with the prompt. */
export function referenceHeader(names: string[], token = "@Image{n}"): string {
  if (!names.length) return "";
  const list = names.map((n, i) => `${token.replace("{n}", String(i + 1))} is ${n}`).join(", ");
  return `References: ${list}. Each keeps its picture's species, build, markings and colours exactly; the pictures show who they are, not the framing.`;
}

/** Puts the reference line at the top of a prompt, replacing any old one. */
export function withReferenceHeader(prompt: string, header: string): string {
  const body = prompt.replace(/^References:[^\n]*\n+/i, "");
  return header ? `${header}\n\n${body}` : body;
}

// The prompt, built deterministically from the plan

function charactersBlock(ctx: SequenceContext): string[] {
  const people = ctx.cast.filter((c) => c.kind === "character");
  return people.map((c) => {
    const n = noteFor(ctx.scene.castNotes, c);
    return [
      `${label(c)} is ${lowerFirst(c.description.trim().replace(/\.$/, "")) || "as in its picture"}.`,
      n?.size.trim() ? sentence(`Real size: ${n.size.trim()}`) : "",
      n?.anatomy.trim() ? sentence(`Correct real anatomy: ${n.anatomy.trim()}`) : "",
      n?.side.trim() ? `It stays ${side(n.side)}.` : "",
      n?.acting.trim() ? sentence(`Acting detail: ${n.acting.trim()}`) : "",
    ]
      .filter(Boolean)
      .join(" ");
  });
}

function plateBlock(ctx: SequenceContext): string {
  const props = ctx.cast.filter((c) => c.kind === "prop");
  const place = ctx.scene.plate.trim() || (ctx.location ? `${ctx.location.name}: ${ctx.location.description}` : ctx.scene.heading);
  return [
    `PLATE: ${sentence(place)}`,
    props.length ? `Props: ${props.map((p) => `${p.name}: ${p.description.trim().replace(/\.$/, "")}`).join("; ")}.` : "",
    "The world, weather, light and every fixed prop stay the same in every shot.",
  ]
    .filter(Boolean)
    .join(" ");
}

function beatLines(shot: Shot): string[] {
  const out: string[] = [];
  shot.beats.forEach((b, i) => {
    const cam = beatCamera(b);
    out.push(
      [
        `${fmtS(b.startS)}-${fmtS(b.endS)}: ${cam ? `${cam}.` : ""}`,
        sentence(b.action),
        b.endState.trim() ? sentence(`End with ${lowerFirst(b.endState.trim())}`) : "",
      ]
        .filter(Boolean)
        .join(" "),
    );
    if (i < shot.beats.length - 1) out.push("Hard cut.");
  });
  return out;
}

function cameraLaw(ctx: SequenceContext): string {
  const b = ctx.shot.beats;
  const lenses = [...new Set(b.map((x) => x.lens.trim()).filter(Boolean))];
  const moves = [...new Set(b.map((x) => x.movement.trim().toLowerCase()).filter(Boolean))];
  const heights = [...new Set(b.map((x) => x.height.trim()).filter(Boolean))];
  const sides = ctx.cast
    .filter((c) => c.kind === "character")
    .map((c) => [label(c), noteFor(ctx.scene.castNotes, c)?.side ?? ""] as const)
    .filter(([, s]) => s.trim());
  return [
    "CAMERA LAW:",
    lenses.length ? `Physical lenses only: ${lenses.join(", ")}.` : "",
    moves.length ? `Camera movement only as assigned: ${moves.join(", ")}.` : "",
    heights.length ? `Camera heights: ${heights.join("; ")}.` : "",
    sides.length
      ? `Screen direction: ${sides.map(([n, s]) => `${n} ${side(s)}`).join(", ")}; every camera stays on the same side of the action and nobody crosses the line.`
      : "",
    "Natural 24fps motion with a 180-degree shutter and real motion blur.",
    `Frame for ${ctx.aspect === "9:16" ? "9:16 vertical" : "16:9 horizontal"}.`,
    "Anti-default: avoid centred eye-level coverage; every cut changes both the angle and the shot size.",
  ]
    .filter(Boolean)
    .join(" ");
}

function gradeAndAudio(ctx: SequenceContext): string {
  const { shot } = ctx;
  const lines = shot.dialogue.filter((l) => l.text.trim());
  const byId = new Map(ctx.cast.map((c) => [c.id, c]));
  const said = lines.map((l) => `${l.castId && byId.get(l.castId) ? label(byId.get(l.castId)!) : "A voice"} says: "${l.text.trim()}"`);
  return [
    "GRADE AND AUDIO:",
    ctx.scene.grade.trim() ? sentence(ctx.scene.grade) : "Natural, motivated light from the place itself.",
    "Photoreal, with heavy real mass, momentum, inertia and follow-through.",
    ctx.nativeAudio && shot.sounds.length ? `Diegetic sound only: ${shot.sounds.map((s) => s.trim().replace(/\.$/, "")).join(", ")}.` : "",
    ctx.nativeAudio && said.length ? `${said.join(" ")} Each line is spoken once, clearly.` : "",
    ctx.nativeAudio && !said.length ? "Nobody speaks." : "",
    shot.slowMotion ? "The entire generation has a 120fps slow-motion feel; sound is slowed and deepened to match." : "",
    "No music, no score, no bgm.",
  ]
    .filter(Boolean)
    .join(" ");
}

/**
 * The counts and constraints, built in code and appended to every written prompt, so a rewrite can never
 * drop them. Counts the scene set are kept; a cast member who isn't in this shot is counted as zero.
 */
export function constraintsBlock(ctx: SequenceContext): string {
  const people = ctx.cast.filter((c) => c.kind === "character");
  const counted = new Set<string>();
  const lines: string[] = [];
  for (const rule of ctx.scene.counts) {
    const who = people.find((c) => countMatches(rule, c));
    if (who) counted.add(who.id);
    lines.push(`Count of ${rule.what.trim()} in frame: ${numberWord(rule.n)}.`);
  }
  for (const c of people) if (!counted.has(c.id)) lines.push(`Count of ${label(c)} in frame: one.`);
  const n = ctx.shot.beats.length;
  if (n > 0) {
    lines.push(`Cut count: ${numberWord(Math.max(0, n - 1))}. Shot count: ${numberWord(n)}.`);
    if (n > 1) lines.push("Every cut is a hard cut to a new camera angle and a different shot size.");
  }
  const sides = people.map((c) => [label(c), noteFor(ctx.scene.castNotes, c)?.side ?? ""] as const).filter(([, s]) => s.trim());
  if (sides.length) lines.push(`Character positions: ${sides.map(([nm, s]) => `${nm} ${side(s)}`).join(", ")}.`);
  const whitelist = ctx.scene.whitelist.length
    ? ctx.scene.whitelist
    : [...people.map((c) => `one ${c.name}`), ...ctx.cast.filter((c) => c.kind === "prop").map((c) => c.name)];
  if (whitelist.length)
    lines.push(
      `Whitelist of visible subjects: ${whitelist.join(", ")}. Nothing else appears: no extra people, animals or copies of anyone.`,
    );
  if (people.length)
    lines.push("Every animal or person keeps its real species and anatomy throughout: no extra limbs, no human hands or poses on animals.");
  lines.push("One full frame at all times: no split screen, no picture-in-picture, no borders.");
  lines.push("No on-screen text, no subtitles, no captions, no watermarks.");
  if (ctx.shot.slowMotion) lines.push("Slow motion for the whole generation.");
  if (ctx.nativeAudio) lines.push("No music, no score, no bgm: diegetic sound only.");
  return `CONSTRAINTS: ${lines.join(" ")}`;
}

/** The whole prompt, from the plan alone: what the writer starts from, and the fallback if it fails. */
export function sequencePrompt(ctx: SequenceContext): string {
  const { shot } = ctx;
  const head = referenceHeader(ctx.references ?? [], ctx.imageToken);
  const logline = shot.logline.trim() || shot.description.split("\n")[0]!.trim();
  const body = [
    sentence(logline),
    plateBlock(ctx),
    ...charactersBlock(ctx),
    shot.startState.trim() ? sentence(`As the clip starts: ${shot.startState.trim()}`) : "",
    ...beatLines(shot),
    cameraLaw(ctx),
    gradeAndAudio(ctx),
  ].filter(Boolean);
  return noDashes([head, ...body, constraintsBlock(ctx)].filter(Boolean).join("\n\n"));
}

// The LLM write step

const DRAFT_START = "DRAFT START";
const DRAFT_END = "DRAFT END";

export function writerPrompt(ctx: SequenceContext, model: CatalogModel): LlmPrompt {
  const { guide } = guideFor(model);
  const draft = sequencePrompt({ ...ctx, references: [] }).replace(/\n\nCONSTRAINTS:[\s\S]*$/, "");
  const n = ctx.shot.beats.length;
  return {
    system: `You write the final prompt for a video model, for one generation of a short film. Answer with the prompt only: plain text, no markdown, no commentary.\n\n${guide}`,
    prompt: [
      `SCENE: ${ctx.scene.heading}`,
      ctx.scene.script.trim()
        ? `SCRIPT OF THE SCENE (for context; this generation is only part of it):\n${ctx.scene.script.slice(0, 6000)}`
        : "",
      ctx.scene.staging.trim() ? `HOW THE SCENE STARTS: ${ctx.scene.staging.trim()}` : "",
      "",
      "Rewrite the draft below into the final prompt for this one generation, in this order, as separate paragraphs:",
      "1. A one-sentence logline for the whole clip.",
      "2. PLATE: the place, weather, light, water or ground, and every fixed prop with its real size, stated to stay fixed in every shot.",
      "3. One paragraph per character: who they are, real size in numbers, correct real anatomy, which side of the screen they keep, and their one acting detail.",
      `4. The ${numberWord(n)} timecoded shots, keeping every time exactly as given. Each starts with its time range and camera (size, angle, camera height, lens, movement), tells what happens in order with real physical weight, and ends with one sentence starting "End with". Put "Hard cut." on its own line between shots.`,
      "5. CAMERA LAW: lenses, camera height, 24fps with a 180-degree shutter, screen direction, and an anti-default line against centred eye-level coverage.",
      "6. GRADE AND AUDIO: palette, contrast, key light, the specific sounds each once where they happen, and 'No music, no score, no bgm.'",
      "Keep every fact in the draft: names, sizes, sides of the screen, sounds, slow motion, lines of dialogue. Add concrete physical and visual detail, never new characters, props or events. Comedy and action are played completely straight.",
      "Do not write counts or a CONSTRAINTS paragraph: they are added after yours. Never use em dashes. 400 to 900 words.",
      "",
      DRAFT_START,
      draft,
      DRAFT_END,
    ]
      .filter((l) => l !== "")
      .join("\n"),
    maxTokens: 9000,
  };
}

/** The draft the writer was given (the mock provider answers with it). */
export function draftFromWriterPrompt(prompt: string): string {
  const a = prompt.indexOf(DRAFT_START);
  const b = prompt.indexOf(DRAFT_END);
  return a >= 0 && b > a ? prompt.slice(a + DRAFT_START.length, b).trim() : "";
}

/** Whether an LLM's prompt kept the plan's shape: every timecode in order and a hard cut between shots. */
export function keepsStructure(text: string, shot: Shot): boolean {
  if (!shot.beats.length) return text.trim().length > 40;
  let at = 0;
  for (const b of shot.beats) {
    const i = text.indexOf(fmtS(b.startS), at);
    if (i < 0) return false;
    at = i;
  }
  const cuts = (text.match(/hard cut\./gi) ?? []).length;
  return cuts >= shot.beats.length - 1;
}

/**
 * The final prompt from an LLM's answer: fences and any counts it wrote removed, dashes replaced, the
 * reference line on top and the deterministic constraints at the end. An answer that lost the plan's
 * structure is replaced by the plan's own prompt.
 */
export function finishWrittenPrompt(answer: string, ctx: SequenceContext): { prompt: string; fellBack: boolean } {
  let t = answer.replace(/```[a-z]*\n?/gi, "").trim();
  // Anything the model wrote from a constraints or counts paragraph onwards is ours to write.
  t = t.replace(/\n+\s*(CONSTRAINTS|COUNTS)\b[\s\S]*$/i, "");
  t = stripCounts(t);
  t = withReferenceHeader(t, "");
  if (!keepsStructure(t, ctx.shot)) return { prompt: sequencePrompt(ctx), fellBack: true };
  const head = referenceHeader(ctx.references ?? [], ctx.imageToken);
  return { prompt: noDashes([head, t, constraintsBlock(ctx)].filter(Boolean).join("\n\n")), fellBack: false };
}

/**
 * A prompt cut to fit what a shot stores: the body is shortened, never the reference line or the
 * CONSTRAINTS block at the end, so the counts can't be lost to a length limit.
 */
export function fitPrompt(prompt: string, max = 12_000): string {
  if (prompt.length <= max) return prompt;
  const at = prompt.lastIndexOf("\n\nCONSTRAINTS:");
  const tail = at >= 0 ? prompt.slice(at) : "";
  const body = at >= 0 ? prompt.slice(0, at) : prompt;
  return `${body.slice(0, Math.max(0, max - tail.length - 1)).trimEnd()}${tail}`.slice(-max);
}

/** Counts written anywhere (a sentence inside a paragraph too) are dropped: the plan's are the only counts. */
function stripCounts(t: string): string {
  return t
    .replace(/(^|[\s.])(count of [^.\n]*|cut count:[^.\n]*|shot count:[^.\n]*|whitelist of [^.\n]*)\.?/gi, "$1")
    .split("\n")
    .map((l) => l.replace(/[ \t]{2,}/g, " ").trimEnd())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** The constraints a prompt carries, replaced by the current ones (counts changed, a reference added). */
export function refreshConstraints(prompt: string, ctx: SequenceContext): string {
  const body = stripCounts(withReferenceHeader(prompt, "").replace(/\n*CONSTRAINTS:[\s\S]*$/, ""));
  const head = referenceHeader(ctx.references ?? [], ctx.imageToken);
  return noDashes([head, body, constraintsBlock(ctx)].filter(Boolean).join("\n\n"));
}

// Reviewing a finished take

export interface SheetInfo {
  /** Seconds into the clip of each tile, in reading order (left to right, top to bottom). */
  times: number[];
  cols: number;
  rows: number;
}

export function reviewPrompt(p: { ctx: SequenceContext; sentPrompt: string; sheet: SheetInfo; clipS: number }): LlmPrompt {
  const { ctx, sheet } = p;
  const { shot } = ctx;
  const people = ctx.cast.filter((c) => c.kind === "character");
  const tiles = sheet.times.map((t, i) => `tile ${i + 1} = ${t.toFixed(1)} s`).join(", ");
  const plan = shot.beats.length
    ? shot.beats.map((b, i) => `Shot ${i + 1}, ${fmtS(b.startS)}-${fmtS(b.endS)} s: ${beatCamera(b)}. ${b.action} End: ${b.endState}`)
    : [`One shot, ${shot.durationS} s: ${shot.camera ? `${shot.camera}. ` : ""}${shot.description}`];
  return {
    system:
      "You check a finished AI video clip against its plan, from a contact sheet of its frames. You are strict about the things that ruin a film: wrong species or look, extra or duplicated characters, characters on the wrong side, a split screen, missing shots or cuts, on-screen text, an action that never happens. You ignore small differences of taste. Answer with JSON only.",
    prompt: [
      `The picture is a contact sheet of a ${p.clipS.toFixed(1)} s clip: ${sheet.cols} tiles across, ${sheet.rows} down, read left to right, top to bottom: ${tiles}.`,
      "",
      "THE PLAN",
      ...plan,
      `Characters: ${people.map((c) => `${c.name}: ${c.description}${noteFor(ctx.scene.castNotes, c)?.side ? ` (stays ${side(noteFor(ctx.scene.castNotes, c)!.side)})` : ""}`).join(" | ") || "none"}`,
      ctx.scene.counts.length
        ? `Counts: ${ctx.scene.counts.map((c) => `${c.what}: ${c.n}`).join(", ")}`
        : `Counts: one of each character listed.`,
      ctx.scene.whitelist.length ? `Allowed in frame: ${ctx.scene.whitelist.join(", ")}` : "",
      "",
      "THE PROMPT THAT WAS SENT",
      // Long prompts keep their end, where the counts and constraints are.
      p.sentPrompt.length > 9000 ? `${p.sentPrompt.slice(0, 5500)}\n[...]\n${p.sentPrompt.slice(-3500)}` : p.sentPrompt,
      "",
      'Answer as {"pass":true|false,"problems":[{"at":seconds or null,"text":"what is wrong, in plain words"}],"fixedPrompt":"..."}.',
      "pass is false only for a problem worth paying for a retake. List each problem once, with the time of the first tile that shows it; on a pass, list only small notes, or none.",
      'fixedPrompt: when pass is false, the whole prompt rewritten to prevent those problems (keep its structure, its timecodes and "Hard cut." lines; be more explicit where the clip went wrong; no em dashes). When pass is true, "".',
    ]
      .filter((l) => l !== "")
      .join("\n"),
    maxTokens: 8000,
  };
}

export interface ParsedReview {
  pass: boolean;
  problems: { atS: number | null; text: string }[];
  fixedPrompt: string;
}

/** Reads the check's JSON answer. Anything unreadable is a failure to check, not a pass. */
export function parseReview(text: string): ParsedReview {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const body = fenced ? fenced[1]! : text;
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start < 0 || end < start) throw new Error("The check's answer had no JSON in it");
  const d = JSON.parse(body.slice(start, end + 1)) as { pass?: unknown; problems?: unknown; fixedPrompt?: unknown };
  const problems = Array.isArray(d.problems)
    ? d.problems
        .map((x) => {
          if (typeof x === "string") return { atS: null, text: x };
          const o = x as { at?: unknown; atS?: unknown; text?: unknown };
          const at = typeof o.at === "number" ? o.at : typeof o.atS === "number" ? o.atS : null;
          return typeof o.text === "string"
            ? { atS: at !== null && at >= 0 ? Math.round(at * 10) / 10 : null, text: o.text.slice(0, 500) }
            : null;
        })
        .filter((x): x is { atS: number | null; text: string } => !!x && !!x.text.trim())
        .slice(0, 12)
    : [];
  // The verdict as given (problems on a pass are small notes); with no verdict, any problem is a fail.
  const pass = typeof d.pass === "boolean" ? d.pass : problems.length === 0;
  const fixedPrompt = typeof d.fixedPrompt === "string" && !pass ? noDashes(d.fixedPrompt.trim()).slice(0, 12_000) : "";
  return { pass, problems, fixedPrompt };
}
