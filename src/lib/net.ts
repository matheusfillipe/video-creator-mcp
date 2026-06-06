import { lookup } from "node:dns/promises";
import { config } from "../config.js";

export function isPrivateIpv4(ip: string): boolean {
  const parts = ip.split(".").map(Number);
  if (
    parts.length !== 4 ||
    parts.some((octet) => Number.isNaN(octet) || octet < 0 || octet > 255)
  ) {
    return false;
  }
  const [a, b] = parts as [number, number, number, number];
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  return false;
}

export function isPrivateIpv6(ip: string): boolean {
  const addr = ip.toLowerCase();
  if (addr === "::1" || addr === "::") return true;
  if (addr.startsWith("fe80") || addr.startsWith("fc") || addr.startsWith("fd")) return true;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(addr);
  if (mapped?.[1]) return isPrivateIpv4(mapped[1]);
  return false;
}

export function isPrivateAddress(ip: string): boolean {
  return ip.includes(":") ? isPrivateIpv6(ip) : isPrivateIpv4(ip);
}

/**
 * Validates an outbound URL before any download. Blocks non-http(s) schemes and hosts that
 * resolve to private/loopback/link-local ranges (incl. the cloud-metadata address). This is the
 * first SSRF layer; the network egress policy is the backstop against redirect-based pivots.
 */
export async function assertSafeUrl(rawUrl: string): Promise<URL> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error(`Invalid URL: ${rawUrl}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(
      `Unsupported URL scheme '${parsed.protocol}' (only http and https are allowed)`,
    );
  }
  if (config.allowPrivateNetwork) {
    return parsed;
  }
  const resolved = await lookup(parsed.hostname, { all: true });
  for (const { address } of resolved) {
    if (isPrivateAddress(address)) {
      throw new Error(
        `Refusing to fetch ${parsed.hostname}: resolves to private/internal address ${address}`,
      );
    }
  }
  return parsed;
}
