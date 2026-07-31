/** One piece of footage as it sits on the finished timeline. */
export interface PlacedClip {
  /** How to name it back to the author, e.g. "segment 2" or "clip 1". */
  label: string;
  mediaId: string;
  from: number;
  to: number;
  /** Muted, or at volume 0: it contributes no sound. */
  silent: boolean;
  /** Length of the source, or 0 when it is not in the cache and cannot be measured. */
  sourceLen: number;
  /** The author trimmed the source deliberately (a start/end window), so a short cut is intended. */
  trimmed: boolean;
}

/** One music/voice track as it sits on the finished timeline. */
export interface PlacedTrack {
  from: number;
  to: number;
  /** False when the source is not in the cache, so `to` is a guess and length-based checks skip it. */
  known: boolean;
  /** It replaces whatever else is playing rather than blending with it. */
  exclusive: boolean;
}

const overlaps = (clip: PlacedClip, track: PlacedTrack): boolean =>
  track.from < clip.to && track.to > clip.from;

/** How much shorter than its source a cut may be before it reads as chopped off. */
const TRIM_SLACK_SEC = 0.5;

/** Every way a soundtrack and its footage can be laid out wrong, in one place, so both the timeline
 * and the editor answer the same. Each finding names the fix, because these are all recoverable by
 * changing one field. */
export function audioPlanWarnings(
  clips: PlacedClip[],
  tracks: PlacedTrack[],
  totalDuration: number,
  placementHint: string,
): string[] {
  const warnings: string[] = [];

  const measured = tracks.filter((track) => track.known);
  if (measured.length > 0) {
    const end = Math.max(...measured.map((track) => track.to));
    if (totalDuration > end + 1) {
      warnings.push(
        `the video is ${Math.round(totalDuration)}s but the audio only covers ${Math.round(end)}s, so the last ${Math.round(totalDuration - end)}s play in SILENCE. Either shorten the video to the audio, or add a track to cover the tail.`,
      );
    }
  }

  for (const clip of clips) {
    const over = tracks.filter((track) => overlaps(clip, track));

    if (clip.silent && over.length === 0) {
      warnings.push(
        `${clip.label} (${clip.from.toFixed(1)}-${clip.to.toFixed(1)}s) silences its own clip and nothing else plays there, so those ${Math.round(clip.to - clip.from)}s are COMPLETELY SILENT. Silencing footage is only right when a music or voice track runs over it. Unless the brief asked for silence here, let the clip's own sound through: a cut to a clip is a cut to its audio.`,
      );
    }

    if (!clip.silent && over.length > 0) {
      const exclusive = over.some((track) => track.exclusive);
      warnings.push(
        exclusive
          ? `${clip.label} (${clip.from.toFixed(1)}-${clip.to.toFixed(1)}s) keeps its clip's own audio, but a track set to REPLACE the audio also covers it, which throws the clip's sound away entirely. If that track belongs to a later section, ${placementHint} If it belongs over this footage, use mix instead of replace and give it a low volume so the scene stays on top.`
          : `${clip.label} (${clip.from.toFixed(1)}-${clip.to.toFixed(1)}s) keeps its clip's own audio, but a music track plays across it too, and a mastered track is far louder than recorded footage — the clip's sound ends up buried, which a listener hears as the music having replaced the scene. If the music belongs to a later section (closing credits, an outro), ${placementHint} If it really belongs over this footage, drop that track's volume to ~0.15.`,
      );
    }

    if (
      !clip.trimmed &&
      clip.sourceLen > 0 &&
      clip.to - clip.from < clip.sourceLen - TRIM_SLACK_SEC
    ) {
      const shown = clip.to - clip.from;
      warnings.push(
        `${clip.label} runs ${shown.toFixed(1)}s but its clip ${clip.mediaId} is ${clip.sourceLen.toFixed(1)}s long, so the clip is cut off ${(clip.sourceLen - shown).toFixed(1)}s early, mid-action — whatever it was building to is missing. Unless a shorter cut was asked for, give it the clip's full ${clip.sourceLen.toFixed(2)}s. If the video has to hit a total length, take the time out of a title or credits card instead: those hold any length, footage does not.`,
      );
    }
  }

  return warnings;
}
