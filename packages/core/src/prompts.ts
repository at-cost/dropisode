/**
 * Prompts for the LLM steps and the image and video models, and parsers for
 * what comes back. Character consistency comes from two things used in every
 * shot: the same written description of each cast member, and the same
 * reference images (see generate.ts). The approach follows ViMax's
 * character-consistency pipeline (HKUDS/ViMax, MIT); the text here is our own.
 */
import type { Aspect, Beat, CastKind, CastMember, CastNote, CountRule, Shot } from "./project";

/** The fields sequences added to a shot: prompts work on shots from before them too. */
type SequenceKeys = "beats" | "logline" | "startState" | "sounds" | "slowMotion" | "writtenPrompt" | "writtenFor" | "promptStale";
export type ShotLike = Omit<Shot, SequenceKeys> & Partial<Pick<Shot, SequenceKeys>>;

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

/** maxTokens includes the model's reasoning (mandatory on Gemini 3.8 Flash), so it is generous; we pay for what is used. */
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
      "Make every character instantly tell-apart-able from the others at a glance: different age, hair colour and style, build, face shape and a signature wardrobe colour. Never two people of the same sex and similar age with similar hair.",
    ].join("\n"),
    maxTokens: 8000,
  };
}

export function castExtractPrompt(script: string): LlmPrompt {
  return {
    system: "You extract a production cast list from a script. Answer with JSON only.",
    prompt: [
      "List every character, location and recurring prop in this script with a fixed visual description (age, build, hair, face, wardrobe; for places, look and light).",
      "Make every character instantly tell-apart-able from the others at a glance: different age, hair colour and style, build, face shape and a signature wardrobe colour. Never two people of the same sex and similar age with similar hair. Keep what the script says; where it is silent, choose contrasting looks.",
      'Answer as {"cast":[{"kind":"character|location|prop","name":"...","description":"..."}]}.',
      "",
      "SCRIPT:",
      script.slice(0, 30_000),
    ].join("\n"),
    maxTokens: 8000,
  };
}

