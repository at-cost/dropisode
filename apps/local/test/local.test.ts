import { existsSync, mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FPS, keptFrames, planCut } from "@reel/core";
import { createLocalApp } from "../src/server";

function app() {
  const root = mkdtempSync(join(tmpdir(), "reel-local-"));
  const local = createLocalApp({
    projectsDir: join(root, "projects"),
    configPath: join(root, "config.json"),
    provider: "mock",
    port: 0,
    pollMs: 60_000,
  });
  const call = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const init: RequestInit = { method, headers: { host: "localhost:4320", ...headers } };
    if (body instanceof Uint8Array) init.body = body as BodyInit;
    else if (body !== undefined) {
      init.body = JSON.stringify(body);
      (init.headers as Record<string, string>)["content-type"] = "application/json";
    }
    return local.app.fetch(new Request(`http://localhost:4320${path}`, init));
  };
  const json = async (method: string, path: string, body?: unknown) => {
    const res = await call(method, path, body);
    const data = res.headers.get("content-type")?.includes("json") ? await res.json() : null;
    if (res.status >= 400) throw new Error(`${method} ${path}: ${res.status} ${JSON.stringify(data)}`);
    return data as any;
  };
  const settle = async (pid: string) => {
    for (let i = 0; i < 40; i++) {
      await local.getStudio().tick(pid);
      const v = await json("GET", `/api/projects/${pid}`);
      if (v.openJobs.length === 0 && v.costLog.every((l: any) => l.status !== "pending")) return v;
      await new Promise((r) => setTimeout(r, 200));
    }
    throw new Error("jobs did not finish");
  };
  return { root, local, call, json, settle };
}

