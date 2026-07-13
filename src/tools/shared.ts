import { z } from "zod";
import { compositionInputError } from "../lib/composition-checks.js";

export const RESOLUTION = z.enum(["1080p", "4k", "uhd", "landscape", "portrait", "square"]);

export function encode(html: string): string {
  return Buffer.from(html, "utf-8").toString("base64");
}

// Optional publish metadata accepted by every render tool. When present, the render also
// writes a JSON sidecar next to the video (same base name) and returns its url — so a single
// call produces the video + its publish package (title/description/tags) for upload.
export const metadataArg = z
  .object({
    title: z
      .string()
      .min(1)
      .describe(
        "A catchy title a real creator would post, written for viewers. NOT a restatement of the brief or a robotic label, and never address the requester by name.",
      ),
    description: z
      .string()
      .optional()
      .describe(
        "1-3 sentences written FOR the audience — natural and inviting, like a creator captioning their own upload. Avoid 'this video shows…' boilerplate and any echo of the prompt. May end with chapter timestamps.",
      ),
    tags: z.array(z.string()).optional().describe("YouTube tags / keywords."),
    category: z.string().optional().describe("Optional YouTube category, e.g. 'Gaming'."),
  })
  .optional()
  .describe("Publish metadata; if set, a <video>.json sidecar is written to the bucket too.");

// Validate at the boundary: a mangled base64 document still renders, as a still frame.
export const compositionHtml = (description: string) =>
  z
    .string()
    .min(1)
    .superRefine((value, ctx) => {
      const error = compositionInputError(value);
      if (error) ctx.addIssue({ code: z.ZodIssueCode.custom, message: error });
    })
    .describe(description);
