import { describe, expect, it } from "vitest";
import { ExecError } from "../../src/lib/exec.js";
import { ytdlpExtractorArgs, ytdlpFailure } from "../../src/services/ytdlp.js";

describe("ytdlpExtractorArgs", () => {
  it("names fallback player clients for youtube urls and search targets", () => {
    for (const target of [
      "https://www.youtube.com/watch?v=q9RAZxNdCk8",
      "https://youtu.be/q9RAZxNdCk8",
      "ytsearch5:curb your enthusiasm theme",
    ]) {
      expect(ytdlpExtractorArgs(target)).toEqual([
        "--extractor-args",
        "youtube:player_client=default,web_safari",
      ]);
    }
  });

  it("leaves other hosts alone", () => {
    expect(ytdlpExtractorArgs("https://soundcloud.com/x/y")).toEqual([]);
    expect(ytdlpExtractorArgs("https://s3-api.t3ks.com/videos/clip.mp4")).toEqual([]);
  });

  it("does not match a host that merely contains the name", () => {
    expect(ytdlpExtractorArgs("https://notyoutube.com/watch?v=1")).toEqual([]);
  });
});

describe("ytdlpFailure", () => {
  const failure = (stderr: string) => new ExecError("yt-dlp", 1, stderr);

  it("explains a bot check as temporary rate limiting", () => {
    const explained = ytdlpFailure(
      failure("ERROR: [youtube] q9RAZxNdCk8: Sign in to confirm you're not a bot"),
    );
    expect(explained?.message).toMatch(/rate-limiting/);
    expect(explained?.message).toMatch(/another source/);
    expect(explained?.message).toMatch(/say so/);
  });

  it("also catches an outright 429", () => {
    expect(ytdlpFailure(failure("HTTP Error 429: Too Many Requests"))).not.toBeNull();
  });

  it("passes through unrelated failures untouched", () => {
    expect(ytdlpFailure(failure("ERROR: Requested format is not available"))).toBeNull();
    expect(ytdlpFailure(new Error("Sign in to confirm you're not a bot"))).toBeNull();
  });
});
