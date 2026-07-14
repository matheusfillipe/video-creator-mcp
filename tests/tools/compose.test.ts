import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { config } from "../../src/config.js";
import { saveMeta } from "../../src/services/media.js";
import { COMPOSITION, locateSceneAt, resolveComposition } from "../../src/tools/compose.js";

const graphic = (n: number | string) => ({
  type: "graphic" as const,
  kind: "math" as const,
  latex: `x${n}`,
});

function errorsOf(findings: { severity: "error" | "warning" }[]) {
  return findings.filter((f) => f.severity === "error");
}

describe("resolveComposition", () => {
  it("validates a minimal narrated scene (graphic + voice + caption)", async () => {
    const comp = COMPOSITION.parse({
      tracks: [
        {
          clips: [
            {
              type: "composition",
              id: "scene1",
              tracks: [
                { clips: [graphic(1)] },
                { clips: [{ type: "voice", text: "The Pythagorean theorem." }] },
                { clips: [{ type: "caption" }] },
              ],
            },
          ],
        },
      ],
    });
    const resolved = await resolveComposition(comp);
    expect(errorsOf(resolved.findings)).toEqual([]);
    expect(resolved.scenes).toHaveLength(1);
  });

  it("flags a composition with no scene track", async () => {
    const comp = COMPOSITION.parse({
      tracks: [{ clips: [{ type: "audio", media_id: "bed1" }] }],
    });
    const resolved = await resolveComposition(comp);
    expect(resolved.findings).toContainEqual(
      expect.objectContaining({
        path: "tracks",
        severity: "error",
        message: "no scene track: add a track whose clips are compositions (the scenes, in order)",
      }),
    );
  });

  it("flags a caption clip with no voice clip in the same scene", async () => {
    const comp = COMPOSITION.parse({
      tracks: [
        {
          clips: [
            {
              type: "composition",
              duration: 5,
              tracks: [{ clips: [graphic(1)] }, { clips: [{ type: "caption" }] }],
            },
          ],
        },
      ],
    });
    const resolved = await resolveComposition(comp);
    expect(resolved.findings).toContainEqual(
      expect.objectContaining({
        severity: "error",
        message: "a caption clip needs a voice clip in the same scene to align to",
      }),
    );
  });

  it('flags duration "fit" with no voice clip', async () => {
    const comp = COMPOSITION.parse({
      tracks: [
        {
          clips: [{ type: "composition", tracks: [{ clips: [graphic(1)] }] }],
        },
      ],
    });
    const resolved = await resolveComposition(comp);
    expect(resolved.findings).toContainEqual(
      expect.objectContaining({
        severity: "error",
        message: 'duration "fit" needs a voice clip to fit to',
      }),
    );
  });

  it('flags a layout "hstack" scene with only one visual clip', async () => {
    const comp = COMPOSITION.parse({
      tracks: [
        {
          clips: [
            {
              type: "composition",
              duration: 5,
              layout: "hstack",
              tracks: [{ clips: [graphic(1)] }],
            },
          ],
        },
      ],
    });
    const resolved = await resolveComposition(comp);
    expect(resolved.findings).toContainEqual(
      expect.objectContaining({
        severity: "error",
        message: 'layout "hstack" needs exactly 2 visual clips (video or graphic), got 1',
      }),
    );
  });

  it('flags a layout "grid" scene with 5 visual clips (grid takes 2-4)', async () => {
    const comp = COMPOSITION.parse({
      tracks: [
        {
          clips: [
            {
              type: "composition",
              duration: 5,
              layout: "grid",
              tracks: [{ clips: [graphic(1), graphic(2), graphic(3), graphic(4), graphic(5)] }],
            },
          ],
        },
      ],
    });
    const resolved = await resolveComposition(comp);
    expect(resolved.findings).toContainEqual(
      expect.objectContaining({
        severity: "error",
        message: 'layout "grid" needs 2-4 visual clips (video or graphic), got 5',
      }),
    );
  });

  // ensureMedia() only ever consults the cached meta.json (loadMeta), never the media bytes,
  // so a synthetic MediaMeta written straight to the cache via saveMeta is enough to resolve
  // "found". Both the out<=in and in>=duration checks live in the same `else` branch of
  // resolveScene (reachable only once media_id resolves) -- so, unlike the assumption that only
  // the duration check needs real media, this one fixture is enough to exercise both.
  describe("video clip in/out (against a synthetic cached media fixture)", () => {
    const FIXTURE_ID = "vitest-compose-fixture";
    const metaFile = join(config.mediaCacheDir, `${FIXTURE_ID}.meta.json`);

    beforeAll(async () => {
      await mkdir(config.mediaCacheDir, { recursive: true });
      await saveMeta(FIXTURE_ID, {
        media_id: FIXTURE_ID,
        filename: `${FIXTURE_ID}.mp4`,
        path: "/dev/null",
        url: "",
        start: null,
        end: null,
        duration: 10,
        width: 1920,
        height: 1080,
        codec: "h264",
        fps: 30,
        hasAudio: true,
        size: 1000,
      });
    });

    afterAll(async () => {
      await rm(metaFile, { force: true });
    });

    it("flags out <= in", async () => {
      const comp = COMPOSITION.parse({
        tracks: [
          {
            clips: [
              {
                type: "composition",
                duration: 5,
                tracks: [{ clips: [{ type: "video", media_id: FIXTURE_ID, in: 5, out: 3 }] }],
              },
            ],
          },
        ],
      });
      const resolved = await resolveComposition(comp);
      expect(resolved.findings).toContainEqual(
        expect.objectContaining({
          severity: "error",
          message: "out (3s) must be greater than in (5s)",
        }),
      );
    });

    it("flags in beyond the source's length", async () => {
      const comp = COMPOSITION.parse({
        tracks: [
          {
            clips: [
              {
                type: "composition",
                duration: 5,
                tracks: [{ clips: [{ type: "video", media_id: FIXTURE_ID, in: 10 }] }],
              },
            ],
          },
        ],
      });
      const resolved = await resolveComposition(comp);
      expect(resolved.findings).toContainEqual(
        expect.objectContaining({
          severity: "error",
          message: "in (10s) is beyond the source's length",
        }),
      );
    });
  });

  it("flags a second track of scene compositions", async () => {
    const minimalScene = (id: string) => ({
      type: "composition" as const,
      id,
      duration: 5,
      tracks: [{ clips: [graphic(id)] }],
    });
    const comp = COMPOSITION.parse({
      tracks: [{ clips: [minimalScene("a")] }, { clips: [minimalScene("b")] }],
    });
    const resolved = await resolveComposition(comp);
    expect(resolved.findings).toContainEqual(
      expect.objectContaining({
        path: "tracks[1]",
        severity: "error",
        message: "only one track of scene compositions is supported in this version",
      }),
    );
  });

  it("flags a second music/audio bed", async () => {
    const comp = COMPOSITION.parse({
      tracks: [
        {
          clips: [{ type: "composition", duration: 5, tracks: [{ clips: [graphic(1)] }] }],
        },
        {
          clips: [
            { type: "audio", media_id: "bed1" },
            { type: "audio", media_id: "bed2" },
          ],
        },
      ],
    });
    const resolved = await resolveComposition(comp);
    expect(resolved.findings).toContainEqual(
      expect.objectContaining({
        severity: "error",
        message: "only one music bed is supported",
      }),
    );
  });

  it("validates a two-scene composition and carries transition_out onto the resolved scene", async () => {
    const comp = COMPOSITION.parse({
      tracks: [
        {
          clips: [
            {
              type: "composition",
              id: "scene1",
              duration: 4,
              tracks: [{ clips: [graphic(1)] }],
              transition_out: { kind: "fade", sec: 0.5 },
            },
            {
              type: "composition",
              id: "scene2",
              duration: 4,
              tracks: [{ clips: [graphic(2)] }],
            },
          ],
        },
      ],
    });
    const resolved = await resolveComposition(comp);
    expect(errorsOf(resolved.findings)).toEqual([]);
    expect(resolved.scenes).toHaveLength(2);
    expect(resolved.scenes[0]?.transitionOutSec).toBe(0.5);
    expect(resolved.scenes[1]?.transitionOutSec).toBeUndefined();
  });
});

