// The overlay's colour scale (new in 2.1, ROADMAP B2). Colours are mixed from the stylesheet's own
// tokens (--accent, --critical, the canvas ground) in OKLab, where equal steps of the number are
// equal steps of perceived lightness and chroma, so the ramp reads evenly in both themes. A
// relative metric runs from a quiet tint to the full accent. Utilisation is a fixed 0–1 scale:
// the same ramp up to `KNEE`, then a turn of hue to the critical colour by 1, so a station near
// saturation looks different in kind, not just a little darker. The ring's width grows with the
// value too, so the encoding does not rest on colour alone.
import { canvasToken, colorString, type CanvasTheme, type RGBA } from "../layers/colors";

/** Where the utilisation scale starts to turn critical. */
export const KNEE = 0.85;
/** The ring's stroke, display points, at the bottom and the top of the scale. */
export const RING_WIDTH = { min: 2, max: 4.5 } as const;

type Lab = [number, number, number];

const toLinear = (c: number) => {
  const x = c / 255;
  return x <= 0.04045 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
};
const toGamma = (x: number) => 255 * (x <= 0.0031308 ? 12.92 * x : 1.055 * Math.pow(x, 1 / 2.4) - 0.055);

export function oklab(c: RGBA): Lab {
  const r = toLinear(c.r);
  const g = toLinear(c.g);
  const b = toLinear(c.b);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s, 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s, 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s];
}

export function fromOklab([L, a, b]: Lab): RGBA {
  const l = Math.pow(L + 0.3963377774 * a + 0.2158037573 * b, 3);
  const m = Math.pow(L - 0.1055613458 * a - 0.0638541728 * b, 3);
  const s = Math.pow(L - 0.0894841775 * a - 1.291485548 * b, 3);
  return {
    r: toGamma(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    g: toGamma(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    b: toGamma(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s),
    a: 1,
  };
}

const mix = (x: Lab, y: Lab, t: number): Lab => [x[0] + (y[0] - x[0]) * t, x[1] + (y[1] - x[1]) * t, x[2] + (y[2] - x[2]) * t];

export interface ResultScale {
  /** The colour at `t` (0…1) of a relative scale, or of the fixed utilisation scale. */
  color: (t: number, fixed: boolean) => string;
  /** The bottleneck marker's colour (the critical ink). */
  marker: string;
}

const cache = new Map<string, ResultScale>();

export function resultScale(theme: CanvasTheme, contrast = false): ResultScale {
  const key = `${theme}/${contrast}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const ground = oklab(canvasToken("--canvas-bg", theme, contrast));
  const accent = oklab(canvasToken("--accent", theme, contrast));
  const critical = oklab(canvasToken("--critical", theme, contrast));
  // The quiet end: a fifth of the way from the ground to the accent, still visible as a ring.
  const low = mix(ground, accent, 0.22);
  const color = (t: number, fixed: boolean) => {
    const x = Math.min(1, Math.max(0, Number.isFinite(t) ? t : 0));
    if (!fixed) return colorString(fromOklab(mix(low, accent, x)));
    if (x <= KNEE) return colorString(fromOklab(mix(low, accent, x / KNEE)));
    return colorString(fromOklab(mix(accent, critical, (x - KNEE) / (1 - KNEE))));
  };
  const scale: ResultScale = { color, marker: colorString(canvasToken("--crit-text", theme, contrast)) };
  cache.set(key, scale);
  return scale;
}

export const ringWidth = (intensity: number) => RING_WIDTH.min + (RING_WIDTH.max - RING_WIDTH.min) * Math.min(1, Math.max(0, intensity));
