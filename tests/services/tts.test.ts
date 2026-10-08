import { afterEach, describe, expect, it, vi } from "vitest";
import { config } from "../../src/config.js";
import { synthesizeSpeechService } from "../../src/services/tts.js";

describe("synthesizeSpeechService", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("tries again when the speech backend dies mid-request", async () => {
    vi.useFakeTimers();
    config.speech.url = "http://speech.test";
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("backend EOF", { status: 500 }))
      .mockResolvedValueOnce(new Response(new Uint8Array([1, 2, 3])));
    vi.stubGlobal("fetch", fetchMock);

    const result = synthesizeSpeechService("hello", "narrator");
    await vi.runAllTimersAsync();

    expect([...(await result)]).toEqual([1, 2, 3]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("fails at once on a request the service rejects", async () => {
    config.speech.url = "http://speech.test";
    const fetchMock = vi.fn().mockResolvedValue(new Response("bad voice", { status: 400 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(synthesizeSpeechService("hello", "nobody")).rejects.toThrow("400");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