export function storyboardPrompt(p: {
  sceneScript: string;
  heading: string;
  cast: CastMember[];
  targetSeconds?: number;
  durations: number[];
  /** The video model makes silent clips; every line becomes a voice-over afterwards. */
  silentVideo?: boolean;
  /** Long chained takes (deliberate cuts only), quick vertical-drama cuts, or multi-shot sequences. */
  cutting?: "continuous" | "cuts" | "sequences";
}): LlmPrompt {
  if (p.cutting === "sequences") return sequenceBoardPrompt(p);
  const durations = p.durations.length ? p.durations.join(", ") : "5";
  const continuous = p.cutting !== "cuts";
  return {
    system:
      "You are a storyboard artist for short vertical dramas. You break a scene into shots a video model can render: one clear beat per shot, the camera stated, characters named exactly as in the cast list. Answer with JSON only.",
    prompt: [
      `SCENE: ${p.heading}`,
      p.sceneScript.slice(0, 20_000),
      "",
      "CAST (use these names exactly):",
      ...p.cast.map((c) => `- ${c.name} (${c.kind})`),
      "",
      `Break the scene into shots${p.targetSeconds ? ` totalling about ${p.targetSeconds} seconds` : ""}. Each shot's duration must be one of: ${durations} seconds.`,
      ...(continuous
        ? [
            "Plan the scene as a few long, continuous takes, not a new camera angle every few seconds. Each shot is one unbroken take that carries one clear beat; prefer the longest allowed durations, and never split one continuous action across shots.",
            'Every shot carries straight on from the one before (the camera keeps rolling): set "continues": true, except where a deliberate cut serves the story (a jump in time, a reveal): then "continues": false. The first shot never continues.',
            "A shot that continues starts at the exact moment the previous one ended: describe it from there and never repeat an action the previous shot already finished (a hand already taken stays taken, someone already standing stays standing).",
            "Describe action that keeps moving through to the very end of every shot; never ask it to slow down, settle, hold or freeze at the end.",
            'When a shot changes place, era or age (a memory, a transformation, time passing), describe its final moment in "endPicture" (the same camera position as the shot\'s start, only the changed place, age, clothes and pose), and hide the change inside a movement: a spin, a turn away from camera, someone passing close to the lens. Everything changes at the same moment, never one feature before the others. Otherwise "endPicture" is "".',
            "To make someone disappear, have something pass close in front of the camera (a shoulder, a back) and have them gone when it clears; never let them fade.",
            "Whoever speaks is seen saying the line, briefly: one or two short sentences per shot. No cutaways.",
            'Lines the script marks V.O. or O.S. are heard, not seen spoken: put them in shots with "voiceOver": true and show the person with their mouth closed.',
            "The video model can't write legible text: never rely on printed words being read on screen.",
          ]
        : p.silentVideo
          ? [
              "Plan the shots as one flowing scene: establish where everyone is, then move closer; vary the angle from shot to shot so the viewer always knows where they are.",
            ]
          : [
              "Cut it the way vertical short dramas are cut: the picture changes every 2 to 4 seconds, and most shots are close-ups or medium close-ups of faces. Open on one establishing shot, then stay close.",
              "Every cut changes both the camera angle and the shot size from the shot before (wide to close-up, low angle to high, side-on to overhead). Never put two similar framings of the same moment next to each other: the viewer reads that as a jump, not a cut.",
              "Cut on action: end a shot in the middle of a movement and let the next shot, from its new angle, carry the same movement on.",
              "Keep each character on the same side of the screen for the whole scene, so the viewer always knows who is where, even in a fast fight.",
              "Vary the length to the beat: about 1 to 2 seconds for a strike, a glance or a reaction, 3 to 5 for a set piece or a reveal. Use the shortest allowed duration when the moment is short: the edit trims each take to its best moment.",
              "Whoever speaks is seen saying the line: facing the camera or three-quarter on, mouth moving. One speaker per shot, and pick the shortest duration that fits their words (about 2.5 words a second).",
              'The cut that makes it feel real: while someone is still talking, cut to the person listening (their face reacting) or to a detail (hands, a prop), and the line carries on underneath. Do it with a cutaway shot right after the speaking shot: "cutaway": {"at": seconds into the speaking shot where the picture cuts away, "length": 1.5 to 3}. A cutaway has no dialogue, nobody in it speaks, and its duration is the shortest allowed. Give most lines longer than 3 seconds a cutaway, and keep every cutaway inside its speaking shot.',
              "Sometimes, instead, let the camera drift or pan off the speaker onto a listener while the speaker keeps talking: say so in the description and camera.",
              'Lines the script marks V.O. or O.S. (inner thoughts, narration, a voice from a memory or off screen) are heard but not seen spoken: put them in their own shots with "voiceOver": true, and show the person thinking with their mouth closed, or what they are looking at. Never mix spoken and V.O. lines in one shot.',
              'When a shot picks up exactly where the previous one ends (same moment, the camera simply carrying on), set "continues": true.',
              "The video model can't write legible text: never rely on printed words being read on screen. Let a character say it, or keep it out of focus.",
            ]),
      "Let tension build; don't rush to the action. Before anything happens, show where we are: the place, the hour, the weather, that someone is alone. Give the audience a moment to notice something before the character does. Quiet shots belong here: an establishing shot of the place, a slow look at a detail that matters later, someone waiting.",
      "Every shot has something moving during it, described as it unfolds: an action or reaction (someone turns, looks up, flinches, grips something, steps forward), or, in a quiet shot, the place itself (rain, a flickering light, breath in cold air, a slow camera push). Never a still picture.",
      "Say where each person looks, consistent with the staging: someone watching the funeral looks towards it, not into the camera. A close-up shows only the head and shoulders; say whose hands they are in a hands shot.",
      "Put each line of dialogue in the shot where it is spoken, with its speaker.",
      "Speakers: use the speaker the script names. If that speaker is not in the cast list (a voice from a memory, a crowd, an announcer), set speaker to null. Never give a line to a different character.",
      "Keep every concrete detail the script gives in the description: on-screen text quoted exactly as written, props, clothes, injuries, weather, who faces which way.",
      "Each description must stand alone: a video model sees only that description and the cast's reference images.",
      'A shot\'s "cast" lists only who is visible in it: the video model draws everyone it is given, so a close-up of one character lists only that character.',
      ...(p.silentVideo
        ? [
            "The video is silent and every line is added afterwards as a voice-over, so nobody may be seen speaking. Stage each speaker from behind, off screen, out of focus or in shadow, and say in the description that everyone visible keeps their mouth closed.",
            'When a shot picks up exactly where the previous one ends, set "continues": true.',
          ]
        : []),
      'First fix the staging in "staging": a short paragraph saying where each character is in the place at the start of the scene, which way they face, how they move during it, and who must not notice whom (someone hiding stays at the back, unseen). Every shot must keep to it, and only people the staging puts near each other share a frame.',
      `Camera: pick from ${CAMERA_PRESETS.join("; ")}, or describe your own.`,
      continuous
        ? 'Answer as {"staging":"...","shots":[{"description":"what we see","camera":"...","cast":["NAME"],"dialogue":[{"speaker":"NAME","text":"..."}],"duration":10,"continues":true,"endPicture":"","voiceOver":false}]}.'
        : 'Answer as {"staging":"...","shots":[{"description":"what we see","camera":"...","cast":["NAME"],"dialogue":[{"speaker":"NAME","text":"..."}],"duration":4,"continues":false,"voiceOver":false,"cutaway":null}]}.',
    ].join("\n"),
    maxTokens: 10000,
  };
}

