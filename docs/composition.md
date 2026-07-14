# Composition format

The JSON `video_compose` renders. It is also the video's editable project file: every render writes the composition back as a recipe sidecar (`video_get_recipe`), so you fetch it, change a field, and re-render. For the exact per-field schema see `video_compose` in [TOOLS.md](TOOLS.md); this page is the mental model.

## Shape

```jsonc
{
  "version": 1,
  "output": { "resolution": "landscape", "fps": 30, "tail_sec": 0.6 },
  "defaults": { "caption": { "mode": "karaoke", "color": "yellow" } },
  "tracks": [
    { "clips": [                                  // the scene track: scenes play in order
      { "type": "composition", "id": "intro", "duration": "fit", "tracks": [
        { "clips": [ { "type": "video", "media_id": "clip1" } ] },   // the visual
        { "clips": [ { "type": "voice", "text": "The opening line." } ] },
        { "clips": [ { "type": "caption" } ] }                        // word-synced to the voice
      ]},
      { "type": "composition", "id": "compare", "layout": "hstack", "tracks": [
        { "clips": [ { "type": "video", "media_id": "left" },
                     { "type": "video", "media_id": "right" } ] },    // 2 visuals -> split screen
        { "clips": [ { "type": "voice", "text": "Side by side." } ] },
        { "clips": [ { "type": "caption" } ] }
      ]}
    ]},
    { "clips": [ { "type": "audio", "media_id": "music", "volume": 0.25 } ] }  // one music bed
  ]
}
```

Tracks are parallel layers; clips on a track play in order. The top level holds one **scene track** (a sequence of scenes) plus optionally one **music track**. Inside a scene, each parallel track is one layer: the visual, the voice, the caption.

## A scene (`type: "composition"`)

- `duration`: `"fit"` (as long as its voice) or a number of seconds (holds the scene longer, or a silent beat with no voice).
- `layout`: how the scene's visual clips are arranged (below).
- `transition_out`: `{ "kind": "fade", "sec": 0.4 }` fades this scene to black and the next in from black. Durations don't change.
- `defaults`: style defaults for just this scene's clips.
- `tracks`: the parallel layers. A scene has one visual layer, at most one `voice`, at most one `caption` (no caption clip = no captions for that scene).

## Clip kinds

| `type` | what it is | key fields |
|---|---|---|
| `video` | footage or a still image (from `video_download_media`) | `media_id`; `in`/`out` trim which part of the source plays |
| `graphic` | an animated math scene (`kind: "math"`) | `latex`; `plot_expr`, `x_range`, `y_range`, `title`, `accent_color` |
| `voice` | the scene's narration; the scene is cut to its real spoken length | `text`; `start` delays the speech into the scene; `voice` overrides acting/clone |
| `caption` | word-synced subtitles force-aligned to this scene's voice | `style`; `offset` shifts the cues; `source` overrides the text |
| `audio` | the music bed (on the top-level track, not inside a scene) | `media_id`; `volume` (also ducked under the voice) |

## Layouts

Set on a scene; combines its visual clips into one view.

- `single` (default): one visual.
- `hstack` / `vstack`: exactly 2 visuals, left/right or top/bottom. Each is letterboxed into its half so the whole frame stays visible.
- `pip`: exactly 2, the first fullscreen with the second as a corner inset.
- `grid`: 2 to 4 visuals.

## Caption style

`mode` (`block` static phrases, or `karaoke` words highlight as spoken), `color`, `position` (`bottom`/`center`/`top`), `size` (`small`/`medium`/`large`), `background` (`none`, `box`, or `blur` = a frosted darkened strip), `shadow`, `outline`. Put `box`/`blur` behind captions over uncontrolled footage; use `none` over a math or graphic scene whose dark background already reads text cleanly.

## Style cascade

`caption` and `voice` styles inherit: root `defaults` -> scene `defaults` -> the clip's own `style`. Nearest wins, per key. Set a `color` once at the root and it applies everywhere unless a scene or clip overrides it.

## Editable project file

- `output.resolution`: `landscape`, `portrait`, `square`, `1080p`, `4k`, `uhd`.
- `media`: an optional `media_id -> url` map copied from a prior render's recipe. It lets a reopened composition fetch its media back into the cache when the ids are missing locally (a saved recipe re-rendered on a fresh pod).
- Because the render writes the whole composition back as a recipe, iterating is: `video_get_recipe` on the video's url, change one scene or field, `video_compose` again.
