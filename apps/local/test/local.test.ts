import { existsSync, mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
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
