---
name: tts
description: Direct expressive voice acting with video_tts (Chatterbox). Pick exaggeration/cfg_weight from the emotion you want, prep the text for delivery, clone a voice from a reference clip, mind the cost, and use the returned duration to compose with video. Read before generating narration or character voices.
---

# Voice acting with video_tts

`video_tts` turns text into an expressive spoken clip. You are the director: the model does not read intent from the words, so you set the acting explicitly with two dials and shape delivery through the text itself.

The model is **English-only**. Everything you pass MUST be English prose (transliterate foreign names into English spelling); any other language comes out as garbled noise.

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

## Emotion tags

The voice performs inline paralinguistic tags written in square brackets, anywhere in the text. Use them for a real, human delivery:

- `[laugh]` full laugh, `[chuckle]` a lighter laugh, `[sigh]`, `[gasp]`, `[cough]`, `[breath]` an audible breath, `[whisper]` for a hushed aside.

Place a tag exactly where the sound should happen, e.g. `"Oh wow [laugh], you actually did it."` or `"... and then, [sigh] it was over."` Don't overuse them; one or two per few sentences reads natural, a tag every line reads like a parody. They work together with cloning and with the dials, so a cloned voice can laugh or sigh in character.

## Clone a voice

To make it speak in a specific voice ("use THIS voice and say that"):

1. `video_download_media` the reference clip (5-15s of clean speech is plenty) to get a `media_id`.
2. Pass that `media_id` as `voice_reference`. It overrides `voice` and clones zero-shot.

The reference sets timbre and accent; you still drive the acting with the dials. Without a `voice_reference` you get the default voice.

## Cost and timing (plan around it)

Generation is autoregressive on CPU: roughly **5x realtime** (a 3s line takes ~15-20s) and the backend serializes requests one at a time. So:

- **Hit a target length up front with `video_tts_estimate`** (instant, free — no generation): call it with `target_sec` to get the exact **word budget** (Chatterbox speaks ~2.9 words/sec, so 25s ≈ 72 words), write the narration to that budget, then optionally call it again with your `text` to confirm it fits before generating. Do this whenever the user asks for a specific length — don't eyeball the word count.
- A single continuous narration is **ONE** `video_tts` call, however long — even for a whole video. It chunks and stitches internally. Do NOT split one voiceover into per-scene calls: each is a separate slow job, so three calls take three times as long for no benefit.
- Do NOT regenerate to tweak length — use `video_tts_estimate` to get it right BEFORE generating. After generating, read the real `duration_sec` and size the VIDEO to it.
- **Parallelize** only genuinely distinct clips (different characters/scenes that become separate media), never the pieces of one narration.
- Reuse: the same text + voice + dials returns the same `media_id`, so an identical re-request is free.

## Compose with video

Every call returns `duration_sec` and a downloadable `url`, plus a `tts-audio` JSON artifact describing the acting used. Two patterns:

- **Audio only**: use the `url` / `media_id` directly. Nothing else needed.
- **Narrate a video (with music)**: generate the voice FIRST so you know its `duration_sec`, then build the visual to be **at least `duration_sec` + 1s long** (the narration sets the length — extend/repeat footage or hold a shot to cover it). Then lay the voice AND the music in **ONE** call: `video_add_audio(media_id: <video>, audio_media_id: <tts media_id>, music_media_id: <music>, start_sec: 1, music_volume: 0.25)`. The music plays from 0:00 and is sidechain-ducked whenever the voice speaks (so the narration always stays clearly on top), `start_sec` gives the lead-in where the music breathes alone, and the video is auto-held on its last frame if the narration runs longer. Do this in one call — do NOT chain a `replace` + a `mix` (order-dependent, and a `replace` after the music wipes it), and do NOT put the narration in `video_edit`'s `music_media_id` (that caps to the clip length and cuts a long narration).
- **Narrate a video (no music)**: `video_add_audio(media_id: <video>, audio_media_id: <tts media_id>, mode: "replace", start_sec: 1)` — the video auto-extends to hold the last frame so nothing is cut.

Pass the whole narration to `video_tts` in ONE call, however long: it splits into chunks and stitches them in one voice, and returns a `job_id` you poll with `video_render_status`. Only make separate calls when you want distinct scenes as individually-timed clips (then place each at cumulative start times using its `duration_sec`).
