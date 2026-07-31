import { describe, expect, it } from "vitest";
import {
  type PlacedClip,
  type PlacedTrack,
  assertAudioPlan,
  audioPlanFindings,
} from "../../src/services/audio-plan.js";

const clip = (over: Partial<PlacedClip> = {}): PlacedClip => ({
  label: "clip 1",
  mediaId: "abc",
  from: 3,
  to: 13,
  silent: false,
  sourceLen: 10,
  trimmed: false,
  ...over,
});
const track = (over: Partial<PlacedTrack> = {}): PlacedTrack => ({
  from: 13,
  to: 28,
  known: true,
  exclusive: false,
  ...over,
});

const msgs = (c: PlacedClip[], t: PlacedTrack[], d: number, h: string) =>
  audioPlanFindings(c, t, d, h).map((f) => f.message);

describe("audioPlanFindings", () => {
  const hint = "start it there with `start_segment`.";

  it("passes the shape we actually want: clip keeps its sound, song starts after it", () => {
    expect(msgs([clip()], [track()], 28, hint)).toEqual([]);
  });

  it("flags music laid across footage that kept its sound", () => {
    const out = msgs([clip()], [track({ from: 0, to: 20 })], 28, hint);
    expect(out.join()).toMatch(/ends up buried/);
    expect(out.join()).toMatch(/start_segment/);
  });

  it("calls out replace over kept footage as throwing the sound away", () => {
    const out = msgs([clip()], [track({ from: 0, to: 28, exclusive: true })], 28, hint);
    expect(out.join()).toMatch(/throws the clip's sound away/);
  });

  it("flags a silenced clip with nothing playing over it", () => {
    const out = msgs([clip({ silent: true })], [track()], 28, hint);
    expect(out.join()).toMatch(/COMPLETE SILENCE/);
  });

  it("accepts a silenced clip when a track covers it", () => {
    const out = msgs([clip({ silent: true })], [track({ from: 0, to: 28 })], 28, hint);
    expect(out.join()).not.toMatch(/COMPLETE SILENCE/);
  });

  it("flags a clip cut short of its source", () => {
    const out = msgs([clip({ to: 8, sourceLen: 10 })], [track({ from: 8 })], 28, hint);
    expect(out.join()).toMatch(/cut off 5\.0s early/);
  });

  it("accepts a short cut the author trimmed on purpose", () => {
    const out = msgs(
      [clip({ to: 8, sourceLen: 10, trimmed: true })],
      [track({ from: 8 })],
      28,
      hint,
    );
    expect(out.join()).not.toMatch(/cut off/);
  });

  it("flags a soundtrack that runs out before the video does", () => {
    const out = msgs([clip()], [track({ from: 13, to: 20 })], 40, hint);
    expect(out.join()).toMatch(/last 20s play in SILENCE/);
  });
});

describe("assertAudioPlan", () => {
  const hint = "start it there.";

  it("refuses a plan that would ship footage over dead air", () => {
    const findings = audioPlanFindings([clip({ silent: true })], [], 28, hint);
    expect(() => assertAudioPlan(findings)).toThrow(/render refused/);
    expect(() => assertAudioPlan(findings)).toThrow(/COMPLETE SILENCE/);
  });

  it("lets warnings through as messages", () => {
    const findings = audioPlanFindings(
      [clip({ to: 8, sourceLen: 10 })],
      [track({ from: 8 })],
      28,
      hint,
    );
    expect(assertAudioPlan(findings).join()).toMatch(/cut off/);
  });

  it("passes the shape we want with nothing to say", () => {
    expect(assertAudioPlan(audioPlanFindings([clip()], [track()], 28, hint))).toEqual([]);
  });
});