/** The longest and shortest sequence the storyboard asks for, within what the model renders. */
export function sequenceRange(durations: number[]): { min: number; max: number } {
  const ok = durations.length ? durations : [5, 10];
  const lo = Math.min(...ok);
  const hi = Math.max(...ok);
  return { min: Math.max(lo, Math.min(6, hi)), max: Math.min(hi, 15) };
}

/**
 * Fast action, planned the way multi-shot video models work best: each generation is a sequence of
 * 2 to 4 shots with hard cuts inside it, so the model keeps the world and light across the cuts.
 * Also fixes the scene's world (plate), each character's real size and anatomy, and the counts.
 */
function sequenceBoardPrompt(p: {
  sceneScript: string;
  heading: string;
  cast: CastMember[];
  targetSeconds?: number;
  durations: number[];
  silentVideo?: boolean;
}): LlmPrompt {
  const { min, max } = sequenceRange(p.durations);
  return {
    system:
      "You are a film director and storyboard artist planning fast, physical scenes for a multi-shot video model. You think in sequences: one generation holds two to four shots with hard cuts between them. You give every shot a real camera (size, angle, height, lens, movement) and every character its real size and anatomy. Answer with JSON only.",
    prompt: [
      `SCENE: ${p.heading}`,
      p.sceneScript.slice(0, 20_000),
      "",
      "CAST (use these names exactly):",
      ...p.cast.map((c) => `- ${c.name} (${c.kind}): ${c.description.slice(0, 300)}`),
      "",
      `Plan the scene as sequences${p.targetSeconds ? ` totalling about ${p.targetSeconds} seconds` : ""}. Each sequence is ONE generation of ${min} to ${max} seconds holding 2 to 4 shots ("beats") with hard cuts between them.`,
      "Beat times are seconds inside their sequence: the first starts at 0, each starts where the one before ends, no gaps. A beat lasts 1.5 to 5 seconds: shorter for a strike, a glance or a reaction, longer for a set piece.",
      "Every cut changes both the shot size and the angle. For each beat give: size (EWS, WS, MWS, MS, MCU, CU or ECU), angle (low front-left, water-level frontal oblique, worm's-eye, top-down), camera height (30 cm above the water, at the ice edge), lens in millimetres, and one movement (locked, handheld, lateral dolly, snap zoom, crane). Prefer low, specific angles over centred eye-level coverage.",
      'Each beat\'s "action" tells what happens as it unfolds, with real physical weight: mass, momentum, inertia, follow-through, spray and debris that carry weight. Its "endsWith" is the state it leaves in its last frame (who is where, facing which way), so the next cut lands. "from" and "to" are its times in seconds.',
      'A sequence\'s "start" says where everyone is as it begins: it carries on from the previous sequence\'s last "endsWith", not from the scene\'s opening staging.',
      'Give each sequence 3 to 8 specific diegetic "sounds", each heard once (one huff-snort, one heavy splash, ice chips scattering), never music. Set "slowMotion": true only where the script asks for slow motion.',
      'Fix the world once in "plate": the place, weather, light, water or ground, and every fixed prop with its real size in metres or centimetres. It stays the same in every shot.',
      'For each character in "characters": its real size in numbers (45 cm tall, 2.6 metres long), its correct real anatomy (for an animal: its true species and body parts; never human hands, arms or poses it doesn\'t have), one small acting detail (a nostril flare, a crest that lifts), and the side of the screen it keeps for the whole scene ("left" or "right").',
      'Say in "counts" how many of each character and important prop may be in frame (usually one each), and list everything that may be visible in "whitelist". In "grade": palette, contrast and key light.',
      "Comedy and action are played completely straight. The video model can't write legible text: never rely on printed words.",
      'A sequence\'s "cast" lists only who is visible in it. Put each line of dialogue in the sequence where it is spoken, with its speaker; use the speaker the script names, or null for someone outside the cast.',
      ...(p.silentVideo ? ["The video is silent and every line is added later as a voice-over: nobody is seen speaking."] : []),
      'Also give "staging": a short paragraph saying where everyone is at the very start of the scene and which way they face.',
      'Answer as {"staging":"...","plate":"...","grade":"...","characters":[{"name":"NAME","size":"...","anatomy":"...","acting":"...","side":"left"}],"counts":[{"what":"penguins","n":1}],"whitelist":["..."],"sequences":[{"logline":"one sentence","start":"...","cast":["NAME"],"dialogue":[{"speaker":"NAME","text":"..."}],"sounds":["..."],"slowMotion":false,"beats":[{"from":0,"to":4,"size":"EWS","angle":"...","height":"...","lens":"24mm","movement":"locked","action":"...","endsWith":"..."}]}]}.',
    ].join("\n"),
    maxTokens: 16000,
  };
}

