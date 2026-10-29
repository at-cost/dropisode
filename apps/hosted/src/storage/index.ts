/**
 * Object storage for media. Production: Cloudflare R2 (private bucket, no
 * egress fees), reached over its S3 API with short-lived presigned URLs.
 * Development and tests: a local folder with HMAC-signed URLs served by the app.
 * Keys always start with the workspace id; signing is only ever done after the
 * caller has checked the workspace owns the media row.
 */
import { createReadStream, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, resolve, sep } from "node:path";
import { Readable } from "node:stream";
import { AwsClient } from "aws4fetch";
import type { Config } from "../config";
import { hmac, safeEqual } from "../lib/ids";

export interface BlobStore {
  put(key: string, bytes: Uint8Array, contentType: string): Promise<void>;
  get(key: string): Promise<Uint8Array>;
  delete(key: string): Promise<void>;
  /** A URL that serves the object for `ttlS` seconds. */
  signedUrl(key: string, ttlS: number, opts?: { download?: string }): Promise<string>;
}

const KEY = /^ws\/[0-9a-f-]{36}\/[A-Za-z0-9_\-./]+$/;
export function assertKey(key: string): void {
  if (!KEY.test(key) || key.includes("..")) throw new Error(`Bad storage key ${key}`);
}

export function createBlobStore(config: Config): BlobStore {
  return config.STORAGE_DRIVER === "r2" ? r2Store(config) : localStore(config);
}

function r2Store(config: Config): BlobStore {
  const aws = new AwsClient({
    accessKeyId: config.R2_ACCESS_KEY_ID,
    secretAccessKey: config.R2_SECRET_ACCESS_KEY,
    service: "s3",
    region: "auto",
  });
  const base = `https://${config.R2_ACCOUNT_ID}.r2.cloudflarestorage.com/${config.R2_BUCKET}`;
  const url = (key: string) => `${base}/${key.split("/").map(encodeURIComponent).join("/")}`;
  return {
    async put(key, bytes, contentType) {
      assertKey(key);
      const res = await aws.fetch(url(key), { method: "PUT", body: bytes as BodyInit, headers: { "content-type": contentType } });
      if (!res.ok) throw new Error(`R2 put failed: HTTP ${res.status}`);
    },
    async get(key) {
      assertKey(key);
      const res = await aws.fetch(url(key));
      if (!res.ok) throw new Error(`R2 get failed: HTTP ${res.status}`);
      return new Uint8Array(await res.arrayBuffer());
    },
    async delete(key) {
      assertKey(key);
      const res = await aws.fetch(url(key), { method: "DELETE" });
      if (!res.ok && res.status !== 404) throw new Error(`R2 delete failed: HTTP ${res.status}`);
    },
    async signedUrl(key, ttlS, opts = {}) {
      assertKey(key);
      const u = new URL(url(key));
      u.searchParams.set("X-Amz-Expires", String(ttlS));
      if (opts.download) u.searchParams.set("response-content-disposition", `attachment; filename="${opts.download.replace(/"/g, "")}"`);
      const signed = await aws.sign(new Request(u, { method: "GET" }), { aws: { signQuery: true } });
      return signed.url;
    },
  };
}

function localStore(config: Config): BlobStore {
  const root = resolve(config.STORAGE_LOCAL_DIR);
  mkdirSync(root, { recursive: true });
  const path = (key: string) => {
    assertKey(key);
    const p = resolve(root, key);
    if (!p.startsWith(root + sep)) throw new Error("Bad storage key");
    return p;
  };
  return {
    async put(key, bytes) {
      const p = path(key);
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, bytes);
    },
    async get(key) {
      return readFileSync(path(key));
    },
    async delete(key) {
      rmSync(path(key), { force: true });
    },
    async signedUrl(key, ttlS, opts = {}) {
      path(key);
      const exp = Math.floor(Date.now() / 1000) + ttlS;
      const q = new URLSearchParams({ key, exp: String(exp), sig: hmac(config.APP_SECRET, `${key}|${exp}`) });
      if (opts.download) q.set("download", opts.download);
      return `${config.APP_URL.replace(/\/$/, "")}/files?${q}`;
    },
  };
}

/** Serves a local-driver signed URL (development and tests only). */
export function serveLocalFile(config: Config, q: URLSearchParams, contentType: string): Response {
  const key = q.get("key") ?? "";
  const exp = Number(q.get("exp"));
  const sig = q.get("sig") ?? "";
  if (!key || !Number.isFinite(exp) || exp < Date.now() / 1000 || !safeEqual(sig, hmac(config.APP_SECRET, `${key}|${exp}`))) {
    return new Response("Link expired or invalid", { status: 403 });
  }
  assertKey(key);
  const p = resolve(config.STORAGE_LOCAL_DIR, key);
  if (!existsSync(p)) return new Response("Not found", { status: 404 });
  const headers: Record<string, string> = {
    "content-type": contentType,
    "content-length": String(statSync(p).size),
    "cache-control": "private, max-age=60",
  };
  const download = q.get("download");
  if (download) headers["content-disposition"] = `attachment; filename="${download.replace(/"/g, "")}"`;
  return new Response(Readable.toWeb(createReadStream(p)) as ReadableStream, { headers });
}

export const mediaKey = (workspaceId: string, projectId: string, file: string) => `ws/${workspaceId}/p/${projectId}/${file}`;
export const exportKey = (workspaceId: string, projectId: string, exportId: string, file: string) =>
  `ws/${workspaceId}/p/${projectId}/exports/${exportId}/${file}`;
