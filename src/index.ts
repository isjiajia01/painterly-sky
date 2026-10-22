// Thin entry around Ardia's meadow scene (Apache-2.0, see NOTICE).
import { startSunrise } from "./meadow/clock";
import { createMeadow, type Meadow } from "./meadow/scene";

export interface PainterlyOptions {
  /** Element that contains the canvas and the text blocks to keep legible. */
  hero: HTMLElement;
  /** Defaults to hero.querySelector('[data-meadow-canvas]'). */
  canvas?: HTMLCanvasElement | null;
  hint?: HTMLElement | null;
}

export function createPainterlySky(opts: PainterlyOptions): Meadow | null {
  const { hero } = opts;
  const canvas = opts.canvas ?? hero.querySelector<HTMLCanvasElement>("[data-meadow-canvas]");
  if (!canvas || !("WebGL2RenderingContext" in window)) return null;
  return createMeadow({
    canvas,
    hero,
    hint: opts.hint ?? hero.querySelector<HTMLElement>("[data-sun-hint]"),
    reducedMotion: matchMedia("(prefers-reduced-motion: reduce)").matches,
    onFirstFrame() {
      requestAnimationFrame(() => requestAnimationFrame(() => { hero.dataset.meadow = "ready"; startSunrise(hero); }));
    },
  });
}
