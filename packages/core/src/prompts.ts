/**
 * Prompts for the LLM steps and the image and video models, and parsers for
 * what comes back. Character consistency comes from two things used in every
 * shot: the same written description of each cast member, and the same
 * reference images (see generate.ts). The approach follows ViMax's
 * character-consistency pipeline (HKUDS/ViMax, MIT); the text here is our own.
 */
import type { Aspect, CastKind, CastMember, Shot } from "./project";

export const CAMERA_PRESETS = [
  "wide, static",
  "medium, static",
  "close-up, static",
  "extreme close-up",
  "over-the-shoulder",
  "two-shot",
  "slow push in",
  "slow pull out",
  "pan left",
  "pan right",
  "tilt up",
  "handheld, following",
  "tracking alongside",
  "low angle",
  "high angle, looking down",
  "top-down insert",
  "dolly zoom",
  "orbit around subject",
] as const;

export interface LlmPrompt {
  system: string;
  prompt: string;
  maxTokens: number;
}

export function scriptPrompt(p: { idea: string; targetSeconds: number; aspect: Aspect }): LlmPrompt {
  const shots = Math.max(1, Math.round(p.targetSeconds / 5));
  return {
    system:
      "You are a screenwriter for short vertical dramas: punchy, visual, a hook in the first seconds and a cliffhanger at the end. Write only what a camera can show and actors can say. Keep the cast small.",
    prompt: [
      `IDEA: ${p.idea.replace(/\s+/g, " ").trim()}`,
      "",
      `Write one episode of about ${p.targetSeconds} seconds (roughly ${shots} shots of 5 seconds). Short lines of dialogue.`,
      "Use exactly this plain-text format:",
      "TITLE: <title>",
      "",
      "CAST:",
      "- NAME (character|location|prop): <fixed visual description: age, build, hair, face, wardrobe; for places, look and light>",
      "",
      "SCENE 1. INT./EXT. PLACE - TIME",
      "<action lines>",
      "NAME: <dialogue>",
      "",
      "Every character who appears must be in CAST with a description precise enough to draw the same person every time.",
    ].join("\n"),
    maxTokens: 1500,
  };
}

export function castExtractPrompt(script: string): LlmPrompt {
  return {
    system: "You extract a production cast list from a script. Answer with JSON only.",
    prompt: [
      "List every character, location and recurring prop in this script with a fixed visual description (age, build, hair, face, wardrobe; for places, look and light).",
      'Answer as {"cast":[{"kind":"character|location|prop","name":"...","description":"..."}]}.',
      "",
      "SCRIPT:",
      script.slice(0, 30_000),
    ].join("\n"),
    maxTokens: 1500,
  };
}

export function storyboardPrompt(p: {
  sceneScript: string;
  heading: string;
  cast: CastMember[];
  targetSeconds?: number;
  durations: number[];
}): LlmPrompt {
  const durations = p.durations.length ? p.durations.join(", ") : "5";
  return {
    system:
      "You are a storyboard artist for short vertical dramas. You break a scene into shots a video model can render: one clear action per shot, the camera stated, characters named exactly as in the cast list. Answer with JSON only.",
    prompt: [
      `SCENE: ${p.heading}`,
      p.sceneScript.slice(0, 20_000),
      "",
      "CAST (use these names exactly):",
      ...p.cast.map((c) => `- ${c.name} (${c.kind})`),
      "",
      `Break the scene into shots${p.targetSeconds ? ` totalling about ${p.targetSeconds} seconds` : ""}. Each shot's duration must be one of: ${durations} seconds.`,
      "Put each line of dialogue in the shot where it is spoken, with its speaker.",
      `Camera: pick from ${CAMERA_PRESETS.join("; ")}, or describe your own.`,
      'Answer as {"shots":[{"description":"what we see","camera":"...","cast":["NAME"],"dialogue":[{"speaker":"NAME","text":"..."}],"duration":5}]}.',
    ].join("\n"),
    maxTokens: 3000,
  };
}

const describe = (c: CastMember) => `${c.name}: ${c.description}`.trim();

/** The first-frame prompt. Every cast member's fixed description goes in, every time. */
export function framePrompt(p: { shot: Shot; cast: CastMember[]; location?: CastMember | undefined; aspect: Aspect }): string {
  const people = p.cast.filter((c) => c.kind !== "location");
  const place = p.location ?? p.cast.find((c) => c.kind === "location");
  return [
    `A single cinematic film still, ${p.aspect === "9:16" ? "vertical 9:16" : "horizontal 16:9"} frame, photorealistic, natural light, shallow depth of field.`,
    `Shot: ${p.shot.description}`,
    p.shot.camera ? `Camera: ${p.shot.camera}.` : "",
    people.length ? `Characters (keep them exactly as in the reference images): ${people.map(describe).join(" | ")}` : "",
    place ? `Setting: ${describe(place)}` : "",
    "No text, captions or watermarks.",
  ]
    .filter(Boolean)
    .join("\n");
}

