// Static checks for an authored composition. hyperframes' linter validates the runtime contract
// (timeline registry, determinism); these catch the CSS and API mistakes that still render — an
// element silently falls to the canvas origin, or an animation runs with a default easing — and
// so produce a finished video that looks wrong rather than an error.

// A bare number is only valid CSS for a length when it is zero, so anything else lost its unit.
const LENGTH_PROPERTIES = [
  "left",
  "top",
  "right",
  "bottom",
  "width",
  "height",
  "font-size",
  "letter-spacing",
  "border-radius",
];
// The lookbehind keeps `line-height: 1.2` (a valid unitless ratio) from matching `height`.
const UNITLESS_LENGTH_RE = new RegExp(
  `(?<![\\w-])(${LENGTH_PROPERTIES.join("|")})\\s*:\\s*(-?[1-9][0-9]*(?:\\.[0-9]+)?)\\s*(?=[;}"'])`,
  "g",
);

// `daturation="5"` renders fine and does nothing. Any attribute that starts to spell "data" but
// misses the hyphen is a typo, never a real attribute.
const DATA_ATTR_TYPO_RE = /\s(dat(?!a-)[a-z]*)\s*=/gi;

const ANIME_EASINGS = new Set([
  "linear",
  "easeInQuad",
  "easeOutQuad",
  "easeInOutQuad",
  "easeOutInQuad",
  "easeInCubic",
  "easeOutCubic",
  "easeInOutCubic",
  "easeOutInCubic",
  "easeInQuart",
  "easeOutQuart",
  "easeInOutQuart",
  "easeOutInQuart",
  "easeInQuint",
  "easeOutQuint",
  "easeInOutQuint",
  "easeOutInQuint",
  "easeInSine",
  "easeOutSine",
  "easeInOutSine",
  "easeOutInSine",
  "easeInExpo",
  "easeOutExpo",
  "easeInOutExpo",
  "easeOutInExpo",
  "easeInCirc",
  "easeOutCirc",
  "easeInOutCirc",
  "easeOutInCirc",
  "easeInBack",
  "easeOutBack",
  "easeInOutBack",
  "easeOutInBack",
  "easeInBounce",
  "easeOutBounce",
  "easeInOutBounce",
  "easeOutInBounce",
  "easeInElastic",
  "easeOutElastic",
  "easeInOutElastic",
  "easeOutInElastic",
]);
const ANIME_EASING_PREFIXES = ["cubicBezier", "spring", "steps"];
const EASING_RE = /easing\s*:\s*['"]([^'"]+)['"]/g;

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

export function checkComposition(html: string): string[] {
  const findings: string[] = [];

  const unitless = unique(
    [...html.matchAll(UNITLESS_LENGTH_RE)].map((match) => `${match[1]}:${match[2]}`),
  );
  if (unitless.length > 0) {
    findings.push(
      `✗ css_length_missing_unit: ${unitless.join(", ")} — a non-zero length needs a unit. Without one the declaration is dropped and the element falls back to the canvas origin. Fix: write \`left:190px\`.`,
    );
  }

  const typos = unique([...html.matchAll(DATA_ATTR_TYPO_RE)].map((match) => match[1] as string));
  if (typos.length > 0) {
    findings.push(
      `✗ misspelled_data_attribute: ${typos.join(", ")} — not a data-* attribute, so it is ignored. Fix: \`data-duration\`, \`data-start\`, \`data-track-index\`.`,
    );
  }

  if (html.includes("anime.")) {
    const bad = unique(
      [...html.matchAll(EASING_RE)]
        .map((match) => match[1] as string)
        .filter(
          (easing) =>
            !ANIME_EASINGS.has(easing) &&
            !ANIME_EASING_PREFIXES.some((prefix) => easing.startsWith(prefix)),
        ),
    );
    if (bad.length > 0) {
      findings.push(
        `✗ unknown_anime_easing: ${bad.join(", ")} — anime.js falls back to its default easing, so the motion you asked for silently does not happen. Fix: e.g. \`easeOutExpo\`.`,
      );
    }
  }

  return findings;
}
