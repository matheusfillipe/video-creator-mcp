---
name: tts
description: Direct expressive voice acting with video_tts (Chatterbox). Pick exaggeration/cfg_weight from the emotion you want, prep the text for delivery, clone a voice from a reference clip, mind the cost, and use the returned duration to compose with video. Read before generating narration or character voices.
---

# Voice acting with video_tts

`video_tts` turns text into an expressive spoken clip. You are the director: the model does not read intent from the words, so you set the acting explicitly with two dials and shape delivery through the text itself.

## The two dials

- **exaggeration** (0 to 2) is the emotional intensity.
  - `0.3` calm, restrained, informational (documentary narration, explainer)
  - `0.5` natural, conversational (default)
  - `0.7` engaged, animated (hype, storytelling)
  - `0.9` dramatic, urgent, big feelings (a reveal, a shout, fear/anger/joy)
  - Above `1.0` gets unstable and over-the-top; use only for a deliberate cartoon effect.
- **cfg_weight** (0 to 1) is pacing/guidance. Lower is slower and more deliberate.
  - Keep `0.5` for normal lines.
  - Drop to `~0.35` whenever exaggeration is high (`0.8+`) so the intense line does not rush and slur.
  - Raise toward `0.65` for a brisk, clipped read.

Pick the pair from the feeling, not the sentence length. A calm reassurance and a panicked warning can be the same words with opposite dials.

| You want | exaggeration | cfg_weight |
|--|--|--|
| Neutral explainer / narration | 0.3-0.45 | 0.5 |
| Friendly, conversational | 0.5 | 0.5 |
| Excited / hype | 0.7 | 0.5 |
| Dramatic reveal, strong emotion | 0.9 | 0.35 |
| Whispered / intimate | 0.4 | 0.3 |

## Prep the text for delivery

Punctuation is direction. The model performs what you write:

- Short sentences read with more punch. Break a long line into two.
- `...` creates a pause and a slower, weightier read.
- `!` lifts energy; `?` adds an upward, questioning contour.
- Ellipses and em-free dashes before a word set it apart ("and then, silence").
- Do NOT write stage directions like "(angrily)" into the text. They get spoken. Encode the emotion in the dials plus punctuation instead.
- Spell tricky names phonetically if they come out wrong.

## Clone a voice

To make it speak in a specific voice ("use THIS voice and say that"):

1. `video_download_media` the reference clip (5-15s of clean speech is plenty) to get a `media_id`.
2. Pass that `media_id` as `voice_reference`. It overrides `voice` and clones zero-shot.

The reference sets timbre and accent; you still drive the acting with the dials. A named `voice` (when the service ships preset voices) is the alternative to cloning.

## Cost and timing (plan around it)

Generation is autoregressive on CPU: roughly **5x realtime** (a 3s line takes ~15-20s) and the backend serializes requests one at a time. So:

- Do NOT generate dozens of lines blindly. Batch the script into the lines you actually need.
- **Parallelize** independent lines when order and exact timing do not matter, firing them together and collecting results.
- **Await** a line when you need its length before continuing (e.g. to size a scene to the narration).
- Reuse: the same text + voice + dials returns the same `media_id`, so regenerating is free.

## Compose with video

Every call returns `duration_sec` and a downloadable `url`, plus a `tts-audio` JSON artifact describing the acting used. Two patterns:

- **Audio only**: use the `url` / `media_id` directly. Nothing else needed.
- **Narrate a video**: generate the voice first (so you know `duration_sec`), build or trim the visual to match, then `video_add_audio(media_id: <video>, audio_media_id: <tts media_id>, mode: "replace")`. Add music after with `mode: "mix"`.

For a multi-line script, generate each line, then place them on a timeline at cumulative start times using each clip's `duration_sec`. That gives you exact segment timing without any alignment step.
