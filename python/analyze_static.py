"""Profile a video for static, structured regions (logos / watermarks / baked text bars)
so an overlay can be placed where the footage is clear.

Two cheap CPU signals per pixel, over downscaled sampled frames:
  - staticness  = low temporal variance (unchanging over time)
  - structure   = persistent Canny edges (graphics/text vs flat areas)
A region to AVOID is static AND structured (a baked logo/caption); a calm flat area
(low edges) is fine to write over whether it moves or not. Output is in the source
video's pixel coordinates so the caller can place overlays directly.
"""

import json
import sys

import cv2
import numpy as np

DOWNSCALE_WIDTH = 480
MAX_FRAMES = 240
TARGET_FPS = 2.0
GRID = 4
STATIC_STD = 10.0  # per-pixel stddev (0-255) below this is "static"
EDGE_PERSIST = 0.5  # fraction of frames a pixel is an edge to count as "structured"
STD_NORM = 40.0  # stddev mapped to 0..1 for the staticness score
MIN_REGION_FRAC = 0.004  # ignore avoid-blobs smaller than this fraction of the frame


def where_label(cx: float, cy: float, w: int, h: int) -> str:
    col = "left" if cx < w / 3 else "right" if cx > 2 * w / 3 else "center"
    row = "top" if cy < h / 3 else "bottom" if cy > 2 * h / 3 else "middle"
    return f"{row}-{col}"


def analyze(path: str, target_fps: float, grid: int) -> dict:
    cap = cv2.VideoCapture(path)
    if not cap.isOpened():
        raise SystemExit(f"could not open video: {path}")
    src_fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
    src_w = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH)) or DOWNSCALE_WIDTH
    src_h = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT)) or DOWNSCALE_WIDTH
    step = max(1, round(src_fps / target_fps))

    grays: list[np.ndarray] = []
    edge_acc: np.ndarray | None = None
    idx = 0
    while len(grays) < MAX_FRAMES:
        ok, frame = cap.read()
        if not ok:
            break
        if idx % step == 0:
            scale = DOWNSCALE_WIDTH / frame.shape[1]
            small = cv2.resize(frame, (DOWNSCALE_WIDTH, max(1, round(frame.shape[0] * scale))))
            gray = cv2.cvtColor(small, cv2.COLOR_BGR2GRAY)
            grays.append(gray.astype(np.float32))
            edges = cv2.Canny(gray, 80, 160) > 0
            edge_acc = edges.astype(np.float32) if edge_acc is None else edge_acc + edges
        idx += 1
    cap.release()

    if len(grays) < 2:
        raise SystemExit("not enough frames to analyze")

    stack = np.stack(grays)
    std = stack.std(axis=0)
    n = len(grays)
    edge_freq = (edge_acc / n) if edge_acc is not None else np.zeros_like(std)
    dh, dw = std.shape
    sx, sy = src_w / dw, src_h / dh

    static = std < STATIC_STD
    structured = edge_freq > EDGE_PERSIST
    avoid = static & structured
    staticness = 1.0 - np.clip(std / STD_NORM, 0.0, 1.0)

    cells = []
    for r in range(grid):
        for c in range(grid):
            y0, y1 = r * dh // grid, (r + 1) * dh // grid
            x0, x1 = c * dw // grid, (c + 1) * dw // grid
            cells.append(
                {
                    "row": r,
                    "col": c,
                    "staticness": round(float(staticness[y0:y1, x0:x1].mean()), 3),
                    "clutter": round(float(edge_freq[y0:y1, x0:x1].mean()), 3),
                    "avoid": round(float(avoid[y0:y1, x0:x1].mean()), 3),
                }
            )

    kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (9, 9))
    closed = cv2.morphologyEx((avoid * 255).astype(np.uint8), cv2.MORPH_CLOSE, kernel)
    count, _, stats, centroids = cv2.connectedComponentsWithStats(closed)
    min_area = MIN_REGION_FRAC * dw * dh
    regions = []
    for i in range(1, count):
        x, y, w, h, area = stats[i]
        if area < min_area:
            continue
        cx, cy = centroids[i]
        regions.append(
            {
                "x": round(x * sx),
                "y": round(y * sy),
                "w": round(w * sx),
                "h": round(h * sy),
                "where": where_label(cx, cy, dw, dh),
                "staticness": round(float(staticness[y : y + h, x : x + w].mean()), 3),
            }
        )
    regions.sort(key=lambda r: r["w"] * r["h"], reverse=True)

    return {
        "width": src_w,
        "height": src_h,
        "frames_sampled": n,
        "grid_size": grid,
        "static_pct": round(float(static.mean()) * 100, 1),
        "avoid_regions": regions,
        "grid": cells,
    }


if __name__ == "__main__":
    video = sys.argv[1]
    fps = float(sys.argv[2]) if len(sys.argv) > 2 else TARGET_FPS
    grid = int(sys.argv[3]) if len(sys.argv) > 3 else GRID
    print(json.dumps(analyze(video, fps, grid)))