export interface BoardSequence {
  logline: string;
  start: string;
  cast: string[];
  dialogue: { speaker: string | null; text: string }[];
  sounds: string[];
  slowMotion: boolean;
  beats: Beat[];
}

export interface SequencePlan {
  staging: string;
  plate: string;
  grade: string;
  castNotes: CastNote[];
  counts: CountRule[];
  whitelist: string[];
  sequences: BoardSequence[];
}

const str = (v: unknown, max: number): string => (typeof v === "string" ? v.trim().slice(0, max) : "");

/**
 * Reads a sequences storyboard. Beats are re-timed back to back from 0 (keeping each one's length),
 * so a model's sloppy times can never overlap or leave gaps.
 */
export function parseSequenceBoard(text: string): SequencePlan {
  const d = parseJsonAnswer<Record<string, unknown>>(text);
  const seqs = Array.isArray(d.sequences) ? d.sequences : [];
  if (!seqs.length) throw new Error("The storyboard answer had no sequences");
  const sequences: BoardSequence[] = [];
  for (const raw of seqs) {
    const s = (raw ?? {}) as Record<string, unknown>;
    const rawBeats = Array.isArray(s.beats) ? (s.beats as Record<string, unknown>[]) : [];
    let at = 0;
    const beats: Beat[] = [];
    for (const b of rawBeats.slice(0, 6)) {
      if (!b || typeof b !== "object") continue;
      const num = (...vs: unknown[]) => vs.find((v): v is number => typeof v === "number") ?? Number.NaN;
      const start = num(b.from, b.start, b.startS);
      const end = num(b.to, b.end, b.endS);
      const len = Number.isFinite(start) && Number.isFinite(end) && end > start ? end - start : 3;
      const dur = Math.round(Math.max(1, Math.min(8, len)) * 10) / 10;
      if (at + dur > 30) break;
      beats.push({
        startS: Math.round(at * 10) / 10,
        endS: Math.round((at + dur) * 10) / 10,
        size: str(b.size, 80),
        angle: str(b.angle, 160),
        height: str(b.height, 160),
        lens: str(b.lens, 80),
        movement: str(b.movement, 160),
        action: str(b.action, 2000),
        endState: str(b.endsWith ?? b.endState ?? (typeof b.end === "string" ? b.end : ""), 600),
      });
      at += dur;
    }
    if (!beats.length) continue;
    sequences.push({
      logline: str(s.logline, 600),
      start: str(s.start, 1000),
      cast: Array.isArray(s.cast) ? s.cast.filter((x): x is string => typeof x === "string") : [],
      dialogue: Array.isArray(s.dialogue)
        ? (s.dialogue as { speaker?: unknown; text?: unknown }[])
            .filter((x) => x && typeof x.text === "string" && x.text.trim())
            .map((x) => ({ speaker: typeof x.speaker === "string" ? x.speaker : null, text: String(x.text).slice(0, 1000) }))
        : [],
      sounds: Array.isArray(s.sounds)
        ? s.sounds
            .filter((x): x is string => typeof x === "string")
            .map((x) => x.slice(0, 200))
            .slice(0, 20)
        : [],
      slowMotion: s.slowMotion === true,
      beats,
    });
  }
  if (!sequences.length) throw new Error("The storyboard answer had no usable sequences");
  const castNotes = (Array.isArray(d.characters) ? (d.characters as Record<string, unknown>[]) : [])
    .filter((c) => c && typeof c.name === "string")
    .slice(0, 20)
    .map((c) => ({
      name: str(c.name, 120),
      size: str(c.size, 200),
      anatomy: str(c.anatomy, 1000),
      acting: str(c.acting, 400),
      side: str(c.side, 60),
    }));
  const counts = (Array.isArray(d.counts) ? (d.counts as Record<string, unknown>[]) : [])
    .filter((c) => c && typeof c.what === "string" && typeof c.n === "number" && Number.isInteger(c.n) && c.n >= 0 && c.n < 100)
    .slice(0, 30)
    .map((c) => ({ what: str(c.what, 120), n: c.n as number }));
  return {
    staging: str(d.staging, 3000),
    plate: str(d.plate, 3000),
    grade: str(d.grade, 1000),
    castNotes,
    counts,
    whitelist: Array.isArray(d.whitelist)
      ? d.whitelist
          .filter((x): x is string => typeof x === "string")
          .map((x) => x.slice(0, 200))
          .slice(0, 40)
      : [],
    sequences,
  };
}