describe("locateSceneAt", () => {
  // Three silent (voice-less, numeric-duration) scenes give a fully deterministic timeline
  // (4s / 6s / 3s, back to back from 0) without depending on TTS_WORDS_PER_SEC / word counts.
  async function buildTimeline() {
    const comp = COMPOSITION.parse({
      tracks: [
        {
          clips: [
            { type: "composition", id: "s0", duration: 4, tracks: [{ clips: [graphic(0)] }] },
            { type: "composition", id: "s1", duration: 6, tracks: [{ clips: [graphic(1)] }] },
            { type: "composition", id: "s2", duration: 3, tracks: [{ clips: [graphic(2)] }] },
          ],
        },
      ],
    });
    const resolved = await resolveComposition(comp);
    expect(errorsOf(resolved.findings)).toEqual([]);
    return resolved;
  }

  it("lands t=0 on scene 0 at offset 0", async () => {
    const resolved = await buildTimeline();
    const loc = locateSceneAt(resolved, 0);
    expect(loc.scene.id).toBe("s0");
    expect(loc.sceneStart).toBe(0);
    expect(loc.sceneEnd).toBe(4);
    expect(loc.withinSceneSec).toBe(0);
  });

  it("locates a timestamp inside scene 1's span with a within-scene offset in range", async () => {
    const resolved = await buildTimeline();
    const loc = locateSceneAt(resolved, 7);
    expect(loc.scene.id).toBe("s1");
    expect(loc.sceneStart).toBe(4);
    expect(loc.sceneEnd).toBe(10);
    expect(loc.withinSceneSec).toBeGreaterThanOrEqual(0);
    expect(loc.withinSceneSec).toBeLessThanOrEqual(loc.sceneEnd - loc.sceneStart);
    expect(loc.withinSceneSec).toBe(3);
  });

  it("clamps a timestamp beyond the total duration to the last scene", async () => {
    const resolved = await buildTimeline();
    const loc = locateSceneAt(resolved, 1000);
    expect(loc.scene.id).toBe("s2");
    expect(loc.sceneStart).toBe(10);
    expect(loc.sceneEnd).toBe(13);
    expect(loc.withinSceneSec).toBeGreaterThan(0);
    expect(loc.withinSceneSec).toBeLessThanOrEqual(loc.sceneEnd - loc.sceneStart);
  });
});
