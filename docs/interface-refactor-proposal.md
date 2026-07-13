# Interface refactor proposal — declarative, stateless composition

Status: **Phase 0 spike PASSED (GO, 2026-07-13)** — the narrated-subset `video_plan` +
`video_compose` are live, and glm-5.2 authored valid compositions in #dev: one plan + one compose
first try on a 3-scene short (3m34s wall, same as the old narrow tool), self-corrected from
compose findings in ~12s/attempt on per-scene style overrides, and mapped natural-language timing
("breathe 2s", "captions half a second early") to `voice.start` / caption `offset` exactly.
Rollout below is unlocked; build incrementally.

## Why

~34 tools today, with overlapping agent-facing paths: a narrated math video can be built by
`video_narrated_scenes` (right) OR by `video_render_math` + `video_tts` + `video_add_audio` (the
hand-stitch that caused the misalignment / wrong-aspect / 3× re-render bugs). Two agent-facing ways
to the same result. It's patched with a CloudBot single-render guard + preamble routing — band-aids
over an ambiguous interface.

Goal: describe a movie as data; one path per task; nothing to guard.

## Hard constraint: interface-only, no infra change

This is a pure interface restructuring. NO infra changes: no new services/pods/containers, no new
images beyond what is already deployed, no k8s/Helm/registry changes. The alignment model is already
baked into the image; every capability already has a service function. `video_compose`/`video_graphic`
are new tool + orchestration layers that reuse the existing service code (narratedScenes, edit,
align, captions, audio mux, the render_* services). Deploy path is unchanged: commit + push -> CI ->
keel rollout. If a phase would require an infra change, it is out of scope for this plan.

## Principles

- A movie is a declarative timeline (data), not a sequence of behavior-switching tool calls. The
  flexibility lives in the schema, not in mode flags (avoids the god-tool trap).
- Stateless: every artifact is a content-addressed `media_id` (same input -> same id); the whole
  movie is one self-contained spec; async jobs are handles, not server sessions.
- Few high-leverage, orthogonal tools; unambiguous names; return high-signal data (media_id + a
  human timeline, not raw ids).
- Self-documenting: discriminated-union schemas with field descriptions + the guide resources.

## Target tool set (~10)

Assets -> `media_id`
- `video_search` — find footage/music
- `video_fetch` — download a URL/clip/segment (merges get_info/download)
- `video_speak` — TTS: text + voice/clone/acting (= today's `video_tts`)

Analyze -> data
- `video_inspect` — dims/duration/loudness/silence/safe-regions (merges analyze_static/audio)
- `video_align` — audio + known text -> word + cue timings. KEEP exposed (non-render uses:
  cut-to-phrase, karaoke elsewhere, custom subtitle tracks).
- `video_find` — locate a spoken phrase inside a clip -> timestamps

Generate a visual -> `media_id`
- `video_graphic` — ONE tool, discriminated by `kind`: `math | chart | terminal | manim | block |
  html`. Collapses the whole `render_*` zoo behind one typed union.

Compose + poll
- `video_compose` — the declarative timeline (below). The one way to assemble anything.
- `video_status` — poll async jobs (= render_status)

Utilities kept standalone: `video_get_thumbnail`, `video_remove_background`, `video_get_recipe`
(recipe = return the compose spec that made a video, so it can be tweaked + re-rendered).

Frame tools that MUST accept the new composition schema:
- `video_preview_frame(composition, at_sec)` — render ONE frame of a composition at a timestamp
  WITHOUT a full render. The agent's cheap vision-check for layout/timing (does the caption overlap?
  is the title placed right at t=2s?) before committing to a full render. Works on the same declarative
  spec `video_compose` takes.
- `video_extract_frame(media_id, at_sec)` — pull a frame from an already-rendered clip.

## The composition language (`video_compose` input)

Format decision, from research into what agents + humans already know for declarative video:

- **Shotstack** ("JSON-to-video"): `timeline -> tracks -> clips{asset,start,length,transition,fit,
  position} + soundtrack{src,volume}`. Layered, widely used in automation, LLM-generates well.