/** A sequence as plain direction: what older code (first frames, the cut) reads as the shot's description. */
export function sequenceDescription(s: { logline: string; beats: Beat[] }): string {
  return [s.logline, ...s.beats.map((b) => b.action)]
    .filter((x) => x.trim())
    .join(" ")
    .slice(0, 4000);
}

const describe = (c: CastMember) => `${c.name}: ${c.description}`.trim();

/** The first-frame prompt. Every cast member's fixed description goes in, every time. */
export function framePrompt(p: {
  shot: ShotLike;
  cast: CastMember[];
  location?: CastMember | undefined;
  aspect: Aspect;
  /** The shot's lines are a voice-over added later: nobody on screen may look mid-word. */
  voiceOver?: boolean;
  /** The first reference image is the scene's master still. */
  fromMaster?: boolean;
  /** How the scene starts: where everyone is at its opening. */
  staging?: string;
  /** This is the scene's opening shot, so the staging is where everyone is now. */
  opening?: boolean;
  /** How many of each character or prop may be in frame. */
  counts?: CountRule[];
}): string {
  const people = p.cast.filter((c) => c.kind !== "location");
  const characters = people.filter((c) => c.kind === "character");
  const now = p.shot.startState?.trim();
  const place = p.location ?? p.cast.find((c) => c.kind === "location");
  return [
    `A single cinematic film still, ${p.aspect === "9:16" ? "vertical 9:16" : "horizontal 16:9"} frame, photorealistic, natural light, shallow depth of field.`,
    `Shot: ${p.shot.description}`,
    p.shot.camera ? `Camera: ${p.shot.camera}.` : "",
    people.length ? `Characters (keep them exactly as in the reference images): ${people.map(describe).join(" | ")}` : "",
    place ? `Setting: ${describe(place)}` : "",
    p.fromMaster
      ? "The first reference image is this scene's master shot: keep its place, light, weather, time of day and everyone's clothes exactly. Make a new camera position on it, as this shot describes (closer, or from another side). Never copy the master's framing. The other reference images show faces only."
      : "",
    ...framing(p.shot, people.length > 0, !!place),
    // The staging describes the scene's start; a later shot says where everyone is now (they may have moved).
    now ? `Where everyone is at this moment: ${now}` : "",
    p.staging?.trim()
      ? p.opening && !now
        ? `Where everyone is at the start of the scene (this shot is that moment; keep to it): ${p.staging.trim()}`
        : `How the scene started (for sides of the screen and who is hidden from whom; where the shot says someone has moved, follow the shot): ${p.staging.trim()}`
      : "",
    isDetailShot(p.shot)
      ? "Only the detail the shot describes fills the frame, sharp; nobody else standing in the background looking on."
      : characters.length
        ? `The only characters in this frame: ${characters.map((c) => c.name).join(", ")}, one of each and never a second copy. Anyone else is an unnamed extra, out of focus.`
        : "",
    ...countLines(p.counts ?? []),
    p.shot.onScreenText?.trim() ? "Any card, sign, paper or screen in the shot is blank: its text is added afterwards." : "",
    p.voiceOver ? "Nobody in the frame is speaking: every mouth is closed." : "",
    ...speakerFacing(p.shot, people, !!p.voiceOver),
    "No captions, subtitles or watermarks. Show only text the shot itself describes.",
  ]
    .filter(Boolean)
    .join("\n");
}

