import { describe, expect, it } from "vitest";
import { isPrivateAddress, isPrivateIpv4, isPrivateIpv6 } from "../../src/lib/net.js";

describe("isPrivateIpv4", () => {
  it("flags private and reserved ranges", () => {
    for (const ip of [
      "10.0.0.1",
      "192.168.1.1",
      "172.16.0.1",
      "172.31.255.255",
      "127.0.0.1",
      "169.254.169.254",
      "100.64.0.1",
      "0.0.0.0",
    ]) {
      expect(isPrivateIpv4(ip)).toBe(true);
    }
  });

  it("passes public addresses", () => {
    for (const ip of ["8.8.8.8", "1.1.1.1", "172.32.0.1", "172.15.0.1", "203.0.113.5"]) {
      expect(isPrivateIpv4(ip)).toBe(false);
    }
  });
});

describe("isPrivateIpv6", () => {
  it("flags loopback, link-local and ULA", () => {
    for (const ip of ["::1", "fe80::1", "fc00::1", "fd12:3456::1", "::ffff:10.0.0.1"]) {
      expect(isPrivateIpv6(ip)).toBe(true);
    }
  });

  it("passes public v6", () => {
    expect(isPrivateIpv6("2606:4700:4700::1111")).toBe(false);
  });
});

describe("isPrivateAddress", () => {
  it("dispatches by family", () => {
    expect(isPrivateAddress("169.254.169.254")).toBe(true);
    expect(isPrivateAddress("8.8.8.8")).toBe(false);
    expect(isPrivateAddress("::1")).toBe(true);
  });
});
