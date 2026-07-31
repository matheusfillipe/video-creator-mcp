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
  /** The author stated that this stretch is meant to be silent, so silence is the design, not a
   * dropped soundtrack. */
  silenceIntended: boolean;
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

export interface AudioPlanFinding {
  /** "error" is refused before rendering; "warn" is reported alongside the finished video. */
  level: "error" | "warn";
  message: string;
}

const overlaps = (clip: PlacedClip, track: PlacedTrack): boolean =>
  track.from < clip.to && track.to > clip.from;

/** How much of a clip has to survive before a cut stops reading as chopped off. Showing an excerpt is
 * normal in a montage; losing most of the clip is what leaves a scene without its payoff. */
const TRIM_KEEP_RATIO = 0.6;

/** Every way a soundtrack and its footage can be laid out wrong, in one place, so the timeline and
 * the editor answer the same. Each finding names the fix, because these are all recoverable by
 * changing one field.
 *
 * Footage running with no sound at all is an error rather than a warning: it is picture over dead
 * air, it is never what a brief meant by "cut to this clip", and as a warning it was simply rendered
 * and shipped. Refusing costs one more call and cannot ship the broken video. */
export function audioPlanFindings(
  clips: PlacedClip[],
  tracks: PlacedTrack[],
  totalDuration: number,
  placementHint: string,
): AudioPlanFinding[] {
  const findings: AudioPlanFinding[] = [];
  const warn = (message: string) => findings.push({ level: "warn", message });

  const measured = tracks.filter((track) => track.known);
  if (measured.length > 0) {
    const end = Math.max(...measured.map((track) => track.to));
    if (totalDuration > end + 1) {
      warn(
        `the video is ${Math.round(totalDuration)}s but the audio only covers ${Math.round(end)}s, so the last ${Math.round(totalDuration - end)}s play in SILENCE. Either shorten the video to the audio, or add a track to cover the tail.`,
      );
    }
  }

  for (const clip of clips) {
    const over = tracks.filter((track) => overlaps(clip, track));

    if (clip.silent && over.length === 0 && !clip.silenceIntended) {
      findings.push({
        level: "error",
        message: `${clip.label} (${clip.from.toFixed(1)}-${clip.to.toFixed(1)}s) silences its own clip and nothing else plays there, so those ${Math.round(clip.to - clip.from)}s would be picture over COMPLETE SILENCE. Fix one of two things and submit again: drop \`muted\`/\`volume:0\` from that clip so its own sound plays (a cut to a clip is a cut to its audio, and this is almost always the answer), or give that stretch a music/voice track. If the brief genuinely asked for a silent passage here, keep the mute and add \`intentional_silence: true\` alongside it to say so on purpose — then it renders, and silence is a choice on the record rather than a soundtrack that went missing.`,
      });
    }

    if (!clip.silent && over.length > 0) {
      warn(
        over.some((track) => track.exclusive)
          ? `${clip.label} (${clip.from.toFixed(1)}-${clip.to.toFixed(1)}s) keeps its clip's own audio, but a track set to REPLACE the audio also covers it, which throws the clip's sound away entirely. If that track belongs to a later section, ${placementHint} If it belongs over this footage, use mix instead of replace and give it a low volume so the scene stays on top.`
          : `${clip.label} (${clip.from.toFixed(1)}-${clip.to.toFixed(1)}s) keeps its clip's own audio, but a music track plays across it too, and a mastered track is far louder than recorded footage — the clip's sound ends up buried, which a listener hears as the music having replaced the scene. If the music belongs to a later section (closing credits, an outro), ${placementHint} If it really belongs over this footage, drop that track's volume to ~0.15.`,
      );
    }

    if (
      !clip.trimmed &&
      clip.sourceLen > 0 &&
      clip.to - clip.from < clip.sourceLen * TRIM_KEEP_RATIO
    ) {
      const shown = clip.to - clip.from;
      warn(
        `${clip.label} runs ${shown.toFixed(1)}s but its clip ${clip.mediaId} is ${clip.sourceLen.toFixed(1)}s long, so the clip is cut off ${(clip.sourceLen - shown).toFixed(1)}s early, mid-action — whatever it was building to is missing. Unless a shorter cut was asked for, give it the clip's full ${clip.sourceLen.toFixed(2)}s. If the video has to hit a total length, take the time out of a title or credits card instead: those hold any length, footage does not.`,
      );
    }
  }

  return findings;
}

/** Throws when the plan would ship footage over dead air, listing everything wrong with it. */
export function assertAudioPlan(findings: AudioPlanFinding[]): string[] {
  const errors = findings.filter((finding) => finding.level === "error");
  if (errors.length > 0) {
    throw new Error(
      `render refused — this would ship footage with no sound: ${errors.map((error) => error.message).join(" | ")}`,
    );
  }
  return findings.map((finding) => finding.message);
}