/** The scene's master still: everyone in the place at the start of the scene, lit by it. */
export function sceneMasterPrompt(p: {
  heading: string;
  script: string;
  staging?: string;
  place?: CastMember | undefined;
  people: CastMember[];
  aspect: Aspect;
}): string {
  const staging = p.script
    .split(/\r?\n/)
    .filter((l) => l.trim() && !SPOKEN.test(l))
    .join(" ")
    .slice(0, 900);
  return [
    `A single cinematic establishing film still, ${p.aspect === "9:16" ? "vertical 9:16" : "horizontal 16:9"} frame, photorealistic, natural light: the master shot of this scene. One photograph of one moment, never a collage, grid, split screen or storyboard of several moments.`,
    `Scene: ${p.heading}.`,
    p.place ? `Place: ${describe(p.place)}` : "",
    p.people.length ? `Everyone in the scene is here, where the scene starts: ${p.people.map(describe).join(" | ")}` : "",
    p.staging?.trim()
      ? `Staging, keep to it exactly (where each person is, which way they face, who is hidden from whom). Show only its first moment, even where it says what happens later: ${p.staging.trim()}`
      : staging
        ? `What happens (stage them for its opening moment): ${staging}`
        : "",
    "Everyone is really in this place: lit by its light and weather (wet if it rains), at true size, resting on the ground, water or a seat as the place allows, each recognisable and each shown once.",
    "The reference images show the place and who each character is. Do not copy their framing, plain backgrounds or studio lighting.",
    "No captions, subtitles, text or watermarks.",
  ]
    .filter(Boolean)
    .join("\n");
}

/** Extreme close-ups and inserts: hands, an object, a detail. */
export function isDetailShot(shot: { camera: string; description?: string }): boolean {
  const re = /\b(extreme close|ecu|insert|macro|detail shot)\b/i;
  return re.test(shot.camera) || re.test((shot.description ?? "").slice(0, 40));
}

/** Wide, establishing and full shots: the only ones that show the whole place. */
export function isWideShot(shot: { camera: string; description?: string }): boolean {
  const re = /\b(wide|establishing|long shot|full shot|full-body|aerial|crane|master shot|drone)\b/i;
  return re.test(shot.camera) || re.test((shot.description ?? "").slice(0, 40));
}

/** How big people are in the frame, and how they belong in the place rather than being pasted onto it. */
function framing(shot: ShotLike, hasPeople: boolean, hasPlace: boolean): string[] {
  const cam = `${shot.camera} ${shot.description.slice(0, 40)}`.toLowerCase();
  const scale = /extreme close|ecu|insert|macro/.test(cam)
    ? "Extreme close-up: one detail fills the frame."
    : /close/.test(cam) && !/medium close/.test(cam)
      ? "Close-up: the subject's head (or the one part the shot is about) fills the frame, a little space above it."
      : /medium close|over.the.shoulder|ots|two.shot|two shot/.test(cam)
        ? "Medium close-up: the upper half of the subject, the face large in the frame."
        : /medium/.test(cam)
          ? "Medium shot: about half of the subject's body in frame."
          : isWideShot(shot)
            ? "Wide shot: the whole place, everyone at true size within it."
            : "";
  const out = scale ? [scale] : [];
  out.push(
    "Compose like a film, not a portrait: the subject off-centre on a third, the camera at a slight angle, and nothing planted in the middle of the foreground.",
  );
  if (hasPeople)
    out.push(
      "The reference images show only who each character is (face, markings, build, clothes if any). Do not copy their pose, framing, lighting or plain background. Each character is really here: lit by this place's light and weather (wet if it rains), at true size, resting on the ground, water or a seat as the place allows, with the same lens depth of field as everything else. Never a cut-out pasted onto a background.",
    );
  if (hasPlace && !isWideShot(shot))
    out.push(
      "Behind them, the setting seen from this shot's own angle, soft and out of focus. Never the same view as an establishing shot.",
    );
  else if (hasPlace) out.push("Use the setting's reference image for its look, light and weather, framed from this shot's own angle.");
  return out;
}

