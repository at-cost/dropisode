/** The local config file: your fal.ai key, readable only by you (mode 600). Never sent to the browser. */
import { chmodSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { writeAtomic } from "@reel/core";

export interface LocalConfig {
  falKey?: string | undefined;
  /** Optional: a fal key with the BILLING preset, so Reel can record each request's real cost. */
  falBillingKey?: string | undefined;
}

export const defaultConfigPath = (): string =>
  process.env.REEL_CONFIG ?? join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "reel", "config.json");

export function loadConfig(path: string): LocalConfig {
  const fromEnv: LocalConfig = {
    ...(process.env.FAL_KEY ? { falKey: process.env.FAL_KEY } : {}),
    ...(process.env.FAL_BILLING_KEY ? { falBillingKey: process.env.FAL_BILLING_KEY } : {}),
  };
  if (!existsSync(path)) return fromEnv;
  try {
    const file = JSON.parse(readFileSync(path, "utf8")) as LocalConfig;
    return { ...file, ...fromEnv };
  } catch {
    console.warn(`reel: couldn't read ${path}; starting without a key`);
    return fromEnv;
  }
}

export function saveConfig(path: string, config: LocalConfig): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const clean = Object.fromEntries(Object.entries(config).filter(([, v]) => v));
  writeAtomic(path, `${JSON.stringify(clean, null, 2)}\n`);
  chmodSync(path, 0o600);
}
