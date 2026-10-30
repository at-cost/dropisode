/**
 * The 54-episode comparison from docs/PRICING_NOTES.md section 8, as published
 * research. These figures are not used for billing: every price Dropisode charges
 * comes from packages/core/config/prices.json. Update this file when the notes
 * are redone.
 */

export const COMPARE = {
  checkedOn: "2026-10-29",
  notes: "docs/PRICING_NOTES.md, section 8",
  scenario: {
    episodes: 54,
    episodeSeconds: 90,
    totalSeconds: 4860,
    shots: 972,
    shotSeconds: 5,
    frameUsd: 0.04,
    frameModel: "Seedream 4.5 edit",
    draftModel: "Veo 3.1 Lite 720p with audio",
    draftUsdPerSecond: 0.05,
  },
  higgsfieldSource: "https://higgsfield.ai/pricing",
  falSource: "https://fal.ai/pricing",
  /** Whole dollars, as in the notes. "fal" is the provider price, "reel" is that × 1.2. */
  models: [
    { model: "MiniMax H3 768p", perSecond: 0.06, finalFal: 330, finalReel: 397, dtfFal: 1176, dtfReel: 1411 },
    { model: "Veo 3.1 Lite 1080p, audio", perSecond: 0.08, finalFal: 428, finalReel: 513, dtfFal: 1273, dtfReel: 1528 },
    { model: "Hailuo 2.3 Pro (silent, per 6 s video)", perSecond: 0.0817, finalFal: 436, finalReel: 523, dtfFal: 1281, dtfReel: 1538 },
    { model: "Wan 3.0 720p", perSecond: 0.1, finalFal: 525, finalReel: 630, dtfFal: 1371, dtfReel: 1645 },
    { model: "Kling 3.0 Standard, audio", perSecond: 0.126, finalFal: 651, finalReel: 781, dtfFal: 1497, dtfReel: 1796 },
    { model: "Kling O3 Pro reference, audio", perSecond: 0.14, finalFal: 719, finalReel: 863, dtfFal: 1565, dtfReel: 1878 },
    { model: "Veo 3.1 Fast, audio", perSecond: 0.15, finalFal: 768, finalReel: 921, dtfFal: 1614, dtfReel: 1936 },
    { model: "Wan 2.6 1080p", perSecond: 0.15, finalFal: 768, finalReel: 921, dtfFal: 1614, dtfReel: 1936 },
    { model: "Kling 4.0 720p", perSecond: 0.157, finalFal: 802, finalReel: 962, dtfFal: 1648, dtfReel: 1977 },
    { model: "MiniMax H3 Max 1080p", perSecond: 0.16, finalFal: 816, finalReel: 980, dtfFal: 1662, dtfReel: 1995 },
    { model: "Kling 3.0 Pro, audio", perSecond: 0.168, finalFal: 855, finalReel: 1026, dtfFal: 1701, dtfReel: 2041 },
    { model: "Wan 3.0 1080p", perSecond: 0.2, finalFal: 1011, finalReel: 1213, dtfFal: 1857, dtfReel: 2228 },
    { model: "Kling 4.0 1080p", perSecond: 0.235, finalFal: 1181, finalReel: 1417, dtfFal: 2027, dtfReel: 2432 },
    { model: "Seedance 2.0 Fast 720p", perSecond: 0.2419, finalFal: 1215, finalReel: 1457, dtfFal: 2060, dtfReel: 2472 },
    { model: "Seedance 2.0 720p", perSecond: 0.3024, finalFal: 1509, finalReel: 1810, dtfFal: 2354, dtfReel: 2825 },
    { model: "Veo 3.1, audio", perSecond: 0.4, finalFal: 1983, finalReel: 2379, dtfFal: 2829, dtfReel: 3394 },
    { model: "Seedance 2.5 (US) 720p", perSecond: 0.473, finalFal: 2338, finalReel: 2805, dtfFal: 3183, dtfReel: 3820 },
    { model: "Seedance 2.0 1080p", perSecond: 0.682, finalFal: 3353, finalReel: 4024, dtfFal: 4199, dtfReel: 5039 },
  ],
  higgsfieldPlans: [
    { plan: "Starter", monthly: "$19", annual: "$19", credits: "270", perCredit: "$0.070" },
    { plan: "Plus", monthly: "$59", annual: "$47", credits: "1,200", perCredit: "$0.049 / $0.039" },
    { plan: "Ultra", monthly: "$129", annual: "$99", credits: "3,000 (6,000 and 9,000 options shown)", perCredit: "$0.043 / $0.033" },
    { plan: "Teams", monthly: "from $65 per seat", annual: "", credits: "from 1,000 per seat", perCredit: "" },
  ],
  /** Same 4,860 s, one Nano Banana Pro frame per try, at Ultra's per-credit rate, assuming every credit bought is used. */
  vsHiggsfield: [
    {
      model: "Kling 3.0 720p / Pro",
      hfFinal: "$376 / $289",
      reelFinal: "$1,026 (Pro, audio)",
      hf4: "$1,505",
      reelDtf: "$2,041 (Veo Lite drafts), $2,636 (Kling Std drafts)",
    },
    { model: "Seedance 2.0 720p", hfFinal: "$1,003 / $770", reelFinal: "$1,810", hf4: "$4,012", reelDtf: "$2,825" },
    { model: "Seedance 2.0 Fast 720p", hfFinal: "$585 / $449", reelFinal: "$1,457", hf4: "$2,341", reelDtf: "$2,472" },
    { model: "Veo 3.1 Fast", hfFinal: "$920 / $706", reelFinal: "$921", hf4: "$3,678", reelDtf: "$1,936" },
    { model: "Veo 3.1", hfFinal: "$2,173 / $1,668", reelFinal: "$2,379", hf4: "$8,694", reelDtf: "$3,394" },
    { model: "Wan 3.0 1080p", hfFinal: "$815 / $625", reelFinal: "$1,213", hf4: "$3,260", reelDtf: "$2,228" },
    { model: "Hailuo 2.3 1080p", hfFinal: "$432 / $331", reelFinal: "$523 (Pro)", hf4: "$1,728", reelDtf: "$1,538" },
  ],
} as const;
