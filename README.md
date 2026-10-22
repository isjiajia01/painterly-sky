# painterly-sky
Procedural, painted-looking gradient backgrounds in ~200 lines of WebGL2. Zero dependencies, no images.

    python3 -m http.server   # open http://localhost:8000
    import {createPainterlySky, SUNRISE} from './painterly-sky.js'
    createPainterlySky(canvas, {...SUNRISE, sun:[.5,.4], top:[.2,.3,.6]})

How it works: scene (banded fbm-wobbled gradient) → flow (structure tensor) → anisotropic Kuwahara → jittered brush dabs lit as a height field (normal + specular + canvas grain + dither). Static layers render once; only the last pass re-runs on pointer move.
Inspired by the technique observed on ardia.dev; all code here is original. MIT.

## Features
- Banded, fbm-wobbled sky gradient + stepped sun glow, hills, grass
- Anisotropic Kuwahara paint filter driven by a structure-tensor flow field
- Brush-dab relief lighting (normal + specular), canvas grain, dither
- 2.85s cosine-eased sunrise intro; pointer smear; fireflies; click for petal burst
- Auto text contrast: `toneTargets:[el,...]` sets `data-tone="light|dark"` from the pixels under each element
- Options: `sunrise:false`, `particles:false`; honours `prefers-reduced-motion`

Also: raymarched heightfield terrain with baked horizon/AO, 30k wind-blown grass blades bent by the pointer, ground mist, lit clouds, 24h day/night cycle (`timeOfDay`, `cycle`), moon/stars, smear texture, auto text tone + halo.