- **JSON2Video**: `movie -> scenes -> elements[type:...]` with `start/duration/x/y/volume`. Its
  scene->element nesting maps directly to "outer segment composes inner elements + aligns them".
- **OpenTimelineIO (OTIO)**: the pro editorial *interchange* standard — `Timeline -> Stack ->
  Track -> Clip/Gap/Transition/nested Stack`. True recursive nesting + transitions between any
  composable, but verbose editorial JSON. Borrow the ideas, not the serialization.
- **Remotion**: React/JSX code — max LLM familiarity but a framework, not a data language. Wrong
  fit for a declarative spec the agent emits.

Chosen base: the **"JSON-to-video" idiom (Shotstack + JSON2Video)** — the shape agents already
generate — extended with: (1) recursive nesting (OTIO idea: a clip's `asset` can itself be a
scene/composition), (2) **relative alignment** (`align`, `fit`) as our differentiator, (3) a `defs`
block for reusable named assets/voice/styles referenced by `@id`.

```jsonc
{
  "output": { "resolution": "portrait", "fps": 30 },
  "defs": { "vo": { "clone_from": "mediaX" }, "bed": { "media_id": "m1" } },   // reusable, @id refs
  "soundtrack": { "use": "@bed", "volume": 0.25, "duck_under_voice": true, "lead_in": 1 },
  "captions": { "mode": "block|karaoke", "color": "yellow", "position": "bottom",
                "size": "medium", "box": true },
  "scenes": [                                   // outer, sequential segments
    {
      "narration": { "text": "...", "voice": "@vo" },   // optional
      "duration": "fit",                        // "fit" = scene length = its narration; or seconds
      "tracks": [                               // inner, layered (order = z-order)
        { "clips": [ { "asset": { "type": "video", "media_id": "footage1" }, "fit": "cover" } ] },
        { "clips": [ { "asset": { "type": "graphic", "kind": "title", "text": "Fact 1" },
                       "align": "with:narration.start", "position": "top" } ] }
      ],
      "transition_out": { "kind": "fade|slide|none", "sec": 0.3 }
    }
  ]
}
```

Field vocabulary reuses the familiar names: `scenes`, `tracks`, `clips`, `asset`+`type`, `start`/
`length` (or `duration`), `transition`, `fit`, `position`, `soundtrack`+`volume`. Additions:
- `duration: "fit"` — scene length = its narration length (sync-by-construction).
- `align: "with:X" | "after:X" | "fit"` — relative timing/anchoring (the "try to align it").
- `asset.type`: `video | image | audio | graphic | scene` — `scene` nests a whole composition
  (compound clip); `graphic` carries a `kind` (= the `video_graphic` union: math/chart/title/...).
- `defs` + `@id` references — define once (a cloned voice, a music bed, a caption style), reuse.

Returns: finished MP4 `media_id` + a human timeline (`[{scene, line, start, end}]`).

Subsumes: narrated explainer (`narration` + `duration:"fit"` + `captions.mode`); cut/supercut/
reaction (clips trimmed, multiple `tracks`/nested `scene` for split-screen); math/chart/slideshow/
tierlist (`asset.type:"graphic"`); music/duck/lead-in/transitions/caption styling+karaoke (declared).

Sources: Shotstack JSON-to-video, JSON2Video movie schema, OpenTimelineIO file format.

### The generic model (no special globals)

Do NOT special-case `soundtrack`/`captions` as top-level fields (that hard-locks per-segment
control). Everything is uniform:

- **One recursive type, `composition`** = tracks of clips. A clip's `type` can be `composition`, so
  nesting is unlimited. There is no privileged movie/scene/segment; all are compositions.
- **Uniform clip types**: `video | image | audio | text(caption) | graphic | composition`. Music,
  narration, sfx, and captions are just clips, not globals. Different music or caption style per
  segment = put a different audio/caption clip (or `defaults`) inside that segment's composition.
- **Cascading defaults**: any composition declares `defaults` inherited by descendants unless
  overridden. Rules: nearest-wins, **deep-merge per key** (override `caption.color`, keep inherited
  `caption.mode`), and only contextual/style props inherit (resolution, fps, caption style, voice,
  font, safe-margins) - structure (media_id/start/align) is always per-clip. Resolved top-down.
