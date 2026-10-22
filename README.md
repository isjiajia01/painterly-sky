# painterly-sky

A painted, procedural meadow background in WebGL2 — the "Touch grass" hero from [Ardia](https://github.com/mantrakp04/ardia), packaged as a standalone, dependency-free module.

    bun build src/index.ts --outfile dist/painterly-sky.js --target browser --format esm
    python3 -m http.server   # open http://localhost:8000

```html
<section data-meadow>
  <canvas data-meadow-canvas></canvas>
  <h1 class="hero-title"><span class="line"><span>Touch</span></span> <span class="line"><span>grass.</span></span></h1>
  <p class="lede">…</p>
</section>
<script type="module">
  import { createPainterlySky } from './dist/painterly-sky.js';
  createPainterlySky({ hero: document.querySelector('[data-meadow]') });
</script>
```

The scene keeps text readable by sampling the rendered pixels under `.hero-title .line > span`, `.lede`, `.cta-row .source`, `.note` and setting `data-tone="light|dark"` and `--halo` on them (see `index.html` for the CSS).

- `src/meadow/` — Ardia's meadow source (TypeScript), vendored unchanged except `boot.ts`, replaced by `src/index.ts`.
- `dist/painterly-sky.js` — built bundle (117 KB).
- `lite/painterly-sky-lite.js` — my earlier ~500-line from-scratch approximation, kept for reference.

## Attribution & license
The scene is Ardia's work: © 2026 Mantra Patel, [Apache-2.0](LICENSE). See `NOTICE` for what was changed.
