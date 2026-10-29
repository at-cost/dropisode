import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Catalog } from "../src/catalog";
import { FolderStore } from "../src/folderStore";
import { MockProvider } from "../src/providers/mock";
import type { Provider } from "../src/providers/types";
import { Studio } from "../src/studio";

export const testCatalog = () => Catalog.load(new URL("./catalog.fixture.json", import.meta.url));

export function setup(opts: { provider?: Provider; mock?: MockProvider } = {}) {
  const root = mkdtempSync(join(tmpdir(), "reel-test-"));
  const store = new FolderStore(root);
  const catalog = testCatalog();
  const mock = opts.mock ?? new MockProvider();
  const provider = opts.provider ?? mock;
  const studio = new Studio({ projects: store, media: store, jobs: store.jobs, provider, catalog });
  return { root, store, catalog, mock, provider, studio };
}

/** Runs the poll loop until nothing is left to do. */
export async function drain(studio: Studio, projectId: string, rounds = 20): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    const open = await studio.runner.deps.jobs.listUnfinished(projectId);
    if (open.length === 0) return;
    await studio.tick(projectId);
  }
  throw new Error("jobs did not finish");
}