- **Timing model** (see below) — placement, duration, and source trim are independent per clip.

### Timing and placement (independent per clip)

Placement, duration, and source trim are three separate things (conflating them into one `align`
was too coarse to say "voice starts 1.5s into the clip" or "caption lingers after the word"):

- `start` = when it begins in its parent: `number` (seconds) | `"sequence"` (after the previous clip
  on this track, the default) | `{ after|with|before: "<clipId>.start|end", offset: <+/-sec> }`.
- `duration` = `number` | `"intrinsic"` (its natural length: audio/video source, or a graphic's
  authored length) | `{ fit: "<clipId>" }` (match another element) | `{ until: "<anchor>" }`.
- `in` / `out` = source trim (which part of the source to use), independent of placement.
- `id` = so siblings can anchor to it.
- captions: `from:"<voice>"` + `offset` (shift all cues) / `lead` (appear before the word) / `trail`
  (linger after); or explicit `cues:[{text,start,end}]`.

Track + composition semantics that make timing compose:
- within a track, clips are **sequential by default** (start = prev clip's end); override `start` to
  overlap/gap/offset. Tracks are **parallel layers** (order = z-order).
- a composition's `duration` = `max(child end)` unless set. So a late-starting voice stretches the
  scene to cover it while the video plays under, and `fit` means "as long as its content runs,
  offsets included."

Examples: voice in 1.5s late = voice clip `start:1.5` on its own track, video `duration:"intrinsic"`
on another. Caption offset = `offset`/`lead`/`trail`. Title on the beat = `start:{after:"music.start",
offset:8}`. All from one model, no special cases. Anchors may only reference already-defined siblings
(forbids cycles); `video_plan` resolves every relative time to absolute, validates
(unresolvable/circular/missing anchor), and echoes the resolved absolute timeline.

Completeness is by construction: it is a superset of OTIO (which losslessly represents any editorial
timeline) plus generative clip types. The `graphic{kind:manim|html|block}` escape hatch takes RAW
code, so any effect an engine can produce is referenceable without the language ever growing - the
tree composes, the producers produce. Vocabulary stays friendly (`composition/track/clip/type`);
an OTIO export adapter can be added later for interop rather than making agents speak OTIO.

## Agent + MCP fitness (validation is core, not polish)

A declarative document is validatable and dry-runnable, which an imperative tool sequence is not.
That is the main reason this shape is good for agents - but only if shipped with the tooling below.

- **`video_plan` (dry-run), mandatory.** Resolves + validates a composition WITHOUT rendering:
  returns the resolved absolute timeline (every clip's computed start/end + effective inherited
  style) plus a findings list. The agent validates cheap, fixes, renders once. This is what makes a
  big-JSON interface workable for a weak model (glm), and it structurally removes the multi-render
  slowness (the single-render guard becomes unnecessary).
- **Findings shape**: `[{ path, severity, message, hint }]`, e.g.
  `{path:"tracks[1].clips[0]", severity:"error", message:"media_id 'x' not found", hint:"video_fetch it first"}`.
  Validate: schema, refs (`@defs`, `align` targets), media exists / `src` fetchable, durations
  resolvable (a `fit` clip needs a narration), nesting depth within cap, timing sanity.
- **Cascade keeps the common case small** (a narrated short is ~15 lines; depth only when complex).
- **Bottom-up via media_id, so statelessness never forces one giant blob**: render a sub-composition
  to a media_id (small compose), reference it in the outer movie. A 20-segment film = 20 small
  stateless composes + one thin outer one. Composability is the scaling answer.
- **Presets**: documented compositions the agent fills, not authors from scratch ("narrated short",
  "split reaction", "math explainer"). Weak agent fills a template; strong agent writes the tree.
- **Bounded nesting depth** (~4) so recursion can't run away and validation stays finite.
- **Caching**: per-artifact content-addressed caching, not whole-tree hashing. Each speech line,
  each math render, and each multi-visual layout combine is a cache hit on re-render; the final
  concat/caption/mux still re-runs every time.

Residual risk: glm is weak, and a powerful language lets a weak agent make a mess. The guardrails
(plan step, cascade, presets, depth cap, high-signal findings) are what hold it. Without them this
is worse than today's narrow tools; with them it is better - one validated path, real feedback.

## Future: the composition JSON is an editable project file (shapes the format now)

The composition JSON is not only a render spec, it is the project file (same category as OTIO /
FCPXML / MLT). A future manual editor (a web timeline UI) reads it, the user drags/trims/reorders,
writes it back, and re-renders via `video_compose`. Agent and human edit the SAME artifact, and every
clip references the ORIGINAL media (media_id/src), never baked pixels, so all edits are
non-destructive. This is a desired future build, and it raises the payoff of doing the format right
(it is a real capability, not just agent hygiene).

Already supported by the design: lossless round-trip (whole video in the JSON, statelessness), clips
reference originals, stable clip `id`s double as the editor's handle, `video_plan` resolves the
absolute timeline the UI lays out, and the tree maps cleanly to lanes/blocks/compound-clips.

Shipped, so old projects stay openable:
- **Composition JSON stored with every render** (`video_get_recipe` / a sidecar) so any past
  video is reopenable + editable.
- **Durable media**: the referenced media resolves later via the composition's media map
  (media_id -> url), backed by retention on the existing MinIO bucket; no new infra.
- **A schema `version` field** so a future editor can read older project files (OTIO does this).

Remaining:
- Optional per-clip **editor `meta`** (label, color, marker, locked) the renderer ignores.
- Optional **OTIO import/export adapter** for interop with pro editors.

## Migration map

| Today | Becomes |
|---|---|
| `narrated_scenes` | `video_compose` (fit + `captions:"auto"`) |
| `edit`, `loop`, `add_audio`, `caption` | `video_compose` fields |
| `render_math/manim/chart/tierlist/terminal/slideshow`, `render_block` | `video_graphic` kinds / inline `visual.graphic` |
| `render`, `render_timeline` (HTML) | `video_graphic {kind:"html"}` / a compose scene |
| `tts` | `video_speak` |
| `get_info` / `download` | `video_fetch` |
| `analyze_static` / `analyze_audio` | `video_inspect` |
| `render_status` / `render_queue` | `video_status` |
| `align` | keep as-is |

## How we build, test, and ship here (the loop every phase uses)

1. **Build + typecheck + lint** locally (`tsc --noEmit`, `biome check`). Note: the dev-box ffmpeg
   has no drawtext/libass, so caption/ASS renders cannot run locally; render tests happen on the
   deployed pod.
2. **`/rev` before committing** — the review fan-out (standards / bugs / reuse-arch specialists) over
   the diff, then fix findings. This is the standard gate; the alignment/CTC work was caught+fixed
   this way.
3. **Direct tool test** — call the MCP tool over `video-mcp.t3ks.com/mcp` (Kong key-auth) from a
   small script, poll `video_status`, download the result, `ffprobe` it, extract frames, and eyeball
   them (or a montage). Deterministic, no agent in the loop.
4. **Agent e2e via the ircv3 MCP** — the LOCAL CloudBot (`_cloudbot_`, `uv run python -m cloudbot`)
   auto-joins `#dev`; send a `.agi` request via the ircv3 MCP and watch it drive video-mcp end to
   end (`SUBAGENT_PROF` logs show the tool sequence). Tests the real bot -> video-mcp -> result path.
   The deployed prod bot ships only via the CloudBot GitHub repo (edit-only locally; user deploys).
5. **Ship** — video-mcp is push-authorized: commit + push -> GitHub Actions CI -> keel rollout
   (poll @5m). Nudge with `kubectl -n video-mcp rollout restart deploy/video-mcp` to skip the poll
   wait. Expect a brief 503 during pod transition; retry.
6. **Verify on the deployed build** — re-run the direct + agent tests, frame-check the output.

`video_preview_frame` is the in-loop fast check: before a full render the agent (or we) render one
frame at a timestamp to confirm layout/timing.

## Phase 0: de-risk spike — can glm-5.2 author this? (go/no-go gate)

The whole plan rests on one unproven bet: that a weak agent (glm-5.2, what runs in prod) can author
AND iterate the declarative composition JSON. Validate that BEFORE the full refactor. If it fails,
most of this plan should not be built (for the agent).

Minimal build (one cycle, thin, reuses existing code):
- `video_compose` covering ONLY the narrated case — a thin wrapper over the existing narratedScenes +
  caption code, accepting a small subset of the real schema (composition -> tracks -> clips of
  video|voice|caption, `defaults`, `start`/`duration:"fit"`). Enough to be the genuine declarative
  shape, not the whole language.
- `video_plan` (dry-run: resolve + validate + return resolved timeline + findings).
- One preset composition (a "narrated short" template the agent fills in).
- Test WITH the guardrails (plan + preset), since those are the mitigations. Testing raw compose
  without them would be an unfair test.

Test protocol (the normal loop, via the ircv3 MCP in #dev):
- Escalating `.agi` prompts: (1) a 3-scene narrated short; (2) a per-segment caption-style override;
  (3) a voice that starts ~1.5s late and a caption offset.
- Observe: does glm emit VALID composition JSON? Does it call `video_plan` and FIX from the findings?
  How many attempts + tokens? Is the output correct?

Go / no-go:
- **GO** if glm authors valid JSON first try (or fixes cleanly from `video_plan` findings), output is
  right, and it is not markedly slower / more error-prone than today's narrow tool. Then proceed to
  the rollout below.
- **NO-GO** if glm reliably chokes on the nested JSON even with plan + preset. Then the "better for
  agents" premise is false: keep the current narrow tools as the agent path, and reserve
  `video_compose` for humans / the future editor only (still worth it as a project format, not as the
  agent-facing generator).

Cost: small. It converts the plan's biggest uncertainty into evidence before any large investment.

## Rollout (incremental, each phase deployable + tested) — only on a Phase 0 GO

1. **Shipped.** `video_compose` is a superset, internally reusing the existing narratedScenes /
   edit (stack/pip/grid + crossfade) / align / caption / audio-mux code, with parity proven
   against `video_narrated_scenes`.
2. **Shipped.** `video_graphic` (discriminated union) dispatches to the existing render_* service
   functions.
3. **Demoted** from the agent-facing tool list: `video_narrated_scenes`, `video_render_math`,
   `video_render_manim`, `video_render_chart`, `video_render_terminal`, `video_render_block`, and
   the generic `video_render` tool (superseded by `video_compose` / `video_graphic`; their
   service functions are called from the new tools instead of being exposed standalone). **Kept**
   agent-facing, because `video_compose` does not yet cover their unique powers: `video_edit`,
   `video_add_audio`, `video_caption`, `video_loop`, `video_render_tierlist`,
   `video_render_timeline`, `video_render_slideshow`. The authoring guides route to this
   surviving set.
4. **Partially done.** The CloudBot single-render guard is kept, but scoped to `video_compose`
   only, and it clears itself once the guarded job's status comes back as an error so the model
   can fix and resubmit.
5. **Done.** The primitives (`align`, `speak`, `fetch`, `search`, `inspect`, `status`) stayed
   exposed.

## Parity + risk

Full parity is possible — nothing is removed, only reorganized; the vertical renderers keep their
service code behind `video_graphic` / compose. The one risk: the compose schema must expose every
low-level knob the old tools had (per-clip trim/speed/volume, crossfade, pip position, grid cells).
Miss a knob and that specific combo is temporarily unavailable until added.

## Decisions / notes

- Keep `video_align` exposed (desired for non-render uses).
- Direct STT tool: DEFERRED. `wav2vec2-base-960h` can transcribe audio alone but poorly (uppercase,
  no punctuation, phonetic errors on hard words, English-only). Revisit with faster-whisper
  (tiny/base, CTranslate2, CPU, in-process) if quality STT is wanted.
- Value: this adds no new user-facing capability except easier multi-scene/transition movies — it's
  an interface + maintainability investment. Build `video_compose` when a real movie needs it.
- Optional ergonomics: keep a thin `narrated_scenes`-style documented preset OVER `video_compose`
  for the common "just narrate these beats" case — a preset, not a second engine.
