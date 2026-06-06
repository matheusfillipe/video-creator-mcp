export interface ProbeInfo {
  duration: number;
  width: number;
  height: number;
  codec: string;
  fps: number;
  hasAudio: boolean;
  size: number;
}

export interface MediaMeta {
  media_id: string;
  filename: string;
  path: string;
  url: string;
  start: number | null;
  end: number | null;
  duration: number;
  width: number;
  height: number;
  codec: string;
  fps: number;
  hasAudio: boolean;
  size: number;
}

export interface MediaSummary {
  media_id: string;
  url: string;
  filename: string;
  duration: number;
  width: number;
  height: number;
  size: number;
  start: number | null;
  end: number | null;
}

export type Resolution = "1080p" | "4k" | "uhd" | "landscape" | "portrait" | "square";