/** Whoever speaks on camera must be seen saying it: face to the camera, never their back. */
function speakerFacing(shot: ShotLike, people: CastMember[], voiceOver: boolean): string[] {
  if (voiceOver) return [];
  const names = [
    ...new Set(shot.dialogue.filter((l) => l.text.trim() && l.castId).map((l) => people.find((c) => c.id === l.castId)?.name)),
  ].filter((n): n is string => !!n);
  return names.length
    ? [
        `${names.join(" and ")} is speaking in this shot: their face turned towards the camera, three-quarter on, mouth clearly visible and lips parted mid-word, eyes on the person they are talking to just beside the camera. Never from behind, and never looking straight into the lens.`,
      ]
    : [];
}

/** The image-to-video prompt. Native-audio models get the dialogue to speak. */
export function videoPrompt(p: {
  shot: ShotLike;
  cast: CastMember[];
  nativeAudio: boolean;
  /** With native audio: whether the clip speaks its lines (false: room sound only, the lines are a voice-over). */
  speak?: boolean;
  /** How many of each character or prop may be in frame. */
  counts?: CountRule[];
}): string {
  const speak = p.speak ?? true;
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
    p.nativeAudio && speak && lines.length ? `${lines.join(" ")} Each line is spoken once, clearly, by that person on camera.` : "",
    p.nativeAudio && (!speak || !lines.length) ? "Nobody speaks: every mouth stays closed. Natural ambient sound only, no music." : "",
    p.nativeAudio && speak && lines.length ? "Natural ambient sound under the voices. No music." : "",
    p.shot.endPicture?.trim()
      ? `By the end of the shot: ${p.shot.endPicture.trim()} The change happens inside the movement, with everything changing at the same moment. Keep moving right through the final moment; never slow down or pause at the end.`
      : "",
    !p.nativeAudio && lines.length ? "Nobody speaks on screen: every mouth stays closed." : "",
    ...videoGuards(p.shot, p.cast, p.counts ?? []),
  ]
    .filter(Boolean)
    .join(" ");
}

/**
 * What every clip is held to: each character's look from the first frame, one of each (models invent doubles),
 * and life in the picture. Only a quiet talking shot gets "breathe and blink"; the camera moves only as the shot says.
 */
function videoGuards(shot: ShotLike, cast: CastMember[], counts: CountRule[]): string[] {
  const characters = cast.filter((c) => c.kind === "character");
  const talking = shot.dialogue.some((l) => l.text.trim());
  const quiet = talking && !ACTION.test(`${shot.camera} ${shot.description}`);
  return [
    characters.length
      ? `Keep every character's look (face, markings, build, clothes) consistent with the first frame. Exactly one of each: ${characters.map((c) => c.name).join(", ")}; nobody is doubled.`
      : "",
    ...countLines(counts),
    quiet
      ? "It is live action, never a still: whoever is on screen breathes, blinks and reacts while they talk."
      : "It is live action, never a still: the action keeps moving through the whole shot.",
    shot.camera.trim() ? "The camera does only what the camera note says." : "",
    "One full frame throughout: no split screen, no on-screen text.",
  ].filter(Boolean);
}

/** Words that mark a shot as action, not a quiet talking moment. */
const ACTION =
  /\b(fight|strike|kick|punch|run|chase|leap|jump|dive|crash|explod|slam|whip|tumble|lunge|spin|attack|flee|race|fall|throw|splash)/i;

/** "Count of penguins in frame: one." for each rule. */
function countLines(counts: CountRule[]): string[] {
  return counts.length ? [counts.map((c) => `Count of ${c.what.trim()} in frame: ${NUM[c.n] ?? c.n}.`).join(" ")] : [];
}
const NUM = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"];

/**
 * The picture a shot ends on, made by editing the shot's own first frame (the START image): same camera,
 * only what the shot changes. The character pictures that follow keep the faces.
 */
export function endFramePrompt(p: { shot: ShotLike; cast: CastMember[]; aspect: Aspect }): string {
  const people = p.cast.filter((c) => c.kind === "character");
  return [
    "Edit the first image, START: keep exactly the same camera position, height, lens and framing, with the people in the same place and at the same size in the frame.",
    `Change only this: ${p.shot.endPicture.trim()}`,
    people.length ? `The same people, with the faces of their reference pictures: ${people.map(describe).join(" ")}` : "",
    `Photorealistic, natural skin and light, ${p.aspect === "16:9" ? "horizontal 16:9" : "vertical 9:16"}. Nobody looks into the lens. No text.`,
  ]
    .filter(Boolean)
    .join(" ");
}

