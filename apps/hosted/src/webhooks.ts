/**
 * fal → Dropisode. The URL carries the job id and an HMAC of it, so only URLs we
 * issued are accepted. The payload is used only for its request id: the job's
 * real state is then read back from fal with our own key (a forged or replayed
 * webhook can at most make us ask fal again).
 */
import { Hono } from "hono";
import type { AppEnv } from "./context";
import { hmac, safeEqual } from "./lib/ids";
import { jobWorkspace } from "./stores";
import { workspaceStudio } from "./studio";

export const falWebhook = new Hono<AppEnv>();

falWebhook.post("/", async (c) => {
  const deps = c.get("deps");
  const jobId = c.req.query("job") ?? "";
  const sig = c.req.query("sig") ?? "";
  if (!jobId || !safeEqual(sig, hmac(deps.config.APP_SECRET, `fal:${jobId}`))) return c.text("Bad signature", 403);
  const workspaceId = await jobWorkspace(deps.db, jobId);
  if (!workspaceId) return c.text("Unknown job", 404);
  const body = (await c.req.json().catch(() => ({}))) as { request_id?: unknown };
  const requestId = typeof body.request_id === "string" ? body.request_id : undefined;
  const { studio } = workspaceStudio(deps, workspaceId);
  // Answer fast; fal retries slow webhooks. Do the work after replying.
  queueMicrotask(async () => {
    try {
      if (requestId) await studio.runner.attachRequestId(jobId, requestId);
      await studio.runner.check(jobId);
    } catch (err) {
      console.warn(`reel: webhook for ${jobId}: ${(err as Error).message}`);
    }
  });
  return c.json({ ok: true });
});
