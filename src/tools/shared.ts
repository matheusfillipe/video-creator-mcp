import { z } from "zod";

// Optional publish metadata accepted by every render tool. When present, the render also
// writes a JSON sidecar next to the video (same base name) and returns its url — so a single
// call produces the video + its publish package (title/description/tags) for upload.
export const metadataArg = z
  .object({
    title: z.string().min(1).describe("Video title."),
    description: z.string().optional().describe("Description; may include chapter timestamps."),
    tags: z.array(z.string()).optional().describe("YouTube tags / keywords."),
    category: z.string().optional().describe("Optional YouTube category, e.g. 'Gaming'."),
  })
  .optional()
  .describe("Publish metadata; if set, a <video>.json sidecar is written to the bucket too.");