export function castImagePrompt(c: CastMember): string {
  if (c.kind === "character") {
    // Characters are not always people: an animal or creature is photographed as itself, never as an actor in costume.
    return `Reference photo of one character: ${c.name}: ${c.description}. If this character is a person: a casting photo of a real actor standing upright, framed from the knees up, a slight three-quarter turn, arms relaxed at their sides, relaxed natural expression, soft natural daylight, a plain neutral wall behind; real skin texture with pores and small imperfections, natural hair, not retouched, not a studio glamour shot. If it is an animal, creature or machine: a sharp, naturally lit photo of the whole of it as itself, at its true size and shape, its distinguishing marks clearly visible, against a plain uncluttered background; no person, no costume. No text.`;
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
  continues?: boolean;
  endPicture?: string;
  onScreenText?: string;
  voiceOver?: boolean;
  cutaway?: { at: number; length: number } | null;
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
      duration: typeof s.duration === "number" && s.duration > 0 ? Math.min(30, s.duration) : 8,
      continues: s.continues === true,
      endPicture: typeof s.endPicture === "string" ? s.endPicture.trim().slice(0, 2000) : "",
      onScreenText: typeof s.onScreenText === "string" ? s.onScreenText.slice(0, 300) : "",
      voiceOver: s.voiceOver === true,
      cutaway:
        s.cutaway && typeof s.cutaway.at === "number" && typeof s.cutaway.length === "number" && s.cutaway.length > 0
          ? { at: Math.max(0, Math.min(60, s.cutaway.at)), length: Math.max(0.5, Math.min(8, s.cutaway.length)) }
          : null,
    }));
}

/** The storyboard's staging: where everyone is, who is hidden from whom. */
export function parseStaging(text: string): string {
  try {
    const d = parseJsonAnswer<{ staging?: unknown }>(text);
    return typeof d.staging === "string" ? d.staging.trim().slice(0, 3000) : "";
  } catch {
    return "";
  }
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

/** Matches a script line like `NORA (V.O.): That's me.` or `TWO GIRLS (V.O., faint): ...`. */
const SPOKEN = /^\s*([A-Z][A-Z0-9 .'&-]{0,40}?)\s*(?:\([^)]*\))?\s*:\s*(.+)$/;
export const normalizeLine = (t: string) => normLine(t);
const normLine = (t: string) =>
  t
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

/**
 * Who the script says speaks each line, keyed by the line's text. The storyboard model is
 * told to keep speakers, but this makes it certain: a line the script gives to someone
 * outside the cast (a memory, a crowd) can't end up with a cast member's voice.
 */
export function scriptSpeakers(script: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of script.split(/\r?\n/)) {
    const m = SPOKEN.exec(line);
    if (m) out.set(normLine(m[2]!), m[1]!.trim());
  }
  return out;
}

/** Lines the script marks as heard but not seen spoken: (V.O.), (O.S.), (O.C.). */
export function scriptVoiceOvers(script: string): Set<string> {
  const out = new Set<string>();
  for (const line of script.split(/\r?\n/)) {
    const m = /^\s*[A-Z][A-Z0-9 .'&-]{0,40}?\s*\(([^)]*)\)\s*:\s*(.+)$/.exec(line);
    if (m && /\b(V\.?\s?O|O\.?\s?S|O\.?\s?C)\b/i.test(m[1]!)) out.add(normLine(m[2]!));
  }
  return out;
}

/** The speaker the script gives a line, if the script has that line. */
export function scriptSpeakerFor(speakers: Map<string, string>, text: string): string | undefined {
  const n = normLine(text);
  if (!n) return undefined;
  const exact = speakers.get(n);
  if (exact) return exact;
  for (const [line, who] of speakers) if (line.length > 12 && (line.includes(n) || n.includes(line))) return who;
  return undefined;
}

/** An episode runs 60 to 75 seconds; a scene gets its share by script length. */
export const EPISODE_TARGET_SECONDS = 65;
export function sceneTargetSeconds(sceneScript: string, episodeScripts: string[]): number {
  const total = episodeScripts.reduce((a, s) => a + s.length, 0) || 1;
  return Math.max(10, Math.round((EPISODE_TARGET_SECONDS * sceneScript.length) / total));
}