describe("local app", () => {
  it("only answers on localhost and refuses cross-site writes", async () => {
    const { call } = app();
    expect((await call("GET", "/api/projects", undefined, { host: "evil.example" })).status).toBe(403);
    expect((await call("POST", "/api/projects", { name: "x" }, { origin: "https://evil.example" })).status).toBe(403);
    expect((await call("POST", "/api/projects", { name: "x" }, { origin: "http://localhost:4320" })).status).toBe(201);
  });

  it("never sends the key to the browser and stores it only readable by the user", async () => {
    const { json, root } = app();
    await json("PUT", "/api/local/settings", { falKey: "fal-secret-1234" });
    const s = await json("GET", "/api/local/settings");
    expect(s).toMatchObject({ hasKey: true, keyHint: "…1234" });
    expect(JSON.stringify(s)).not.toContain("fal-secret");
    expect(statSync(join(root, "config.json")).mode & 0o777).toBe(0o600);
  });

  it("idea to finished episode over the API, with prices and a cost log", async () => {
    const { json, call, settle } = app();
    const p = await json("POST", "/api/projects", { name: "The Letter", idea: "A courier finds a letter addressed to herself." });
    const est0 = await json("GET", `/api/projects/${p.id}/estimates`);
    expect(est0.script).toBeGreaterThan(0);
    let v = await json("POST", `/api/projects/${p.id}/script`, { idea: p.idea, targetSeconds: 30 });
    const scene = v.project.episodes[0].scenes[0];
    v = await json("POST", `/api/projects/${p.id}/scenes/${scene.id}/storyboard`, {});
    const shots = v.project.episodes[0].scenes[0].shots;
    expect(shots).toHaveLength(6);
    for (const c of v.project.cast) await json("POST", `/api/projects/${p.id}/cast/${c.id}/generate`);
    await settle(p.id);
    const est = await json("GET", `/api/projects/${p.id}/estimates`);
    expect(est.shots[shots[0].id].draft).toBeGreaterThan(0);
    for (const s of shots) await json("POST", `/api/projects/${p.id}/shots/${s.id}/takes`, { tier: "draft" });
    await settle(p.id);
    // Final needs approval.
    const blocked = await call("POST", `/api/projects/${p.id}/shots/${shots[0].id}/takes`, { tier: "final" });
    expect(blocked.status).toBe(400);
    for (const s of shots) await json("PATCH", `/api/projects/${p.id}/shots/${s.id}`, { approved: true });
    for (const s of shots) await json("POST", `/api/projects/${p.id}/shots/${s.id}/takes`, { tier: "final" });
    v = await settle(p.id);
    expect(v.costLog.every((l: any) => l.status === "charged")).toBe(true);
    expect(v.totals.paidMicro).toBe(v.totals.providerCostMicro); // local: you pay fal's price, nothing on top
    const ex = await json("POST", `/api/projects/${p.id}/episodes/${v.project.episodes[0].id}/assemble`, { source: "final" });
    expect(ex.skipped).toEqual([]);
    const names = ex.files.map((f: any) => f.name);
    expect(names).toEqual(expect.arrayContaining(["episode.mp4", "subtitles.srt", "edit-list.edl", "edit-list.json"]));
    expect(names.filter((n: string) => n.startsWith("shots/"))).toHaveLength(6);
    const mp4 = await call("GET", ex.files.find((f: any) => f.name === "episode.mp4").url, undefined, { range: "bytes=0-99" });
    expect(mp4.status).toBe(206);
    expect((await json("GET", `/api/projects/${p.id}/exports`))[0].id).toBe(ex.id);
    // Media is served; traversal isn't.
    const media = v.project.media[0];
    expect((await call("GET", `/api/projects/${p.id}/media/${media.id}`)).status).toBe(200);
    expect((await call("GET", `/api/local/projects/${p.id}/exports/${ex.id}/..%2F..%2Fproject.json`)).status).toBe(404);
  });

  it("exports a project zip that imports back as a copy", async () => {
    const { json, call } = app();
    const p = await json("POST", "/api/projects", { name: "Copy me" });
    await json("POST", `/api/projects/${p.id}/cast`, { kind: "character", name: "Maya", description: "yellow jacket" });
    const zip = new Uint8Array(await (await call("GET", `/api/projects/${p.id}/export`)).arrayBuffer());
    const other = app();
    const res = await other.call("POST", "/api/projects/import", zip);
    expect(res.status).toBe(201);
    const copy = (await res.json()) as any;
    expect(copy.name).toBe("Copy me");
    expect(copy.cast[0].name).toBe("Maya");
  });

  it("cuts over the API: start and end points, joins, moves, fades, and the length the panel would show", async () => {
    const { json, call, settle } = app();
    const p = await json("POST", "/api/projects", { name: "Cut", aspect: "9:16" });
    let v = await json("POST", `/api/projects/${p.id}/episodes`, { title: "Ep" });
    const eid = v.episodeId;
    v = await json("POST", `/api/projects/${p.id}/episodes/${eid}/scenes`, { heading: "INT. ROOM" });
    const scid = v.project.episodes[0].scenes[0].id;
    for (const d of [4, 4]) v = await json("POST", `/api/projects/${p.id}/scenes/${scid}/shots`, { durationS: d });
    const [a, b] = v.project.episodes[0].scenes[0].shots;
    for (const s of [a, b]) await json("POST", `/api/projects/${p.id}/shots/${s.id}/takes`, { tier: "draft" });
    v = await settle(p.id);
    const take = (vv: any, i: number) => vv.project.episodes[0].scenes[0].shots[i].takes[0];
    const ta = take(v, 0);
    const path = `/api/projects/${p.id}/shots/${a.id}/takes/${ta.id}`;

    // Whole frames before a time, at whatever rate the edit runs.
    const whole = (x: number) => Math.floor(x * FPS + 1e-6);
    v = await json("PATCH", path, { inS: 0.5, outS: 3.5 });
    expect(take(v, 0)).toMatchObject({ inS: 0.5, outS: 3.5 });
    // Moving one end leaves the other.
    v = await json("PATCH", path, { outS: 3.2 });
    expect(take(v, 0)).toMatchObject({ inS: 0.5, outS: 3.2 });
    // A start too near the end keeps half a second.
    v = await json("PATCH", path, { inS: 3.1 });
    expect(take(v, 0).inS).toBeCloseTo((whole(3.2) - FPS / 2) / FPS, 5);
    // Ending before the start pulls the start back with it.
    v = await json("PATCH", path, { outS: 1 });
    expect(take(v, 0).inS).toBeCloseTo(0.5, 5);
    // Exactly half a second is kept, not lost to float rounding (1.4 - 0.9 is 0.4999... in floats).
    v = await json("PATCH", path, { inS: 0.9, outS: 1.4 });
    expect(keptFrames(take(v, 0), a)).toEqual({ inF: whole(1.4) - FPS / 2, outF: whole(1.4) });
    // A start point clamped by a new end still keeps half a second.
    await json("PATCH", path, { inS: 2, outS: 3 });
    v = await json("PATCH", path, { outS: 2.33 });
    expect(keptFrames(take(v, 0), a)).toEqual({ inF: whole(2.33) - FPS / 2, outF: whole(2.33) });
    v = await json("PATCH", path, { inS: null, outS: null });
    expect(take(v, 0).inS).toBeUndefined();
    expect(take(v, 0).outS).toBe(ta.analysis.durationS);
    expect((await call("PATCH", path, { inS: -1 })).status).toBe(400);

    await json("PATCH", `/api/projects/${p.id}/shots/${b.id}`, { approved: true });
    v = await json("PATCH", `/api/projects/${p.id}/shots/${b.id}`, { joinIn: "dissolve", joinS: 0.8, move: "pull-out" });
    expect(v.project.episodes[0].scenes[0].shots[1]).toMatchObject({ joinIn: "dissolve", joinS: 0.8, move: "pull-out", approved: true });
    expect((await call("PATCH", `/api/projects/${p.id}/shots/${b.id}`, { joinS: 5 })).status).toBe(400);
    v = await json("PATCH", `/api/projects/${p.id}/episodes/${eid}`, { fadeInS: 0.5, fadeOutS: 1.5, soundLead: "music" });
    expect(v.project.episodes[0]).toMatchObject({ fadeInS: 0.5, fadeOutS: 1.5, soundLead: "music" });
    expect((await call("PATCH", `/api/projects/${p.id}/episodes/${eid}`, { soundLead: "loud" })).status).toBe(400);

    await json("PATCH", path, { inS: 0.4, outS: 3.7 });
    v = await json("GET", `/api/projects/${p.id}`);
    const plan = planCut(v.project.episodes[0], "rough");
    const ex = await json("POST", `/api/projects/${p.id}/episodes/${eid}/assemble`, { source: "rough" });
    expect(ex.durationS).toBe(plan.totalF / FPS);
    // The first take from 0.4 to 3.7 s, the whole 4 s second take, less the 0.8 s dissolve between them.
    expect(plan.totalF).toBe(whole(3.7) - Math.round(0.4 * FPS) + 4 * FPS - whole(0.8));
  });

  it("asks for a key instead of spending when none is set", async () => {
    const root = mkdtempSync(join(tmpdir(), "reel-local-"));
    const local = createLocalApp({
      projectsDir: join(root, "p"),
      configPath: join(root, "c.json"),
      provider: "fal",
      port: 0,
      pollMs: 60_000,
    });
    const req = (m: string, path: string, body?: unknown) =>
      local.app.fetch(
        new Request(`http://localhost${path}`, {
          method: m,
          headers: { host: "localhost", "content-type": "application/json" },
          ...(body ? { body: JSON.stringify(body) } : {}),
        }),
      );
    const p = (await (await req("POST", "/api/projects", { name: "x" })).json()) as any;
    await req("POST", `/api/projects/${p.id}/cast`, { kind: "character", name: "A" });
    const proj = (await (await req("GET", `/api/projects/${p.id}`)).json()) as any;
    const res = await req("POST", `/api/projects/${p.id}/cast/${proj.project.cast[0].id}/generate`);
    expect(res.status).toBe(402);
    expect(((await res.json()) as any).error).toMatch(/fal.ai key/);
    expect(existsSync(join(root, "c.json"))).toBe(false);
    void readFileSync;
  });
});
