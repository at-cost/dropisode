/** The kung fu part of the penguin and seal story, planned by hand: shared by the tests and the example prompt. */
import type { SequenceContext } from "../src/writer";
import type { Scene, Shot } from "../src/project";

export const PENGUIN = {
  id: "c_p",
  kind: "character" as const,
  name: "Penguin",
  description: "a small wild rockhopper penguin: black back, white belly, red eyes, spiky yellow crest, pink feet",
  refImageIds: [],
};
export const SEAL = {
  id: "c_s",
  kind: "character" as const,
  name: "Seal",
  description: "a huge grey bull seal: silver-grey mottled hide, thick neck, long white whiskers",
  refImageIds: [],
};

export function kungFuShot(): Shot {
  return {
    id: "shot_kf",
    description: "Kung fu on the ice.",
    camera: "",
    castIds: ["c_p", "c_s"],
    dialogue: [],
    durationS: 11,
    audio: "native",
    approved: false,
    takes: [],
    continueFromPrevious: false,
    endPicture: "",
    onScreenText: "",
    cutaway: null,
    joinIn: "cut",
    joinS: 0.5,
    move: "none",
    beats: [
      {
        startS: 0,
        endS: 3,
        size: "MWS",
        angle: "worm's-eye",
        height: "at the ice edge",
        lens: "24mm",
        movement: "locked",
        action:
          "The seal whips its broad rear flippers across the ice like a bullwhip; the penguin plants its flippers and cartwheels sideways under the passing tail, ice crystals spraying and settling.",
        endState: "the penguin upright on the left, the seal's tail recovering on the right",
      },
      {
        startS: 3,
        endS: 6,
        size: "MCU",
        angle: "side-on 15-degree dutch",
        height: "at the ice edge",
        lens: "85mm",
        movement: "lateral dolly",
        action:
          "The penguin launches one compact back handspring, flippers whirling like nunchucks; the seal lunges from its barrel chest and snaps its jaws shut on empty air.",
        endState: "the penguin balanced on one pink foot, crest quivering, the seal's head overshooting forward",
      },
      {
        startS: 6,
        endS: 9,
        size: "WS",
        angle: "low three-quarter",
        height: "just above the ice",
        lens: "28mm",
        movement: "handheld track",
        action:
          "The seal braces and sweeps its tail in a broad arc that catches the penguin square across the chest with a heavy thud; the penguin tumbles backwards over the floe's left edge.",
        endState: "the penguin out of frame over the water, the seal's tail finishing its follow-through",
      },
      {
        startS: 9,
        endS: 11,
        size: "EWS",
        angle: "low oblique toward the floe's left edge",
        height: "at the ice edge",
        lens: "35mm",
        movement: "locked",
        action:
          "The penguin hits the black water in a heavy burst of spray and vanishes; the seal heaves across the floe, leans its huge head over the water and slowly grins.",
        endState: "the seal grinning smugly over the spreading rings",
      },
    ],
    logline:
      "A small rockhopper penguin acrobatically dodges a huge grey seal until one sweeping tail strike knocks it off the ice, leaving the seal grinning over the water.",
    startState: "Both animals squared up on the floe: the penguin on its left half, the seal on its right half.",
    sounds: [
      "low Southern Ocean wash",
      "tail whip with a sharp crack",
      "ice chips scattering",
      "wet flipper slaps on ice",
      "one body thud",
      "jaws snapping shut",
      "one heavy splash",
      "one smug seal huff",
    ],
    slowMotion: false,
    writtenPrompt: "",
    writtenFor: "",
    promptStale: false,
  };
}

export const PLAN: Pick<Scene, "heading" | "script" | "staging" | "plate" | "grade" | "castNotes" | "counts" | "whitelist"> = {
  heading: "EXT. HARBOUR ICE - MORNING",
  script: "The penguin and the seal fight kung fu style on the floe. The seal knocks the penguin into the water and grins.",
  staging: "Both start in the water either side of the floe.",
  plate:
    "Open Southern Ocean under low overcast: flat slate-grey water, soft white polar daylight, one flat white ice floe about 2.5 metres across with wet glossy edges",
  grade: "Cool grey-blue, slate and white; moderate natural contrast; soft overcast as the only key, wet specular highlights",
  castNotes: [
    {
      name: "Penguin",
      size: "45 cm tall",
      anatomy: "two stubby flippers, pink webbed feet, no hands or arms",
      acting: "fearless, concentrated timing",
      side: "left",
    },
    {
      name: "Seal",
      size: "2.6 metres long",
      anatomy: "barrel chest, short fore flippers, broad rear flippers forming the tail",
      acting: "heavy predatory focus that turns smug",
      side: "right",
    },
  ],
  counts: [
    { what: "penguins", n: 1 },
    { what: "seals", n: 1 },
    { what: "ice floes", n: 1 },
  ],
  whitelist: ["one southern rockhopper penguin", "one adult male grey seal", "one flat white ice floe", "ocean", "sky"],
};

export const ctx = (over: Partial<SequenceContext> = {}): SequenceContext => ({
  shot: kungFuShot(),
  scene: PLAN,
  cast: [PENGUIN, SEAL],
  aspect: "9:16",
  nativeAudio: true,
  references: [],
  ...over,
});
