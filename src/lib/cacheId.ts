import { createHash } from "node:crypto";

const ID_LENGTH = 12;

export function cacheId(...parts: (string | number | null | undefined)[]): string {
  const seed = parts
    .map((part) => (part === null || part === undefined ? "" : String(part)))
    .join("|");
  return createHash("sha256").update(seed).digest("hex").slice(0, ID_LENGTH);
}
