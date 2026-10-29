import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";

export const uuid = (): string => randomUUID();
export const newToken = (): string => randomBytes(32).toString("base64url");
export const sha256 = (s: string): string => createHash("sha256").update(s).digest("hex");
export const hmac = (secret: string, msg: string): string => createHmac("sha256", secret).update(msg).digest("base64url");

export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