/** The image-to-video prompt. Native-audio models get the dialogue to speak. */
export function videoPrompt(p: { shot: Shot; cast: CastMember[]; nativeAudio: boolean }): string {
  const byId = new Map(p.cast.map((c) => [c.id, c]));
  const lines = p.shot.dialogue
    .filter((l) => l.text.trim())
    .map((l) => {
      const who = l.castId ? byId.get(l.castId)?.name : undefined;
      return who ? `${who} says: "${l.text}"` : `Narrator says: "${l.text}"`;
    });
  return [
    p.shot.description,
    p.shot.camera ? `Camera: ${p.shot.camera}.` : "",
    p.nativeAudio && lines.length ? lines.join(" ") : "",
    p.nativeAudio ? "Natural ambient sound. No music." : "",
    "Keep faces and wardrobe consistent with the first frame. Smooth, realistic motion.",
  ]
    .filter(Boolean)
    .join(" ");
}

export function castImagePrompt(c: CastMember): string {
  if (c.kind === "character") {
    return `Character reference portrait, waist up, facing camera, neutral expression, plain light grey studio background, soft even light, photorealistic. ${c.name}: ${c.description}. No text.`;
  }
  if (c.kind === "location")
    return `Establishing reference image of a location, no people, cinematic, photorealistic. ${c.name}: ${c.description}. No text.`;
  return `Product-style reference photo of a prop on a plain background, photorealistic. ${c.name}: ${c.description}. No text.`;
}

// Parsers

export interface ParsedScript {
  title: string;
  cast: { kind: CastKind; name: string; description: string }[];
  scenes: { heading: string; text: string }[];
}

const SCENE = /^\s*(?:SCENE\s*\d+[.:]?\s*)?((?:INT|EXT|INT\.?\/EXT)\.?\s.+)$/i;

/** Reads the plain-text script format from `scriptPrompt`. Tolerant of small deviations. */
export function parseScript(text: string): ParsedScript {
  const lines = text.replace(/\r/g, "").split("\n");
  let title = "";
  const cast: ParsedScript["cast"] = [];
  const scenes: ParsedScript["scenes"] = [];
  let inCast = false;
  let current: { heading: string; text: string[] } | null = null;
  for (const raw of lines) {
    const line = raw.replace(/^\*+|\*+$/g, "").trimEnd();
    const t = /^\s*TITLE:\s*(.+)$/i.exec(line);
    if (t) {
      title = t[1]!.trim();
      continue;
    }
    if (/^\s*CAST:\s*$/i.test(line)) {
      inCast = true;
      continue;
    }
    const sc = /^\s*SCENE\b/i.test(line) || /^\s*(INT|EXT)[./]/i.test(line) ? SCENE.exec(line) : null;
    if (sc || /^\s*SCENE\s*\d+/i.test(line)) {
      inCast = false;
      if (current) scenes.push({ heading: current.heading, text: current.text.join("\n").trim() });
      current = { heading: (sc?.[1] ?? line.replace(/^\s*SCENE\s*\d+[.:]?\s*/i, "")).trim(), text: [] };
      continue;
    }
    if (inCast) {
      const m = /^\s*[-*]\s*([^(:]+?)\s*(?:\((character|location|prop)\))?\s*:\s*(.+)$/i.exec(line);
      if (m) cast.push({ name: m[1]!.trim(), kind: (m[2]?.toLowerCase() as CastKind) ?? "character", description: m[3]!.trim() });
      else if (line.trim() === "") continue;
      continue;
    }
    if (current) current.text.push(line);
  }
  if (current) scenes.push({ heading: current.heading, text: current.text.join("\n").trim() });
  if (scenes.length === 0 && text.trim()) scenes.push({ heading: "Scene 1", text: text.trim() });
  return { title, cast, scenes };
}

/** Finds the JSON object in an LLM answer (with or without code fences). */
export function parseJsonAnswer<T>(text: string): T {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const body = fenced ? fenced[1]! : text;
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start < 0 || end < start) throw new Error("The model's answer had no JSON in it");
  return JSON.parse(body.slice(start, end + 1)) as T;
}

export interface BoardShot {
  description: string;
  camera?: string;
  cast?: string[];
  dialogue?: { speaker?: string | null; text: string }[];
  duration?: number;
}

export function parseStoryboard(text: string): BoardShot[] {
  const data = parseJsonAnswer<{ shots?: unknown }>(text);
  if (!Array.isArray(data.shots)) throw new Error("The storyboard answer had no shots");
  return data.shots
    .filter((s): s is BoardShot => !!s && typeof (s as BoardShot).description === "string")
    .map((s) => ({
      description: s.description.slice(0, 4000),
      camera: typeof s.camera === "string" ? s.camera.slice(0, 500) : "",
      cast: Array.isArray(s.cast) ? s.cast.filter((x): x is string => typeof x === "string") : [],
      dialogue: Array.isArray(s.dialogue)
        ? s.dialogue
            .filter((d) => d && typeof d.text === "string")
            .map((d) => ({ speaker: typeof d.speaker === "string" ? d.speaker : null, text: d.text.slice(0, 1000) }))
        : [],
      duration: typeof s.duration === "number" && s.duration > 0 ? Math.min(30, s.duration) : 5,
    }));
}

/** Script dialogue lines ("NAME: text") in order, for subtitles and TTS. */
export function scriptDialogue(text: string): { speaker: string; text: string }[] {
  const out: { speaker: string; text: string }[] = [];
  for (const line of text.split("\n")) {
    const m = /^\s*([A-Z][A-Z0-9 .'-]{0,40}?)\s*(?:\([^)]*\))?\s*:\s*(.+)$/.exec(line);
    if (m && !/^(TITLE|CAST|SCENE|INT|EXT)\b/.test(m[1]!)) out.push({ speaker: m[1]!.trim(), text: m[2]!.trim() });
  }
  return out;
}
