import { ExecError } from "../lib/exec.js";

// Also matches a `ytsearchN:` target: search resolves each hit through the same player clients, so a
// blocked client fails a search exactly the way it fails a watch url.
const YOUTUBE_RE = /(^|\/\/|\.)(youtube\.com|youtu\.be)|^ytsearch/i;

// YouTube throttles each of its player clients separately, so the one yt-dlp reaches for first can be
// blocked from this address while another still answers. Naming a second client lets yt-dlp fall
// through instead of giving up, which is what turns most "not a bot" refusals back into a normal
// download. Only clients that need no PO token belong here: mweb and the tv variants either get their
// formats skipped or are not supported, so listing them adds warnings and nothing else.
const PLAYER_CLIENTS = "default,web_safari";

export function ytdlpExtractorArgs(url: string): string[] {
  return YOUTUBE_RE.test(url)
    ? ["--extractor-args", `youtube:player_client=${PLAYER_CLIENTS}`]
    : [];
}

const BOT_CHECK_RE = /sign in to confirm|not a bot|too many requests|http error 429/i;

// A bot check means YouTube is rate-limiting this server for a while. The raw stderr tail reads like a
// permanent, unfixable wall, so callers retry it a few times and then quietly ship without whatever
// they needed the media for. Say what actually helps instead, including the part about not dropping
// the requirement in silence.
export function ytdlpFailure(error: unknown): Error | null {
  if (!(error instanceof ExecError)) return null;
  if (!BOT_CHECK_RE.test(error.stderr)) return null;
  return new Error(
    "YouTube is rate-limiting this server (its bot check). This is temporary and is NOT a bad url, a private video, or a missing login, so retrying the same url immediately will fail the same way. Either wait ~60s and try that url once more, or take the audio/video from another source (SoundCloud, a direct file url, another upload of the same track). If you cannot get it, say so in your reply: the thing you were asked to include is still missing, and shipping the video without it and without a word is worse than asking.",
  );
}
