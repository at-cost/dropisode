import { describe, expect, it } from "vitest";
import { Catalog, estimate } from "../src/catalog";
import { addEpisode, addScene, addShot, createProject } from "../src/edit";
import { drain, setup } from "./helpers";

describe("project model choices", () => {
  it("prices and runs the project's chosen models; unset slots use the recommended default", async () => {
    const t = setup();
    const project = createProject({ name: "Models" });
    const sc = addScene(addEpisode(project, { title: "Ep" }), { heading: "EXT. CHURCHYARD - DAY" });
    const shot = addShot(sc, { description: "Nora on the bench.", durationS: 10 });
    project.models = { draftVideo: "vid-final" };
    t.store.create(project);
    const p = await t.store.get(project.id);
    const est = t.studio.estimateTake(p, shot.id, "draft");
    expect(est.videoModel).toBe("vid-final");
    expect(est.imageModel).toBe("img-cheap");
    expect(est.video.providerCostMicro).toBe(est.durationS * 100_000);
    expect(t.studio.estimateTake(p, shot.id, "final").videoModel).toBe(t.studio.catalog.defaultsFor("final").video);
    await t.studio.generateTake(project.id, shot.id, "draft");
    await drain(t.studio, project.id);
    const models = t.mock.submitted.map((x) => x.input.model.id);
    expect(models).toContain("vid-final");
    expect(models).not.toContain("vid-draft");
  });

  it("ignores a saved choice that is no longer in the catalog", async () => {
    const t = setup();
    const project = createProject({ name: "Gone" });
    project.models = { draftVideo: "retired-model" };
    expect(t.studio.modelsFor(project, "draft").video).toBe(t.studio.catalog.defaultsFor("draft").video);
  });

  it("the real catalog offers Seedance 2.5 at 480p and 720p with sound, and Nano Banana Pro", () => {
    const cat = Catalog.load();
    const s720 = cat.get("seedance-2.5-720p");
    expect(s720.tiers).toEqual(["draft", "final"]);
    expect(s720.input.extra).toMatchObject({ resolution: "720p" });
    expect(estimate(s720, { durationS: 10, audio: true }).providerCostMicro).toBe(4_730_000);
    expect(billedDurationOf(cat, "seedance-2.5-720p", 30)).toBe(30);
    expect(cat.get("seedance-2.5-480p").tiers).toEqual(["draft"]);
    expect(cat.get("nano-banana-pro").kind).toBe("image");
  });
});

function billedDurationOf(cat: Catalog, id: string, s: number) {
  return estimate(cat.get(id), { durationS: s }).units;
}
