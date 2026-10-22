// src/meadow/clock.ts
var SUNRISE_HOLD_MS = 300;
var DAY_MOVE_MS = 2850;
var startedAt = null;
function startSunrise(hero) {
  if (startedAt !== null)
    return;
  startedAt = performance.now();
  hero.dataset.sunrise = "run";
}
function sunriseElapsed(now = performance.now()) {
  return startedAt === null ? 0 : now - startedAt;
}
function easeInOutSine(t) {
  const x = Math.min(1, Math.max(0, t));
  return (1 - Math.cos(Math.PI * x)) / 2;
}
function sunriseProgress(elapsed) {
  return easeInOutSine((elapsed - SUNRISE_HOLD_MS) / DAY_MOVE_MS);
}

// src/meadow/brush.ts
var BRUSH_CHANNELS = 4;
var PRESS_STIFFNESS = 520;
var PRESS_DAMPING = 46;
var HOLD_SECONDS = 0.85;
var HOLD_RATE = 1;
var SPRING_RATE = 7;
var COUPLING = 4;
var MAX_BEND = 1.55;
var GLOW_SECONDS = 3.4;

class GrassBrush {
  columns;
  rows;
  field;
  velocity;
  hold;
  previous = { u: 0, v: 0, active: false };
  idleFrames = 0;
  glowing = false;
  constructor(columns, rows) {
    this.columns = columns;
    this.rows = rows;
    this.field = new Float32Array(columns * rows * BRUSH_CHANNELS);
    this.velocity = new Float32Array(columns * rows * 2);
    this.hold = new Float32Array(columns * rows);
  }
  get settled() {
    return this.idleFrames > 8;
  }
  get resting() {
    return this.settled && !this.glowing;
  }
  step(dt, touch, widthPx, heightPx, radiusPx) {
    const { columns, rows, field, velocity, hold } = this;
    const previous = this.previous;
    let dragU = 0;
    let dragV = 0;
    if (touch.active && previous.active && dt > 0) {
      dragU = (touch.u - previous.u) * widthPx / dt;
      dragV = (touch.v - previous.v) * heightPx / dt;
    }
    previous.u = touch.u;
    previous.v = touch.v;
    previous.active = touch.active;
    const dragSpeed = Math.min(Math.hypot(dragU, dragV), 3000);
    const rustle = dragSpeed > 1 ? Math.min(dragSpeed / 700, 2) / dragSpeed : 0;
    const reach = radiusPx * (1 + Math.min(dragSpeed / 2400, 0.5));
    const glowFade = Math.exp(-dt / GLOW_SECONDS);
    let change = 0;
    let glowing = false;
    for (let row = 0;row < rows; row++) {
      const cellV = (row + 0.5) / rows;
      for (let col = 0;col < columns; col++) {
        const cell = row * columns + col;
        const index = cell * BRUSH_CHANNELS;
        const motion = cell * 2;
        let targetX = 0;
        let targetZ = 0;
        let pressed = 0;
        if (touch.active) {
          const dx = ((col + 0.5) / columns - touch.u) * widthPx;
          const dy = (cellV - touch.v) * heightPx;
          const distance = Math.hypot(dx, dy);
          if (distance < reach) {
            const t = 1 - distance / reach;
            pressed = t * t * (3 - 2 * t);
            const lift = Math.min(1, distance / (reach * 0.12));
            const strength = 1.45 * Math.min(1, pressed * 1.7) * lift;
            targetX = dx / (distance || 1) * strength;
            targetZ = dy / (distance || 1) * strength;
          }
        }
        const pressing = pressed > 0.02;
        hold[cell] = pressing ? Math.max(hold[cell], HOLD_SECONDS * Math.min(1, pressed * 2)) : Math.max(0, hold[cell] - dt);
        const holding = Math.min(1, hold[cell] / 0.12);
        const rate = SPRING_RATE + (HOLD_RATE - SPRING_RATE) * holding;
        const recoveryStiffness = rate * rate;
        const recoveryDamping = 2 * rate;
        const stiffness = pressing ? PRESS_STIFFNESS * pressed + recoveryStiffness : recoveryStiffness;
        const damping = pressing ? PRESS_DAMPING * Math.sqrt(pressed) + recoveryDamping : recoveryDamping;
        const left = col > 0 ? index - BRUSH_CHANNELS : index;
        const right = col < columns - 1 ? index + BRUSH_CHANNELS : index;
        const down = row > 0 ? index - columns * BRUSH_CHANNELS : index;
        const up = row < rows - 1 ? index + columns * BRUSH_CHANNELS : index;
        for (let axis = 0;axis < 2; axis++) {
          const current = field[index + axis];
          const neighbors = (field[left + axis] + field[right + axis] + field[down + axis] + field[up + axis]) * 0.25;
          const target = axis === 0 ? targetX : targetZ;
          const kick = (axis === 0 ? dragU : dragV) * rustle * pressed;
          const accel = stiffness * (target - current) - damping * velocity[motion + axis] + COUPLING * (neighbors - current);
          velocity[motion + axis] += accel * dt + kick * 14 * dt;
          const next = Math.max(-MAX_BEND, Math.min(MAX_BEND, current + velocity[motion + axis] * dt));
          field[index + axis] = next;
          change += Math.abs(next - current) + Math.abs(velocity[motion + axis]) * 0.01;
        }
        const glow = Math.max(field[index + 2] * glowFade, pressed * pressed);
        const nextGlow = glow < 0.004 ? 0 : glow;
        glowing ||= nextGlow > 0;
        field[index + 2] = nextGlow;
      }
    }
    this.idleFrames = change < 0.004 ? this.idleFrames + 1 : 0;
    this.glowing = glowing;
  }
}

// src/meadow/legibility.ts
var INK_LUMINANCE = 0.0068;
var NIGHT_INK_LUMINANCE = 0.8;
var TONE_HYSTERESIS = 1.12;
var SAMPLE_PAD = 4;
var PROBE_WIDTH = 96;
var READABLE_FLOOR = 0.3;
var READABLE_CEILING = 0.1;
var LARGE_FLOOR = 0.14;
var LARGE_CEILING = 0.2;
var PAPER_LUMINANCE = 0.84;
var HALO_COVERAGE = 0.26;
var HALO_STEP = 0.05;
var EASE_SECONDS = 0.5;
var TONE_DWELL_MS = 2500;
var MAX_HALO = 1;
var SRGB_TO_LINEAR = Float32Array.from({ length: 256 }, (_, i) => {
  const c = i / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
});
var visible = (element) => !!element?.offsetParent && element.offsetWidth > 0;

class TextTones {
  hero;
  bar;
  onHeaderTone;
  groups;
  header;
  all;
  decided = false;
  samples = [];
  constructor(hero, bar, onHeaderTone) {
    this.hero = hero;
    this.bar = bar;
    this.onHeaderTone = onHeaderTone;
    const one = (selector) => hero.querySelector(selector);
    const all = (selector) => [...hero.querySelectorAll(selector)];
    const group = (name, toned, read, large = false) => ({
      name,
      large,
      toned: toned.filter((element) => !!element),
      read: () => read().filter(visible),
      boxes: [],
      tone: "light",
      darkest: 1,
      brightest: 0,
      halo: 0,
      shownHalo: "",
      changedAt: -Infinity
    });
    const sendPanel = one("[data-send-panel]")?.parentElement ?? null;
    this.groups = [
      group("title", [one(".hero-title")], () => all(".hero-title .line > span"), true),
      group("lede", [one(".lede"), one(".welcome")], () => [one(".lede"), one(".welcome")]),
      group("cta", [one(".cta-row")], () => [one(".cta-row .source")]),
      group("send", [sendPanel], () => [one(".send-more")]),
      group("note", [one(".note")], () => [one(".note")])
    ];
    this.header = group("header", bar ? [bar] : [], () => bar ? [...bar.querySelectorAll(".mark, .links, .menu-btn")] : []);
    this.all = [...this.groups, this.header];
  }
  measure(heroDocTop) {
    const hero = this.hero;
    const heroRect = hero.getBoundingClientRect();
    const range = document.createRange();
    const inkExtent = (element, fallback) => {
      range.selectNodeContents(element);
      let left = Infinity;
      let right = -Infinity;
      for (const rect of range.getClientRects()) {
        if (rect.width < 1)
          continue;
        left = Math.min(left, rect.left - heroRect.left);
        right = Math.max(right, rect.right - heroRect.left);
      }
      return Number.isFinite(left) ? { left, top: fallback.top, right, bottom: fallback.bottom } : fallback;
    };
    const offsetBox = (element) => {
      let left = 0;
      let top = 0;
      let node = element;
      while (node && node !== hero) {
        left += node.offsetLeft;
        top += node.offsetTop;
        node = node.offsetParent;
      }
      return { left, top, right: left + element.offsetWidth, bottom: top + element.offsetHeight };
    };
    for (const group of this.groups)
      group.boxes = group.read().map((element) => inkExtent(element, offsetBox(element)));
    const barRect = this.bar?.getBoundingClientRect();
    this.header.boxes = barRect ? this.header.read().map((element) => {
      const rect = element.getBoundingClientRect();
      const top = rect.top - barRect.top - heroDocTop;
      return { left: rect.left - barRect.left, top, right: rect.right - barRect.left, bottom: top + rect.height };
    }) : [];
  }
  fallback(tone) {
    if (this.decided)
      return;
    for (const group of this.all)
      this.apply(group, tone);
  }
  decide(pixels, width, height, cssWidth, cssHeight) {
    this.decided = true;
    for (const group of this.all) {
      if (!this.measureGroup(group, pixels, width, height, cssWidth, cssHeight))
        continue;
      const darkText = (group.darkest + 0.05) / (INK_LUMINANCE + 0.05);
      const lightText = (NIGHT_INK_LUMINANCE + 0.05) / (group.brightest + 0.05);
      const preferred = darkText >= lightText ? "light" : "dark";
      const margin = preferred === "light" ? darkText / lightText : lightText / darkText;
      const settled = performance.now() - group.changedAt > TONE_DWELL_MS;
      if (preferred !== group.tone && margin > TONE_HYSTERESIS && settled)
        this.apply(group, preferred);
    }
  }
  ease(dt) {
    const follow = 1 - Math.exp(-dt / EASE_SECONDS);
    for (const group of this.all) {
      const target = this.decided ? this.haloFor(group) : 0;
      group.halo += (target - group.halo) * follow;
      const shown = (Math.round(group.halo / HALO_STEP) * HALO_STEP).toFixed(2);
      if (shown === group.shownHalo)
        continue;
      group.shownHalo = shown;
      for (const element of group.toned)
        element.style.setProperty("--halo", shown);
    }
  }
  haloFor(group) {
    const needed = group.tone === "light" ? ((group.large ? LARGE_FLOOR : READABLE_FLOOR) - group.darkest) / (PAPER_LUMINANCE - group.darkest) : (group.brightest - (group.large ? LARGE_CEILING : READABLE_CEILING)) / Math.max(group.brightest - INK_LUMINANCE, 0.001);
    return Math.min(MAX_HALO, Math.max(0, needed / HALO_COVERAGE));
  }
  shadeAt(x, y, reach) {
    let nearest = Infinity;
    for (const group of this.all) {
      for (const box of group.boxes) {
        const dx = Math.max(box.left - x, 0, x - box.right);
        const dy = Math.max(box.top - y, 0, y - box.bottom);
        nearest = Math.min(nearest, Math.hypot(dx, dy));
      }
    }
    return Math.min(1, 0.15 + 0.85 * nearest / reach);
  }
  measureGroup(group, pixels, width, height, cssWidth, cssHeight) {
    const samples = this.samples;
    samples.length = 0;
    for (const box of group.boxes) {
      const x0 = Math.max(0, Math.floor((box.left - SAMPLE_PAD) / cssWidth * width));
      const x1 = Math.min(width - 1, Math.ceil((box.right + SAMPLE_PAD) / cssWidth * width));
      const y0 = Math.max(0, Math.floor((1 - (box.bottom + SAMPLE_PAD) / cssHeight) * height));
      const y1 = Math.min(height - 1, Math.ceil((1 - (box.top - SAMPLE_PAD) / cssHeight) * height));
      for (let y = y0;y <= y1; y++) {
        for (let x = x0;x <= x1; x++) {
          const i = (y * width + x) * 4;
          samples.push(0.2126 * SRGB_TO_LINEAR[pixels[i]] + 0.7152 * SRGB_TO_LINEAR[pixels[i + 1]] + 0.0722 * SRGB_TO_LINEAR[pixels[i + 2]]);
        }
      }
    }
    if (samples.length < 2)
      return false;
    samples.sort((a, b) => a - b);
    group.darkest = samples[Math.floor(samples.length * 0.06)];
    group.brightest = samples[Math.min(samples.length - 1, Math.floor(samples.length * 0.94))];
    return true;
  }
  apply(group, tone) {
    if (group === this.header) {
      if (group.tone !== tone) {
        this.onHeaderTone(tone);
        if (this.decided)
          group.changedAt = performance.now();
      }
      group.tone = tone;
      return;
    }
    if (group.tone === tone && group.toned.every((element) => element.dataset.tone === tone))
      return;
    if (group.tone !== tone && this.decided)
      group.changedAt = performance.now();
    group.tone = tone;
    for (const element of group.toned)
      element.dataset.tone = tone;
  }
  reset() {
    for (const group of this.all) {
      for (const element of group.toned) {
        delete element.dataset.tone;
        element.style.removeProperty("--halo");
      }
    }
  }
}

class ColorProbe {
  gl;
  width = PROBE_WIDTH;
  height;
  pixels;
  halfTexture;
  halfFramebuffer;
  texture;
  framebuffer;
  buffer;
  halfWidth;
  halfHeight;
  sync = null;
  constructor(gl, sourceWidth, sourceHeight) {
    this.gl = gl;
    this.height = Math.max(8, Math.round(PROBE_WIDTH * sourceHeight / sourceWidth));
    this.halfWidth = Math.max(this.width, Math.round(sourceWidth / 4));
    this.halfHeight = Math.max(this.height, Math.round(sourceHeight / 4));
    this.pixels = new Uint8Array(this.width * this.height * 4);
    [this.halfTexture, this.halfFramebuffer] = this.target(this.halfWidth, this.halfHeight);
    [this.texture, this.framebuffer] = this.target(this.width, this.height);
    this.buffer = gl.createBuffer();
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, this.buffer);
    gl.bufferData(gl.PIXEL_PACK_BUFFER, this.pixels.byteLength, gl.STREAM_READ);
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
  }
  target(width, height) {
    const gl = this.gl;
    const texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, width, height);
    const framebuffer = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return [texture, framebuffer];
  }
  get pending() {
    return this.sync !== null;
  }
  capture(source, sourceWidth, sourceHeight) {
    const gl = this.gl;
    if (this.sync)
      return;
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, source);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, this.halfFramebuffer);
    gl.blitFramebuffer(0, 0, sourceWidth, sourceHeight, 0, 0, this.halfWidth, this.halfHeight, gl.COLOR_BUFFER_BIT, gl.LINEAR);
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, this.halfFramebuffer);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, this.framebuffer);
    gl.blitFramebuffer(0, 0, this.halfWidth, this.halfHeight, 0, 0, this.width, this.height, gl.COLOR_BUFFER_BIT, gl.LINEAR);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.framebuffer);
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, this.buffer);
    gl.readPixels(0, 0, this.width, this.height, gl.RGBA, gl.UNSIGNED_BYTE, 0);
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this.sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
    gl.flush();
  }
  colorAt(x, y, radius, cssWidth, cssHeight, warmest = false) {
    const cx = x / cssWidth * this.width - 0.5;
    const cy = (1 - y / cssHeight) * this.height - 0.5;
    const reach = Math.max(1, Math.round(radius / cssWidth * this.width));
    let best = null;
    for (let py = Math.round(cy) - reach;py <= Math.round(cy) + reach; py++) {
      for (let px = Math.round(cx) - reach;px <= Math.round(cx) + reach; px++) {
        if (px < 0 || py < 0 || px >= this.width || py >= this.height || Math.hypot(px - cx, py - cy) > reach + 0.5)
          continue;
        const i = (py * this.width + px) * 4;
        const pixel = [this.pixels[i], this.pixels[i + 1], this.pixels[i + 2]];
        const score = warmest ? pixel[0] - pixel[2] : pixel[0] + pixel[1];
        if (!best || score > (warmest ? best[0] - best[2] : best[0] + best[1]))
          best = pixel;
      }
    }
    return best;
  }
  poll() {
    const gl = this.gl;
    if (!this.sync || gl.getSyncParameter(this.sync, gl.SYNC_STATUS) !== gl.SIGNALED)
      return false;
    gl.deleteSync(this.sync);
    this.sync = null;
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, this.buffer);
    gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, this.pixels);
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
    return true;
  }
  dispose() {
    const gl = this.gl;
    if (this.sync)
      gl.deleteSync(this.sync);
    this.sync = null;
    gl.deleteTexture(this.halfTexture);
    gl.deleteTexture(this.texture);
    gl.deleteFramebuffer(this.halfFramebuffer);
    gl.deleteFramebuffer(this.framebuffer);
    gl.deleteBuffer(this.buffer);
  }
}

// src/meadow/layout.ts
var TERRAIN_NEAR = 1;
var TERRAIN_FAR = 16000;
var TERRAIN_WIDTH = 6;
var TERRAIN_SLOPE = 1.05;
var HEIGHT_MIN = -60;
var HEIGHT_RANGE = 2300;
var GRASS_SEGMENTS = 6;
var GRASS_NEAR = 1.5;
var GRASS_FAR = 46;
var GRASS_ROOT_WIDTH = 0.3;
var GRASS_DEPTH_CURVE = 0.62;
var CAMERA_HEIGHT = 0.72;
var SUN_RADIUS = 2.5 * Math.PI / 180;
var SHADOW_AZIMUTHS = [34, 10, -18, -46].map((deg) => deg * Math.PI / 180);
var degrees = (value) => value * Math.PI / 180;
var smooth = (edge0, edge1, x) => {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
};
var LIGHT_PEAK = degrees(26);
var LIGHT_MOON_PEAK = degrees(14);
var MOONLIGHT_ELEVATION = degrees(34);
var SUN_SET_DEPTH = degrees(6);
var MOON_SET_DEPTH = degrees(6);
var STACKED_SUN_SCALE = 0.8;
var STACKED_HILL_SCALE = 0.7;
var STACKED_FOV = degrees(72);
var STACKED_RISE = 1.9;
function framingFor(aspect, clear = 0, horizon = 0) {
  const wide = smooth(0.55, 1.45, aspect);
  if (aspect >= 0.9 || clear < 0.3 || clear > 0.85) {
    const verticalFov = degrees(62 + (40 - 62) * wide);
    const tanHalf = Math.tan(verticalFov / 2);
    const horizonNdc = -0.4 + 0.1 * wide;
    const sunPeak = degrees(27 - 1 * wide);
    const across = tanHalf * Math.max(aspect, 0.9);
    return {
      verticalFov,
      pitch: Math.atan(-horizonNdc * tanHalf),
      yaw: 0,
      sunPeak,
      sunCeiling: sunPeak,
      sunSweep: 1,
      sunRadius: SUN_RADIUS,
      hillScale: 1,
      moonRise: Math.atan(0.86 * across),
      moonSet: Math.atan(0.36 * across),
      moonPeak: LIGHT_MOON_PEAK
    };
  }
  const verticalFov = STACKED_FOV;
  const tanHalf = Math.tan(verticalFov / 2);
  const horizonNdc = 1 - 2 * Math.max(clear + 0.1, Math.min(horizon, clear + (1 - clear) * 0.5));
  const pitch = Math.atan(-horizonNdc * tanHalf);
  const sunRadius = SUN_RADIUS * STACKED_SUN_SCALE;
  const sunNdc = 1 - 2 * (clear + sunRadius / tanHalf / 2 * 1.25 + 0.006);
  const ceiling = Math.max(degrees(4), pitch + Math.atan(sunNdc * tanHalf));
  return {
    verticalFov,
    pitch,
    yaw: 0,
    sunPeak: (ceiling + SUN_SET_DEPTH) * STACKED_RISE,
    sunCeiling: ceiling,
    sunRadius,
    hillScale: STACKED_HILL_SCALE,
    sunSweep: Math.min(1, Math.max(0.3, Math.atan(0.38 * tanHalf * aspect) / degrees(10))),
    moonRise: Math.atan(0.78 * tanHalf * aspect),
    moonSet: Math.atan(0.3 * tanHalf * aspect),
    moonPeak: Math.min(LIGHT_MOON_PEAK, ceiling)
  };
}
function sunPath(p, peak, ceiling = peak, sweep = 1) {
  const arc = Math.max(0, Math.sin(Math.PI * Math.min(1, Math.max(0, p))));
  return {
    azimuth: (degrees(16.2) + (degrees(-4.6) - degrees(16.2)) * p) * sweep,
    elevation: Math.min(ceiling, -SUN_SET_DEPTH + peak * arc ** 0.8)
  };
}
function moonPath(moon, framing) {
  const m = Math.min(1, Math.max(0, moon));
  const arc = Math.sin(Math.PI * m) ** 0.6;
  return {
    azimuth: framing.moonRise + (framing.moonSet - framing.moonRise) * m,
    elevation: -MOON_SET_DEPTH + (framing.moonPeak + MOON_SET_DEPTH) * arc,
    arc
  };
}
function directionFrom(azimuth, elevation) {
  return [Math.sin(azimuth) * Math.cos(elevation), Math.sin(elevation), Math.cos(azimuth) * Math.cos(elevation)];
}

// src/meadow/daylight.ts
var DAWN_P = 0.06;
var MORNING_P = 0.3;
var GOLDEN_P = 0.84;
var NIGHT = {
  horizon: "#2c416c",
  low: "#25375f",
  mid: "#1b2a50",
  top: "#111b38",
  glow: "#3b4f86",
  glowStrength: 0,
  key: [0.34, 0.5, 0.72],
  ambient: 0.62,
  haze: 0.00014,
  mist: 0.0007,
  night: 1
};
var KEYS = [
  { p: 0, ...NIGHT },
  { p: 0.06, horizon: "#e6998b", low: "#c98190", mid: "#9a83a8", top: "#7c85ab", glow: "#ff8a5c", glowStrength: 0.42, key: [0.95, 0.42, 0.26], ambient: 0.82, haze: 0.00019, mist: 0.0012, night: 0 },
  { p: 0.14, horizon: "#f4b08a", low: "#e3a8a0", mid: "#b8a7bd", top: "#919abb", glow: "#ffa064", glowStrength: 0.45, key: [1.35, 0.78, 0.46], ambient: 0.9, haze: 0.00016, mist: 0.0007, night: 0 },
  { p: 0.3, horizon: "#f7e5c2", low: "#f3e8d4", mid: "#e1e4dc", top: "#bccfd9", glow: "#ffcf7c", glowStrength: 0.26, key: [2.05, 1.62, 1.08], ambient: 1, haze: 0.00011, mist: 0.00015, night: 0 },
  { p: 0.58, horizon: "#f4ead6", low: "#ebe8dc", mid: "#d6e0e0", top: "#aec7d7", glow: "#ffe0a0", glowStrength: 0.2, key: [2.25, 1.92, 1.42], ambient: 1.05, haze: 0.0001, mist: 0.0001, night: 0 },
  { p: 0.84, horizon: "#f8c47c", low: "#f2cd9c", mid: "#e2bfa4", top: "#b9b0b6", glow: "#ffb35a", glowStrength: 0.5, key: [2.15, 1.3, 0.58], ambient: 0.95, haze: 0.00016, mist: 0.0003, night: 0 },
  { p: 0.92, horizon: "#ef9070", low: "#c96f76", mid: "#b36871", top: "#5d5281", glow: "#ff7a4f", glowStrength: 0.55, key: [1.05, 0.44, 0.3], ambient: 0.74, haze: 0.00018, mist: 0.0008, night: 0.15 },
  { p: 1, ...NIGHT }
];
var linear = (hex) => {
  const value = parseInt(hex.slice(1), 16);
  return [value >> 16 & 255, value >> 8 & 255, value & 255].map((c) => (c / 255) ** 2.2);
};
var LINEAR = KEYS.map((key) => ({
  horizon: linear(key.horizon),
  low: linear(key.low),
  mid: linear(key.mid),
  top: linear(key.top),
  glow: linear(key.glow)
}));
var mix = (a, b, t) => a + (b - a) * t;
var mixRgb = (a, b, t) => [mix(a[0], b[0], t), mix(a[1], b[1], t), mix(a[2], b[2], t)];
var smooth2 = (t) => t * t * (3 - 2 * t);
var degrees2 = (value) => value * Math.PI / 180;
var KEY_HANDOVER = 0.16;
function daylightAt(p, framing, moon = 0.5) {
  const clamped = Math.min(1, Math.max(0, p));
  let index = 0;
  while (index < KEYS.length - 2 && KEYS[index + 1].p <= clamped)
    index++;
  const a = KEYS[index];
  const b = KEYS[index + 1];
  const t = smooth2((clamped - a.p) / Math.max(0.000001, b.p - a.p));
  const la = LINEAR[index];
  const lb = LINEAR[index + 1];
  const night = mix(a.night, b.night, t);
  const sun = sunPath(clamped, framing.sunPeak, framing.sunCeiling, framing.sunSweep);
  const sunDir = directionFrom(sun.azimuth, sun.elevation);
  const lightSun = sunPath(clamped, LIGHT_PEAK);
  const moonSky = moonPath(moon, framing);
  const moonAzimuth = degrees2(30) + (degrees2(6) - degrees2(30)) * Math.min(1, Math.max(0, moon));
  const moonElevation = degrees2(-5) + (MOONLIGHT_ELEVATION + degrees2(5)) * moonSky.arc;
  const moonDir = directionFrom(moonSky.azimuth, moonSky.elevation);
  const keyIsMoon = night > 0.5;
  const keyStrength = keyIsMoon ? smooth2(Math.min(1, (night - 0.5) / KEY_HANDOVER)) : smooth2(Math.min(1, (0.5 - night) / KEY_HANDOVER));
  const keyAzimuth = keyIsMoon ? moonAzimuth : lightSun.azimuth;
  const keyElevation = keyIsMoon ? moonElevation : lightSun.elevation;
  const glowStrength = mix(a.glowStrength, b.glowStrength, t);
  const skyTop = mixRgb(la.top, lb.top, t);
  return {
    sunDir,
    sunElevation: sun.elevation,
    keyDir: directionFrom(keyAzimuth, keyElevation),
    keyColor: mixRgb(a.key, b.key, t).map((c) => c * keyStrength),
    keyElevation,
    moonDir,
    moonElevation: moonSky.elevation,
    skyHorizon: mixRgb(la.horizon, lb.horizon, t),
    skyLow: mixRgb(la.low, lb.low, t),
    skyMid: mixRgb(la.mid, lb.mid, t),
    skyTop,
    glow: mixRgb(la.glow, lb.glow, t).map((c) => c * glowStrength),
    ambient: mix(a.ambient, b.ambient, t),
    haze: mix(a.haze, b.haze, t),
    mist: mix(a.mist, b.mist, t),
    night,
    shadowMix: shadowWeights(keyAzimuth),
    topLuminance: 0.2126 * skyTop[0] + 0.7152 * skyTop[1] + 0.0722 * skyTop[2]
  };
}
function shadowWeights(azimuth) {
  const weights = [0, 0, 0, 0];
  if (azimuth >= SHADOW_AZIMUTHS[0]) {
    weights[0] = 1;
    return weights;
  }
  for (let i = 0;i < SHADOW_AZIMUTHS.length - 1; i++) {
    const high = SHADOW_AZIMUTHS[i];
    const low = SHADOW_AZIMUTHS[i + 1];
    if (azimuth <= high && azimuth >= low) {
      const t = (high - azimuth) / (high - low);
      weights[i] = 1 - t;
      weights[i + 1] = t;
      return weights;
    }
  }
  weights[3] = 1;
  return weights;
}

// src/meadow/cycle.ts
var DUSK_P = 0.92;
var LEGS = [
  { seconds: 0, p: 0, moon: 0.82 },
  { seconds: 7, p: DAWN_P, moon: 1 },
  { seconds: 6, p: 0.14, moon: 1 },
  { seconds: 9, p: MORNING_P, moon: 1 },
  { seconds: 12, p: 0.58, moon: 1 },
  { seconds: 12, p: GOLDEN_P, moon: 1 },
  { seconds: 8, p: DUSK_P, moon: 0 },
  { seconds: 7, p: 1, moon: 0.2 },
  { seconds: 16, p: 1, moon: 0.82 }
];
var CYCLE_SECONDS = LEGS.reduce((sum, leg) => sum + leg.seconds, 0);
var KNOTS = (() => {
  let elapsed = 0;
  return LEGS.map((leg) => {
    elapsed += leg.seconds;
    return { c: elapsed / CYCLE_SECONDS, p: leg.p, moon: leg.moon };
  });
})();
var SLOPES = monotoneSlopes(KNOTS.map((knot) => knot.c), KNOTS.map((knot) => knot.p));
function monotoneSlopes(xs, ys) {
  const n = xs.length;
  const secants = xs.slice(0, -1).map((x, i) => (ys[i + 1] - ys[i]) / (xs[i + 1] - x));
  const slopes = xs.map((_, i) => {
    if (i === 0)
      return secants[0];
    if (i === n - 1)
      return secants[n - 2];
    const a = secants[i - 1];
    const b = secants[i];
    return a * b <= 0 ? 0 : 2 * a * b / (a + b);
  });
  return slopes;
}
var wrapCycle = (c) => c - Math.floor(c);
function cycleDelta(from, to) {
  const delta = wrapCycle(to - from);
  return delta > 0.5 ? delta - 1 : delta;
}
function segmentAt(c) {
  let index = 0;
  while (index < KNOTS.length - 2 && KNOTS[index + 1].c <= c)
    index++;
  return index;
}
function dayAt(cycle) {
  const c = wrapCycle(cycle);
  const i = segmentAt(c);
  const a = KNOTS[i];
  const b = KNOTS[i + 1];
  const span = b.c - a.c;
  const t = (c - a.c) / span;
  const t2 = t * t;
  const t3 = t2 * t;
  const p = (2 * t3 - 3 * t2 + 1) * a.p + (t3 - 2 * t2 + t) * span * SLOPES[i] + (-2 * t3 + 3 * t2) * b.p + (t3 - t2) * span * SLOPES[i + 1];
  const moonLeg = b.moon >= a.moon;
  const moon = moonLeg ? a.moon + (b.moon - a.moon) * t : 1;
  return { p: Math.min(1, Math.max(0, p)), moon };
}
function cycleAt(p) {
  for (let i = 0;i < KNOTS.length - 1; i++) {
    const a = KNOTS[i];
    const b = KNOTS[i + 1];
    if (b.p <= a.p || p < a.p || p > b.p)
      continue;
    let low = a.c;
    let high = b.c;
    for (let step = 0;step < 30; step++) {
      const mid = (low + high) / 2;
      if (dayAt(mid).p < p)
        low = mid;
      else
        high = mid;
    }
    return (low + high) / 2;
  }
  return 0;
}
var SUN_RANGE = [0, KNOTS[KNOTS.length - 2].c];
var MOON_RANGE = [KNOTS[KNOTS.length - 3].c, 1 + KNOTS[1].c];
var CYCLE_STOPS = [cycleAt(MORNING_P), cycleAt(GOLDEN_P), (KNOTS[KNOTS.length - 2].c + 1) / 2];
var SUNRISE_FROM = cycleAt(DAWN_P);
var SUNRISE_TO = cycleAt(MORNING_P);

// src/meadow/gl.ts
class Program {
  gl;
  handle;
  locations = new Map;
  constructor(gl, handle) {
    this.gl = gl;
    this.handle = handle;
  }
  use() {
    this.gl.useProgram(this.handle);
    return this;
  }
  at(name) {
    let location = this.locations.get(name);
    if (location === undefined) {
      location = this.gl.getUniformLocation(this.handle, name);
      this.locations.set(name, location);
    }
    return location;
  }
  float(name, value) {
    this.gl.uniform1f(this.at(name), value);
    return this;
  }
  vec2(name, x, y) {
    this.gl.uniform2f(this.at(name), x, y);
    return this;
  }
  vec3(name, value) {
    this.gl.uniform3f(this.at(name), value[0], value[1], value[2]);
    return this;
  }
  vec4(name, x, y, z, w) {
    this.gl.uniform4f(this.at(name), x, y, z, w);
    return this;
  }
  int(name, value) {
    this.gl.uniform1i(this.at(name), value);
    return this;
  }
  mat4(name, value) {
    this.gl.uniformMatrix4fv(this.at(name), false, value);
    return this;
  }
}

class ProgramBatch {
  gl;
  pending = new Map;
  parallel;
  constructor(gl, sources) {
    this.gl = gl;
    this.parallel = gl.getExtension("KHR_parallel_shader_compile");
    for (const name of Object.keys(sources)) {
      const [vertexSource, fragmentSource] = sources[name];
      const vertex = this.compile(gl.VERTEX_SHADER, vertexSource);
      const fragment = this.compile(gl.FRAGMENT_SHADER, fragmentSource);
      const program = gl.createProgram();
      gl.attachShader(program, vertex);
      gl.attachShader(program, fragment);
      gl.linkProgram(program);
      this.pending.set(name, { program, vertex, fragment });
    }
  }
  compile(type, source) {
    const shader = this.gl.createShader(type);
    this.gl.shaderSource(shader, source);
    this.gl.compileShader(shader);
    return shader;
  }
  get ready() {
    if (!this.parallel)
      return true;
    for (const { program } of this.pending.values()) {
      if (!this.gl.getProgramParameter(program, this.parallel.COMPLETION_STATUS_KHR))
        return false;
    }
    return true;
  }
  finish() {
    const { gl } = this;
    const programs = {};
    for (const [name, { program, vertex, fragment }] of this.pending) {
      if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
        const log = [gl.getShaderInfoLog(vertex), gl.getShaderInfoLog(fragment), gl.getProgramInfoLog(program)].filter(Boolean).join(`
`);
        throw new Error(`meadow ${name}: ${log}`);
      }
      gl.detachShader(program, vertex);
      gl.detachShader(program, fragment);
      gl.deleteShader(vertex);
      gl.deleteShader(fragment);
      programs[name] = new Program(gl, program);
    }
    return programs;
  }
}
function createTexture(gl, width, height, internalFormat = gl.RGBA8, format = gl.RGBA, type = gl.UNSIGNED_BYTE) {
  const texture = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texImage2D(gl.TEXTURE_2D, 0, internalFormat, width, height, 0, format, type, null);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  return texture;
}
function createFramebuffer(gl, textures) {
  const framebuffer = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
  textures.forEach((texture, i) => {
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0 + i, gl.TEXTURE_2D, texture, 0);
  });
  gl.drawBuffers(textures.map((_, i) => gl.COLOR_ATTACHMENT0 + i));
  return framebuffer;
}
function bindTexture(gl, unit, texture) {
  gl.activeTexture(gl.TEXTURE0 + unit);
  gl.bindTexture(gl.TEXTURE_2D, texture);
}

// src/meadow/matrix.ts
function perspective(verticalFov, aspect, near, far, out = new Float32Array(16)) {
  const f = 1 / Math.tan(verticalFov / 2);
  const range = 1 / (near - far);
  out.fill(0);
  out[0] = f / aspect;
  out[5] = f;
  out[10] = (far + near) * range;
  out[11] = -1;
  out[14] = 2 * far * near * range;
  return out;
}
function lookFrom(eye, yaw, pitch, out = new Float32Array(16)) {
  const forward = [Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), Math.cos(yaw) * Math.cos(pitch)];
  const right = normalize([forward[2], 0, -forward[0]]);
  const up = cross(forward, right);
  out[3] = 0;
  out[7] = 0;
  out[11] = 0;
  out[0] = right[0];
  out[4] = right[1];
  out[8] = right[2];
  out[1] = up[0];
  out[5] = up[1];
  out[9] = up[2];
  out[2] = -forward[0];
  out[6] = -forward[1];
  out[10] = -forward[2];
  out[12] = -dot(right, eye);
  out[13] = -dot(up, eye);
  out[14] = dot(forward, eye);
  out[15] = 1;
  return out;
}
function multiply(a, b, out = new Float32Array(16)) {
  for (let col = 0;col < 4; col++) {
    for (let row = 0;row < 4; row++) {
      let sum = 0;
      for (let k = 0;k < 4; k++)
        sum += a[k * 4 + row] * b[col * 4 + k];
      out[col * 4 + row] = sum;
    }
  }
  return out;
}
function invert(m, inv = new Float32Array(16)) {
  inv[0] = m[5] * m[10] * m[15] - m[5] * m[11] * m[14] - m[9] * m[6] * m[15] + m[9] * m[7] * m[14] + m[13] * m[6] * m[11] - m[13] * m[7] * m[10];
  inv[4] = -m[4] * m[10] * m[15] + m[4] * m[11] * m[14] + m[8] * m[6] * m[15] - m[8] * m[7] * m[14] - m[12] * m[6] * m[11] + m[12] * m[7] * m[10];
  inv[8] = m[4] * m[9] * m[15] - m[4] * m[11] * m[13] - m[8] * m[5] * m[15] + m[8] * m[7] * m[13] + m[12] * m[5] * m[11] - m[12] * m[7] * m[9];
  inv[12] = -m[4] * m[9] * m[14] + m[4] * m[10] * m[13] + m[8] * m[5] * m[14] - m[8] * m[6] * m[13] - m[12] * m[5] * m[10] + m[12] * m[6] * m[9];
  inv[1] = -m[1] * m[10] * m[15] + m[1] * m[11] * m[14] + m[9] * m[2] * m[15] - m[9] * m[3] * m[14] - m[13] * m[2] * m[11] + m[13] * m[3] * m[10];
  inv[5] = m[0] * m[10] * m[15] - m[0] * m[11] * m[14] - m[8] * m[2] * m[15] + m[8] * m[3] * m[14] + m[12] * m[2] * m[11] - m[12] * m[3] * m[10];
  inv[9] = -m[0] * m[9] * m[15] + m[0] * m[11] * m[13] + m[8] * m[1] * m[15] - m[8] * m[3] * m[13] - m[12] * m[1] * m[11] + m[12] * m[3] * m[9];
  inv[13] = m[0] * m[9] * m[14] - m[0] * m[10] * m[13] - m[8] * m[1] * m[14] + m[8] * m[2] * m[13] + m[12] * m[1] * m[10] - m[12] * m[2] * m[9];
  inv[2] = m[1] * m[6] * m[15] - m[1] * m[7] * m[14] - m[5] * m[2] * m[15] + m[5] * m[3] * m[14] + m[13] * m[2] * m[7] - m[13] * m[3] * m[6];
  inv[6] = -m[0] * m[6] * m[15] + m[0] * m[7] * m[14] + m[4] * m[2] * m[15] - m[4] * m[3] * m[14] - m[12] * m[2] * m[7] + m[12] * m[3] * m[6];
  inv[10] = m[0] * m[5] * m[15] - m[0] * m[7] * m[13] - m[4] * m[1] * m[15] + m[4] * m[3] * m[13] + m[12] * m[1] * m[7] - m[12] * m[3] * m[5];
  inv[14] = -m[0] * m[5] * m[14] + m[0] * m[6] * m[13] + m[4] * m[1] * m[14] - m[4] * m[2] * m[13] - m[12] * m[1] * m[6] + m[12] * m[2] * m[5];
  inv[3] = -m[1] * m[6] * m[11] + m[1] * m[7] * m[10] + m[5] * m[2] * m[11] - m[5] * m[3] * m[10] - m[9] * m[2] * m[7] + m[9] * m[3] * m[6];
  inv[7] = m[0] * m[6] * m[11] - m[0] * m[7] * m[10] - m[4] * m[2] * m[11] + m[4] * m[3] * m[10] + m[8] * m[2] * m[7] - m[8] * m[3] * m[6];
  inv[11] = -m[0] * m[5] * m[11] + m[0] * m[7] * m[9] + m[4] * m[1] * m[11] - m[4] * m[3] * m[9] - m[8] * m[1] * m[7] + m[8] * m[3] * m[5];
  inv[15] = m[0] * m[5] * m[10] - m[0] * m[6] * m[9] - m[4] * m[1] * m[10] + m[4] * m[2] * m[9] + m[8] * m[1] * m[6] - m[8] * m[2] * m[5];
  const det = m[0] * inv[0] + m[1] * inv[4] + m[2] * inv[8] + m[3] * inv[12];
  const scale = det === 0 ? 0 : 1 / det;
  for (let i = 0;i < 16; i++)
    inv[i] *= scale;
  return inv;
}
function transformPoint(m, x, y, z) {
  const w = m[3] * x + m[7] * y + m[11] * z + m[15];
  return [
    (m[0] * x + m[4] * y + m[8] * z + m[12]) / w,
    (m[1] * x + m[5] * y + m[9] * z + m[13]) / w,
    (m[2] * x + m[6] * y + m[10] * z + m[14]) / w
  ];
}
function dot(a, b) {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}
function cross(a, b) {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}
function normalize(v) {
  const length = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / length, v[1] / length, v[2] / length];
}

// src/meadow/particles.ts
var FIREFLY_COUNT = 34;
var PETAL_LIMIT = 90;
var SPARK_LIMIT = 70;
var FLOATS_PER_PARTICLE = 9;
var PETAL_COLORS = [
  [0.95, 0.66, 0.72],
  [0.98, 0.95, 0.88],
  [0.96, 0.77, 0.27],
  [0.73, 0.64, 0.86],
  [0.93, 0.49, 0.42]
];

class Particles {
  data = new Float32Array((FIREFLY_COUNT + PETAL_LIMIT + SPARK_LIMIT) * FLOATS_PER_PARTICLE);
  fireflies = [];
  petals = [];
  sparks = [];
  sparkDebt = 0;
  width = 1;
  height = 1;
  time = 0;
  get busy() {
    return this.petals.length > 0 || this.sparks.length > 0;
  }
  sparkle(dt, x, y, speed, night) {
    if (night < 0.5 || speed < 40)
      return;
    this.sparkDebt += dt * Math.min(speed / 500, 1.6) * 34 * night;
    while (this.sparkDebt >= 1) {
      this.sparkDebt -= 1;
      if (this.sparks.length >= SPARK_LIMIT)
        this.sparks.shift();
      const angle = Math.random() * Math.PI * 2;
      const reach = 18 + Math.random() * 46;
      this.sparks.push({
        x: x + Math.cos(angle) * reach,
        y: y + Math.sin(angle) * reach * 0.45,
        vx: (Math.random() - 0.5) * 24,
        vy: -12 - Math.random() * 30,
        age: 0,
        life: 0.45 + Math.random() * 0.6,
        size: 7 + Math.random() * 9
      });
    }
  }
  resize(width, height) {
    if (this.fireflies.length === 0) {
      for (let i = 0;i < FIREFLY_COUNT; i++) {
        this.fireflies.push({
          x: Math.random() * width,
          y: height * (0.45 + Math.random() * 0.45),
          vx: 0,
          vy: 0,
          phase: Math.random() * Math.PI * 2,
          speed: 0.6 + Math.random() * 0.8
        });
      }
    } else {
      for (const fly of this.fireflies) {
        fly.x *= width / this.width;
        fly.y *= height / this.height;
      }
    }
    this.width = width;
    this.height = height;
  }
  burst(x, y, night) {
    for (const fly of this.fireflies) {
      const dx = fly.x - x;
      const dy = fly.y - y;
      const distance = Math.hypot(dx, dy) || 1;
      if (distance < 260) {
        const push = (1 - distance / 260) * 520;
        fly.vx += dx / distance * push;
        fly.vy += dy / distance * push - 80;
      }
    }
    if (night > 0.6)
      return;
    const count = 16;
    for (let i = 0;i < count; i++) {
      if (this.petals.length >= PETAL_LIMIT)
        this.petals.shift();
      const angle = -Math.PI / 2 + (Math.random() - 0.5) * Math.PI * 1.5;
      const speed = 180 + Math.random() * 320;
      this.petals.push({
        x,
        y,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        age: 0,
        life: 1.8 + Math.random() * 1.4,
        angle: Math.random() * Math.PI * 2,
        spin: (Math.random() - 0.5) * 9,
        size: 9 + Math.random() * 8,
        color: PETAL_COLORS[Math.floor(Math.random() * PETAL_COLORS.length)]
      });
    }
  }
  step(dt, night, pointer) {
    this.time += dt;
    const { width, height } = this;
    for (const fly of this.fireflies) {
      const t = this.time * fly.speed + fly.phase;
      fly.vx += (Math.sin(t * 1.3) * 22 + Math.cos(t * 0.7 + fly.phase) * 14) * dt;
      fly.vy += (Math.cos(t * 1.1) * 16 - 9) * dt;
      if (pointer.active && night > 0.3) {
        const dx = fly.x - pointer.x;
        const dy = fly.y - pointer.y;
        const distance = Math.hypot(dx, dy) || 1;
        if (distance < 120) {
          fly.vx += dx / distance * 240 * dt;
          fly.vy += dy / distance * 240 * dt;
        }
      }
      const drag = Math.exp(-dt * 1.6);
      fly.vx *= drag;
      fly.vy *= drag;
      fly.x += fly.vx * dt;
      fly.y += fly.vy * dt;
      if (fly.y < height * 0.3)
        fly.y = height * 0.95;
      if (fly.y > height)
        fly.y = height * 0.45;
      if (fly.x < -20)
        fly.x = width + 20;
      if (fly.x > width + 20)
        fly.x = -20;
    }
    for (const petal of this.petals) {
      petal.age += dt;
      const drag = Math.exp(-dt * 2.2);
      petal.vx = petal.vx * drag + Math.sin(petal.age * 5 + petal.angle) * 60 * dt;
      petal.vy = petal.vy * drag + 260 * dt;
      petal.x += petal.vx * dt;
      petal.y += petal.vy * dt;
      petal.angle += petal.spin * dt;
    }
    for (const spark of this.sparks) {
      spark.age += dt;
      spark.x += spark.vx * dt;
      spark.y += spark.vy * dt;
    }
    for (let i = this.sparks.length - 1;i >= 0; i--) {
      if (this.sparks[i].age > this.sparks[i].life)
        this.sparks.splice(i, 1);
    }
    for (let i = this.petals.length - 1;i >= 0; i--) {
      if (this.petals[i].age > this.petals[i].life)
        this.petals.splice(i, 1);
    }
  }
  fill(scale, night, shade = () => 1) {
    const { data } = this;
    let cursor = 0;
    const write = (x, y, size, angle, r, g, b, a, kind) => {
      data[cursor] = x * scale;
      data[cursor + 1] = y * scale;
      data[cursor + 2] = size * scale;
      data[cursor + 3] = angle;
      data[cursor + 4] = r;
      data[cursor + 5] = g;
      data[cursor + 6] = b;
      data[cursor + 7] = a;
      data[cursor + 8] = kind;
      cursor += FLOATS_PER_PARTICLE;
    };
    if (night > 0.02) {
      for (const fly of this.fireflies) {
        const blink = Math.max(0, Math.sin(this.time * 1.7 * fly.speed + fly.phase * 3)) ** 2;
        const glow = night * (0.25 + 0.75 * blink) * shade(fly.x, fly.y);
        write(fly.x, fly.y, 22 + 10 * blink, 0, 0.9 * glow, 1 * glow, 0.45 * glow, 0, 0);
      }
    }
    for (const spark of this.sparks) {
      const t = spark.age / spark.life;
      const flash = Math.min(1, t / 0.12) * (1 - t) * (1 - t) * night * shade(spark.x, spark.y);
      write(spark.x, spark.y, spark.size * (0.7 + 0.5 * (1 - t)), 0, 0.9 * flash, 1 * flash, 0.92 * flash, 0, 0);
    }
    for (const petal of this.petals) {
      const fade = Math.min(1, (petal.life - petal.age) / 0.6) * Math.min(1, petal.age / 0.05);
      write(petal.x, petal.y, petal.size, petal.angle, petal.color[0] * fade, petal.color[1] * fade, petal.color[2] * fade, fade, 1);
    }
    return cursor / FLOATS_PER_PARTICLE;
  }
}
var PARTICLE_STRIDE = FLOATS_PER_PARTICLE * 4;

// src/meadow/shaders.ts
var linear2 = (hex) => {
  const value = parseInt(hex.slice(1), 16);
  return [value >> 16 & 255, value >> 8 & 255, value & 255].map((c) => ((c / 255) ** 2.2).toFixed(4));
};
var rgb = (hex) => `vec3(${linear2(hex).join(", ")})`;
var float = (value) => Number.isInteger(value) ? `${value}.0` : `${value}`;
var HEADER = `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;
`;
var COMMON = `
uniform vec3 uSunDir;
uniform vec3 uKeyDir;
uniform vec3 uKeyColor;
uniform float uKeyElev;
uniform vec4 uShadowMix;
uniform vec3 uMoonDir;
uniform vec3 uCamPos;
uniform vec3 uSkyHorizon;
uniform vec3 uSkyLow;
uniform vec3 uSkyMid;
uniform vec3 uSkyTop;
uniform vec3 uGlow;
uniform float uSkySpan;
uniform float uAmbient;
uniform float uHaze;
uniform float uMist;
uniform float uNight;
uniform float uTime;
uniform vec4 uVeil;
uniform vec2 uVeilFeather;
uniform vec2 uTargetSize;

const float PI = 3.14159265;
const float TZN = ${float(TERRAIN_NEAR)};
const float TZF = ${float(TERRAIN_FAR)};
const float TW0 = ${float(TERRAIN_WIDTH)};
const float TSLOPE = ${float(TERRAIN_SLOPE)};
const float HMIN = ${float(HEIGHT_MIN)};
const float HRANGE = ${float(HEIGHT_RANGE)};
const mat2 OCTAVE_TURN = mat2(0.8, -0.6, 0.6, 0.8);

float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

float valueNoise(vec2 x) {
  vec2 cell = floor(x);
  vec2 f = fract(x);
  vec2 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  float a = hash12(cell);
  float b = hash12(cell + vec2(1.0, 0.0));
  float c = hash12(cell + vec2(0.0, 1.0));
  float d = hash12(cell + vec2(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y) * 2.0 - 1.0;
}

float fbm(vec2 p, int octaves) {
  float sum = 0.0;
  float amp = 0.5;
  for (int i = 0; i < octaves; i++) {
    sum += amp * valueNoise(p);
    p = OCTAVE_TURN * p * 2.03 + vec2(4.1, 1.7);
    amp *= 0.5;
  }
  return sum;
}

vec2 terrainWorld(vec2 uv) {
  float z = TZN * pow(TZF / TZN, uv.y);
  return vec2((uv.x * 2.0 - 1.0) * (TW0 + z * TSLOPE), z);
}

vec2 terrainUv(vec2 p) {
  float z = max(p.y, TZN);
  return vec2(p.x / (TW0 + z * TSLOPE) * 0.5 + 0.5, log(z / TZN) / log(TZF / TZN));
}

float decodeHeight(vec4 texel) {
  return (texel.r * 65280.0 + texel.g * 255.0) / 65535.0 * HRANGE + HMIN;
}

vec2 decodeGradient(vec2 encoded) {
  vec2 e = encoded * 2.0 - 1.0;
  return e / max(1.0 - abs(e), 0.004);
}

float meadowHeight(vec2 p) {
  float near = 0.16 * valueNoise(p * 0.09) + 0.07 * valueNoise(p * 0.33 + 7.0);
  float far = smoothstep(30.0, 360.0, p.y);
  return near + far * (6.0 + 8.0 * valueNoise(p * 0.004 + 3.0) + 2.5 * valueNoise(p * 0.018 + 1.3));
}

vec3 skyGradient(float h) {
  vec3 col = mix(uSkyHorizon, uSkyLow, smoothstep(0.0, 0.16, h));
  col = mix(col, uSkyMid, smoothstep(0.12, 0.55, h));
  return mix(col, uSkyTop, smoothstep(0.5, 1.0, h));
}

float sunGlowAmount(vec3 dir) {
  float mu = max(dot(dir, uSunDir), 0.0);
  float nearHorizon = exp(-max(dir.y, 0.0) * 9.0);
  return pow(mu, 4.0) * (0.4 + 0.6 * nearHorizon) + pow(mu, 28.0) * 1.4 + pow(mu, 380.0) * 2.0 + nearHorizon * (0.3 + 0.7 * mu) * 0.45;
}

vec3 moonGlow(vec3 dir) {
  float moon = max(dot(dir, uMoonDir), 0.0);
  return ${rgb("#5d74a8")} * uNight * (pow(moon, 30.0) * 0.5 + pow(moon, 6.0) * 0.12);
}

vec3 skyBase(vec3 dir) {
  return skyGradient(clamp(max(dir.y, 0.0) / uSkySpan, 0.0, 1.0)) + uGlow * sunGlowAmount(dir) + moonGlow(dir);
}

float valleyMist(vec2 fragCoord) {
  vec2 uv = fragCoord / uTargetSize;
  vec2 outside = max(max(uVeil.xy - uv, uv - uVeil.zw), 0.0) / uVeilFeather;
  float drift = fbm(uv * vec2(3.0, 5.0) + 3.1, 3) * 0.9 + fbm(uv * vec2(9.0, 4.0) - 1.7, 2) * 0.35;
  float bank = 1.0 - smoothstep(0.0, 1.0, length(outside) + drift);
  return bank * (1.0 - smoothstep(0.35, 0.75, uNight));
}

vec3 mistPaint() {
  return skyGradient(0.07) + uGlow * 0.25;
}

float shadowHorizon(vec4 horizons) {
  return dot(horizons, uShadowMix) * 1.1 - 0.25;
}

float heightIntegral(float startY, float dirY, float dist, float falloff) {
  float k = dirY * falloff * dist;
  float shape = abs(k) < 1e-4 ? 1.0 - 0.5 * k : (1.0 - exp(-k)) / k;
  return exp(-startY * falloff) * dist * shape;
}

vec3 atmosphere(vec3 col, vec3 worldPos) {
  vec3 ray = worldPos - uCamPos;
  float dist = length(ray);
  vec3 dir = ray / max(dist, 1e-4);
  float haze = 1.0 - exp(-uHaze * heightIntegral(uCamPos.y, dir.y, dist, 0.00105));
  float mist = 1.0 - exp(-uMist * heightIntegral(uCamPos.y, dir.y, dist, 0.028));
  vec3 fogColor = skyBase(normalize(vec3(dir.x, max(dir.y, 0.012), dir.z)));
  fogColor += uKeyColor * pow(max(dot(dir, uSunDir), 0.0), 7.0) * 0.06 * (1.0 - uNight);
  col = mix(col, fogColor, haze);
  vec3 mistColor = mix(fogColor, vec3(1.0, 0.96, 0.92) * uAmbient * mix(0.8, 0.25, uNight), 0.35);
  return mix(col, mistColor, mist * 0.92);
}

vec3 encodeColor(vec3 c) {
  vec3 shoulder = 0.8 + 0.2 * (1.0 - exp(-(c - 0.8) / 0.2));
  c = mix(c, shoulder, step(0.8, c));
  return pow(max(c, 0.0), vec3(1.0 / 2.2));
}

vec4 encodeFlow(vec2 dir, float strokeScale, float region) {
  float angle = atan(dir.y, dir.x);
  return vec4(cos(2.0 * angle) * 0.5 + 0.5, sin(2.0 * angle) * 0.5 + 0.5, strokeScale, region);
}
`;
var FULLSCREEN_VS = `${HEADER}
out vec2 vUv;
void main() {
  vec2 corner = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  vUv = corner;
  gl_Position = vec4(corner * 2.0 - 1.0, 1.0, 1.0);
}
`;
var BAKE_HEIGHT_FS = `${HEADER}${COMMON}
uniform vec2 uBakeSize;
layout(location = 0) out vec4 outHeight;
layout(location = 1) out vec4 outMaterial;

vec3 noised(vec2 x) {
  vec2 cell = floor(x);
  vec2 f = fract(x);
  vec2 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  vec2 du = 30.0 * f * f * (f * (f - 2.0) + 1.0);
  float a = hash12(cell);
  float b = hash12(cell + vec2(1.0, 0.0));
  float c = hash12(cell + vec2(0.0, 1.0));
  float d = hash12(cell + vec2(1.0, 1.0));
  float k1 = b - a;
  float k2 = c - a;
  float k4 = a - b - c + d;
  return vec3(-1.0 + 2.0 * (a + k1 * u.x + k2 * u.y + k4 * u.x * u.y), 2.0 * du * vec2(k1 + k4 * u.y, k2 + k4 * u.x));
}

float erodedFbm(vec2 p, int octaves) {
  float sum = 0.0;
  float amp = 0.5;
  vec2 slope = vec2(0.0);
  for (int i = 0; i < octaves; i++) {
    vec3 n = noised(p);
    slope += n.yz;
    sum += amp * n.x / (1.0 + dot(slope, slope));
    amp *= 0.5;
    p = OCTAVE_TURN * p * 2.0;
  }
  return sum;
}

float ridgedFbm(vec2 p, int octaves) {
  float sum = 0.0;
  float amp = 0.5;
  float weight = 1.0;
  for (int i = 0; i < octaves; i++) {
    float n = 1.0 - abs(valueNoise(p));
    n *= n;
    sum += n * amp * weight;
    weight = clamp(n * 1.8, 0.0, 1.0);
    amp *= 0.5;
    p = OCTAVE_TURN * p * 2.07 + vec2(1.7, 9.2);
  }
  return sum;
}

float smax(float a, float b, float k) {
  float h = max(k - abs(a - b), 0.0) / k;
  return max(a, b) + h * h * k * 0.25;
}

float dome(vec2 p, vec2 center, vec2 radius, float height) {
  float r = length((p - center) / radius);
  return height * pow(0.5 + 0.5 * cos(PI * min(r, 1.0)), 1.15);
}

float terrainHeight(vec2 p, out vec3 weights) {
  float meadow = meadowHeight(p);

  float dark = -1e4;
  float crestZ = 900.0 + 190.0 * valueNoise(vec2(p.x / 950.0, 4.2));
  float dz = p.y - crestZ;
  float profile = exp(-pow(dz / (dz < 0.0 ? 360.0 : 640.0), 2.0));
  if (profile > 0.002) {
    float rise = smoothstep(-60.0, 820.0, p.x);
    float detail = erodedFbm(p / 300.0 + vec2(5.3, 1.1), 7);
    float canopy = 0.55 + 0.45 * valueNoise(p / 10.0) + 0.3 * valueNoise(p / 4.1);
    dark = (190.0 * rise + 24.0 * smoothstep(-240.0, 60.0, p.x)) * profile + 38.0 * detail * profile * mix(0.4, 1.0, rise) + 9.0 * canopy * smoothstep(0.04, 0.3, profile) - 4.0 - 40.0 * (1.0 - profile);
  }

  float sage = -1e4;
  float sageBody = max(
    dome(p, vec2(-1700.0, 3800.0), vec2(2150.0, 1500.0), 880.0),
    dome(p, vec2(-120.0, 4550.0), vec2(1950.0, 1300.0), 470.0)
  );
  if (sageBody > 0.5) {
    sage = sageBody + 105.0 * erodedFbm(p / 760.0 + vec2(2.0, 7.0), 8) * smoothstep(0.0, 140.0, sageBody) - 12.0;
  }

  float far = -1e4;
  float farMask = smoothstep(6200.0, 8800.0, p.y) * (1.0 - smoothstep(14600.0, 15900.0, p.y));
  if (farMask > 0.001) {
    far = farMask * (1380.0 * ridgedFbm(p / 3900.0 + vec2(3.3, 8.1), 9) + 190.0 * erodedFbm(p / 1300.0, 6) - 140.0);
  }

  float h = smax(meadow, dark, 30.0);
  h = smax(h, sage, 140.0);
  h = smax(h, far, 260.0);
  weights = vec3(
    smoothstep(-16.0, 16.0, dark - max(meadow, max(sage, far))),
    smoothstep(-60.0, 60.0, sage - max(meadow, max(dark, far))),
    smoothstep(-110.0, 110.0, far - max(meadow, max(dark, sage)))
  );
  return h;
}

void main() {
  vec2 uv = gl_FragCoord.xy / uBakeSize;
  vec2 p = terrainWorld(uv);
  vec2 texel = vec2(2.0 * (TW0 + p.y * TSLOPE) / uBakeSize.x, p.y * log(TZF / TZN) / uBakeSize.y);
  vec3 weights;
  vec3 ignored;
  float h = terrainHeight(p, weights);
  float hx = terrainHeight(p + vec2(texel.x, 0.0), ignored);
  float hz = terrainHeight(p + vec2(0.0, texel.y), ignored);
  vec2 gradient = vec2(hx - h, hz - h) / texel;
  float packed = floor(clamp((h - HMIN) / HRANGE, 0.0, 1.0) * 65535.0);
  float high = floor(packed / 256.0);
  outHeight = vec4(high / 255.0, (packed - high * 256.0) / 255.0, gradient / (1.0 + abs(gradient)) * 0.5 + 0.5);
  outMaterial = vec4(weights, 1.0);
}
`;
var BAKE_AUX_FS = `${HEADER}${COMMON}
uniform sampler2D uHeightTex;
uniform vec4 uAzimuths;
layout(location = 0) out vec4 outAux;
layout(location = 1) out vec4 outHorizons;

float heightAt(vec2 p) {
  vec2 uv = terrainUv(p);
  if (uv.y > 1.0 || uv.x < 0.0 || uv.x > 1.0) return HMIN;
  ivec2 size = textureSize(uHeightTex, 0);
  ivec2 texel = clamp(ivec2(uv * vec2(size)), ivec2(0), size - 1);
  return decodeHeight(texelFetch(uHeightTex, texel, 0));
}

float horizonToward(vec2 p, float lifted, float azimuth) {
  vec2 dir = vec2(sin(azimuth), cos(azimuth));
  float t = max(0.6, p.y * 0.006);
  float maxSlope = -0.3;
  for (int i = 0; i < 46; i++) {
    maxSlope = max(maxSlope, (heightAt(p + dir * t) - lifted) / t);
    t *= 1.22;
    if (t > 26000.0) break;
  }
  return (atan(maxSlope) + 0.25) / 1.1;
}

void main() {
  ivec2 coord = ivec2(gl_FragCoord.xy);
  ivec2 size = textureSize(uHeightTex, 0);
  vec2 p = terrainWorld((vec2(coord) + 0.5) / vec2(size));
  float h0 = decodeHeight(texelFetch(uHeightTex, coord, 0));
  float lifted = h0 + 0.3 + p.y * 0.0015;
  outHorizons = vec4(
    horizonToward(p, lifted, uAzimuths.x),
    horizonToward(p, lifted, uAzimuths.y),
    horizonToward(p, lifted, uAzimuths.z),
    horizonToward(p, lifted, uAzimuths.w)
  );

  float radius = 1.5 + p.y * 0.012;
  float occlusion = 0.0;
  float neighborSum = 0.0;
  for (int k = 0; k < 8; k++) {
    float angle = float(k) * PI * 0.25 + 0.3;
    vec2 dir = vec2(cos(angle), sin(angle));
    float nearH = heightAt(p + dir * radius);
    float farH = heightAt(p + dir * radius * 3.5);
    occlusion += max(0.0, atan((nearH - h0) / radius)) + max(0.0, atan((farH - h0) / (radius * 3.5)));
    neighborSum += nearH;
  }
  float ao = 1.0 - clamp(occlusion / 16.0 * 2.2, 0.0, 1.0);
  float curvature = clamp((neighborSum / 8.0 - h0) / radius * 3.0, -1.0, 1.0);
  outAux = vec4(ao, curvature * 0.5 + 0.5, 0.0, 1.0);
}
`;
var TERRAIN_VS = `${HEADER}${COMMON}
layout(location = 0) in vec2 aUv;
uniform mat4 uViewProj;
uniform sampler2D uHeightTex;
uniform float uHillScale;
out vec2 vUv;
out vec3 vWorld;

float heightBilinear(vec2 uv) {
  ivec2 size = textureSize(uHeightTex, 0);
  vec2 st = uv * vec2(size) - 0.5;
  ivec2 base = ivec2(floor(st));
  vec2 f = fract(st);
  ivec2 top = size - 1;
  float a = decodeHeight(texelFetch(uHeightTex, clamp(base, ivec2(0), top), 0));
  float b = decodeHeight(texelFetch(uHeightTex, clamp(base + ivec2(1, 0), ivec2(0), top), 0));
  float c = decodeHeight(texelFetch(uHeightTex, clamp(base + ivec2(0, 1), ivec2(0), top), 0));
  float d = decodeHeight(texelFetch(uHeightTex, clamp(base + ivec2(1, 1), ivec2(0), top), 0));
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}

void main() {
  vec2 p = terrainWorld(aUv);
  float h = p.y < 60.0 ? meadowHeight(p) : mix(meadowHeight(p), heightBilinear(aUv), uHillScale);
  vWorld = vec3(p.x, h, p.y);
  vUv = aUv;
  gl_Position = uViewProj * vec4(vWorld, 1.0);
}
`;
var TERRAIN_FS = `${HEADER}${COMMON}
uniform sampler2D uHeightTex;
uniform sampler2D uMaterialTex;
uniform sampler2D uAuxTex;
uniform sampler2D uHorizonTex;
uniform float uGrassFar;
in vec2 vUv;
in vec3 vWorld;
layout(location = 0) out vec4 outColor;
layout(location = 1) out vec4 outFlow;

void main() {
  vec2 gradient = decodeGradient(texture(uHeightTex, vUv).ba);
  vec2 footprintAxes = max(abs(dFdx(vWorld.xz)), abs(dFdy(vWorld.xz)));
  float footprint = max(footprintAxes.x, footprintAxes.y);
  float detailScale = max(footprint * 6.0, 0.8);
  vec2 q = vWorld.xz / detailScale;
  float base = fbm(q, 3);
  gradient += vec2(fbm(q + vec2(0.35, 0.0), 3) - base, fbm(q + vec2(0.0, 0.35), 3) - base) / 0.35 * 0.3;
  vec3 n = normalize(vec3(-gradient.x, 1.0, -gradient.y));

  vec4 material = texture(uMaterialTex, vUv);
  vec4 aux = texture(uAuxTex, vUv);
  float horizon = shadowHorizon(texture(uHorizonTex, vUv));
  float ao = aux.r;
  float curvature = aux.g * 2.0 - 1.0;
  float slope = 1.0 - n.y;

  float patchNoise = fbm(vWorld.xz * 0.006, 4);
  vec3 meadow = mix(${rgb("#5b7a33")}, ${rgb("#8f9a4a")}, smoothstep(-0.3, 0.4, patchNoise));
  meadow *= mix(0.5, 1.0, smoothstep(uGrassFar * 0.55, uGrassFar * 1.6, vWorld.z));
  vec3 forest = mix(${rgb("#164536")}, ${rgb("#3c7259")}, smoothstep(-0.25, 0.55, patchNoise + fbm(vWorld.xz * 0.03, 3) * 0.5));
  vec3 sage = mix(${rgb("#8ba65c")}, ${rgb("#b9c482")}, smoothstep(-0.35, 0.45, fbm(vWorld.xz * 0.0021 + 3.0, 4)));
  sage = mix(sage, ${rgb("#a39b80")}, smoothstep(0.45, 0.75, slope) * 0.45);
  vec3 farLand = mix(${rgb("#7b9474")}, ${rgb("#9a9ca4")}, smoothstep(0.28, 0.55, slope) * 0.8 + smoothstep(600.0, 1300.0, vWorld.y) * 0.4);

  float wDark = material.r;
  float wSage = material.g * (1.0 - wDark);
  float wFar = material.b * (1.0 - wDark) * (1.0 - wSage);
  vec3 albedo = meadow;
  albedo = mix(albedo, farLand, wFar);
  albedo = mix(albedo, sage, wSage);
  albedo = mix(albedo, forest, wDark);
  albedo *= mix(1.0, 0.8, clamp(curvature, 0.0, 1.0)) * mix(1.0, 1.15, clamp(-curvature, 0.0, 1.0));
  albedo = mix(albedo, ${rgb("#0f3b33")} * 1.4, uNight * 0.55);

  vec3 L = uKeyDir;
  vec3 V = normalize(uCamPos - vWorld);
  float lit = smoothstep(-0.014, 0.014, uKeyElev - horizon);
  float wrap = max((dot(n, L) + 0.35) / 1.35, 0.0);
  vec3 skyLight = skyBase(normalize(vec3(n.x * 0.6, max(n.y, 0.0) + 0.45, n.z * 0.6)));
  float skyLuma = dot(skyLight, vec3(0.2126, 0.7152, 0.0722));
  vec3 hillShade = mix(skyLight, skyLuma * ${rgb("#9fd0bc")} * 1.25, (wDark + wSage) * 0.6 * (1.0 - uNight));
  vec3 ambient = hillShade * mix(0.5, 1.0, ao) * 1.15 * uAmbient;
  ambient += skyLight * max(dot(n, normalize(vec3(-L.x, 0.6, -L.z))), 0.0) * 0.55 * mix(0.6, 1.0, ao) * uAmbient;
  vec3 direct = uKeyColor * wrap * lit * 0.85;
  float rim = pow(1.0 - max(dot(n, V), 0.0), 3.0) * pow(max(dot(-V, L), 0.0), 2.0);
  vec3 col = albedo * (ambient + direct) + uKeyColor * rim * lit * 0.18 * (1.0 - wFar);
  col = mix(atmosphere(col, vWorld), col, (wDark * 0.8 + wSage * 0.55) * (1.0 - uNight * 0.5));
  col = mix(col, mistPaint(), valleyMist(gl_FragCoord.xy) * 0.82);
  outColor = vec4(encodeColor(col), 1.0);

  vec2 screenSlope = vec2(dFdx(vWorld.y), dFdy(vWorld.y)) + vec2(dFdx(vWorld.z), dFdy(vWorld.z)) * 0.02;
  vec2 contour = length(screenSlope) > 1e-5 ? vec2(screenSlope.y, -screenSlope.x) : vec2(1.0, 0.0);
  outFlow = encodeFlow(contour, mix(0.85, 0.6, wDark), 0.5);
}
`;
var SKY_FS = `${HEADER}${COMMON}
const float SKY_BANDS = 7.0;
uniform mat4 uInvViewProj;
uniform float uSunRadius;
uniform vec2 uSunNdc;
uniform float uSunDiscNdc;
uniform float uAspect;
in vec2 vUv;
layout(location = 0) out vec4 outColor;
layout(location = 1) out vec4 outFlow;

void main() {
  vec4 farPoint = uInvViewProj * vec4(vUv * 2.0 - 1.0, 1.0, 1.0);
  vec3 dir = normalize(farPoint.xyz / farPoint.w - uCamPos);
  float mu = max(dot(dir, uSunDir), 0.0);
  vec2 plane = dir.xz / (dir.y + 0.07);
  float h = clamp(max(dir.y, 0.0) / uSkySpan, 0.0, 1.0);
  float wobble = fbm(vec2(plane.x * 0.35 + uTime * 0.004, h * 2.5 + 1.7), 3) * 0.045;
  float bandPosition = (h + wobble) * SKY_BANDS;
  float bandEdge = smoothstep(0.8, 1.0, fract(bandPosition));
  float bandH = clamp((floor(bandPosition) + bandEdge + 0.5) / SKY_BANDS, 0.0, 1.0);
  float glow = sunGlowAmount(dir);
  float glowSteps = floor(glow * 6.0) / 6.0 + smoothstep(0.75, 1.0, fract(glow * 6.0)) / 6.0;
  vec3 col = mix(skyGradient(h), skyGradient(bandH), 0.82) + uGlow * mix(glow, glowSteps, 0.7) + moonGlow(dir);

  if (dir.y > 0.0) {
    vec2 drift = vec2(uTime * 0.006, uTime * 0.0015);
    float body = fbm(plane * vec2(0.5, 1.5) + drift + vec2(3.1, 0.4), 5);
    float streak = fbm(plane * vec2(0.22, 2.6) + drift * 0.7 + vec2(-1.3, 5.0), 4);
    float cover = smoothstep(0.3, 0.36, body * 0.75 + streak * 0.55) * smoothstep(0.04, 0.2, h) * (1.0 - smoothstep(0.5, 0.9, h));
    vec3 lit = mix(uSkyHorizon * 1.12 + uGlow * 0.6, ${rgb("#5a6b9a")}, uNight);
    vec3 shade = mix(mix(uSkyMid, uSkyTop, 0.5) * 0.94, ${rgb("#1c2748")}, uNight);
    vec3 cloud = mix(shade, lit, smoothstep(0.02, 0.08, streak)) + uGlow * pow(mu, 6.0) * 1.2;
    col = mix(col, cloud, cover * 0.62);
    vec2 starCell = floor(plane * 90.0);
    float stars = step(0.9965, hash12(starCell)) * smoothstep(0.1, 0.4, dir.y / uSkySpan);
    col += vec3(0.9, 0.92, 1.0) * stars * uNight * (0.6 + 0.4 * sin(uTime * 3.0 + hash12(starCell + 3.0) * 30.0));
  }

  float c = dot(dir, uSunDir);
  float angle = sqrt(max(2.0 * (1.0 - c), 0.0));
  float edge = fwidth(angle) * 1.2;
  float disc = 1.0 - smoothstep(uSunRadius - edge, uSunRadius + edge, angle);
  float limb = clamp(angle / uSunRadius, 0.0, 1.0);
  float daylight = smoothstep(0.0, 0.25, uSunDir.y);
  vec3 sunCore = mix(${rgb("#ff9238")}, ${rgb("#f9bb34")}, daylight);
  vec3 sunRim = mix(${rgb("#e45a28")}, ${rgb("#ec9420")}, daylight);
  col = mix(col, mix(sunCore, sunRim, limb * limb), disc);

  float moonAngle = sqrt(max(2.0 * (1.0 - dot(dir, uMoonDir)), 0.0));
  float moonDisc = (1.0 - smoothstep(uSunRadius * 0.8 - edge, uSunRadius * 0.8 + edge, moonAngle)) * uNight;
  col = mix(col, ${rgb("#f4efdc")} * mix(0.9, 1.0, valueNoise(dir.xy * 140.0) * 0.5 + 0.5), moonDisc);
  outColor = vec4(encodeColor(col), 1.0);

  vec2 ndc = vUv * 2.0 - 1.0;
  vec2 fromSun = (ndc - uSunNdc) * vec2(uAspect, 1.0);
  float sunDistance = length(fromSun);
  vec2 swirl = vec2(-fromSun.y, fromSun.x);
  float warp = fbm(plane * 0.7 + vec2(uTime * 0.01, 0.0), 3);
  vec2 sweep = vec2(1.0, 0.35 * warp + 0.12 * sin(ndc.x * 2.5 + ndc.y * 4.0));
  vec2 flow = mix(normalize(swirl + 1e-4), normalize(sweep), smoothstep(0.08, 0.55, sunDistance));
  outFlow = encodeFlow(flow, mix(0.0, 1.0, smoothstep(uSunDiscNdc * 1.1, uSunDiscNdc * 5.0, sunDistance)), 0.0);
}
`;
var GRASS_VS = `${HEADER}${COMMON}
layout(location = 0) in vec2 aBlade;
uniform mat4 uViewProj;
uniform vec2 uGrid;
uniform vec4 uGrassArea;
uniform float uWind;
uniform vec2 uWindDir;
uniform float uPixelAngle;
uniform sampler2D uBrushTex;
uniform sampler2D uHorizonTex;
out vec3 vWorld;
out vec3 vNormal;
out vec3 vTint;
out float vAlong;
out float vLit;
out float vSide;
out float vBrushed;
out float vGlow;
out float vFlower;

const float SEGMENTS = ${float(GRASS_SEGMENTS)};

void main() {
  int columns = int(uGrid.x);
  vec2 cellIndex = vec2(float(gl_InstanceID % columns), float(gl_InstanceID / columns));
  float h1 = hash12(cellIndex + 0.37);
  float h2 = hash12(cellIndex + 17.3);
  float h3 = hash12(cellIndex + 41.7);
  float h4 = hash12(cellIndex + 73.1);
  float h5 = hash12(cellIndex + 5.9);
  vec2 cell = (cellIndex + vec2(h1, h2)) / uGrid;
  float depthT = pow(cell.y, ${float(GRASS_DEPTH_CURVE)});
  float z = 1.0 / mix(1.0 / uGrassArea.x, 1.0 / uGrassArea.y, depthT);
  vec2 root = vec2((cell.x * 2.0 - 1.0) * (uGrassArea.z + z * uGrassArea.w), z);
  float ground = meadowHeight(root) - 0.02;
  float flower = step(0.9955, h4) * (1.0 - smoothstep(4.0, 12.0, z));

  float clump = valueNoise(root * 1.6) * 0.5 + 0.5;
  float meadowPatch = valueNoise(root * 0.21 + 11.0) * 0.5 + 0.5;
  float height = mix(0.22, 0.6, h3) * mix(0.6, 1.2, clump) * mix(0.75, 1.12, meadowPatch);
  height = mix(height, 0.42 + 0.16 * h3, flower);
  height *= mix(1.0, 0.4, smoothstep(uGrassArea.y * 0.55, uGrassArea.y, z));
  float pixelWorld = z * uPixelAngle;
  float width = max(mix(0.01, 0.02, h4) * mix(1.3, 0.9, clump), pixelWorld * 1.6);

  float facing = h5 * 6.2831853;
  vec2 facingDir = vec2(cos(facing), sin(facing));
  float gust = valueNoise(root * 0.09 - uWindDir * uTime * 0.85) * 0.5 + 0.5;
  gust = gust * gust * (3.0 - 2.0 * gust);
  float ripple = valueNoise(root * 0.42 - uWindDir * uTime * 1.9);
  float flutter = sin(uTime * (2.4 + h1 * 1.6) + h2 * 6.2831853 + dot(root, uWindDir) * 1.4);
  float windBend = uWind * (0.1 + 0.62 * gust + 0.12 * ripple + 0.06 * flutter + flower * 0.12 * flutter);
  vec2 bendVec = facingDir * mix(0.08, 0.42, h1) * (1.0 - flower * 0.7) + uWindDir * windBend;
  vec3 brushSample = texture(uBrushTex, vec2(cell.x, depthT)).xyz;
  vec2 brush = brushSample.xy;
  bendVec += brush * (1.0 + flower * 0.4);
  vBrushed = clamp(length(brush) / 1.1, 0.0, 1.0);
  vGlow = brushSample.z * mix(0.12, 1.0, step(0.58, h3) * (0.6 + 0.4 * h5)) * (1.0 - smoothstep(10.0, 30.0, z));
  float bend = length(bendVec);
  vec2 bendDir = bend > 1e-4 ? bendVec / bend : facingDir;
  bend = min(bend, 1.5);

  float s = aBlade.x / SEGMENTS;
  float arc = bend * s;
  float safeBend = max(bend, 1e-3);
  float outward = height * (1.0 - cos(arc)) / safeBend;
  float upward = height * sin(arc) / safeBend;
  vec3 spine = vec3(root.x, ground, root.y) + vec3(bendDir.x * outward, upward, bendDir.y * outward);
  vec3 tangent = vec3(bendDir.x * sin(arc), cos(arc), bendDir.y * sin(arc));

  vec3 toCamera = normalize(uCamPos - spine);
  vec3 across = vec3(-facingDir.y, 0.0, facingDir.x);
  vec3 cameraAcross = normalize(cross(vec3(0.0, 1.0, 0.0), toCamera));
  across = normalize(mix(across, cameraAcross * (dot(across, cameraAcross) < 0.0 ? -1.0 : 1.0), 0.6));
  float taper = pow(max(1.0 - s, 0.0), 0.62);
  float head = smoothstep(0.78, 0.9, s) * (1.0 - smoothstep(0.94, 1.0, s));
  float profile = mix(taper, 0.28 + head * 2.6, flower);
  vec3 position = spine + across * aBlade.y * width * profile * 0.5;

  vec3 normal = normalize(cross(across, tangent));
  if (dot(normal, toCamera) < 0.0) normal = -normal;
  vNormal = normalize(normal + across * aBlade.y * 0.55);

  vec3 deep = ${rgb("#355d2f")};
  vec3 fresh = ${rgb("#7a963f")};
  vec3 dry = ${rgb("#b8a764")};
  vTint = mix(mix(fresh, deep, h2 * 0.75), dry, smoothstep(0.86, 0.98, h4) * 0.7);
  vTint = mix(vTint, ${rgb("#94a24b")}, smoothstep(0.55, 0.9, meadowPatch) * 0.45);
  float petal = hash12(cellIndex + 91.0);
  vec3 bloom = petal < 0.35 ? ${rgb("#f6efe0")} : petal < 0.6 ? ${rgb("#f2bf3a")} : petal < 0.8 ? ${rgb("#e98aa0")} : ${rgb("#9c8fd6")};
  vTint = mix(vTint, bloom, flower * step(0.8, s));
  vFlower = flower;
  vAlong = s;
  vSide = aBlade.y;
  vLit = smoothstep(-0.014, 0.014, uKeyElev - shadowHorizon(texture(uHorizonTex, terrainUv(root))));
  vWorld = position;
  gl_Position = uViewProj * vec4(position, 1.0);
}
`;
var GRASS_FS = `${HEADER}${COMMON}
in vec3 vWorld;
in vec3 vNormal;
in vec3 vTint;
in float vAlong;
in float vLit;
in float vSide;
in float vBrushed;
in float vGlow;
in float vFlower;
layout(location = 0) out vec4 outColor;
layout(location = 1) out vec4 outFlow;

void main() {
  vec3 n = normalize(vNormal);
  vec3 V = normalize(uCamPos - vWorld);
  vec3 L = uKeyDir;
  float s = vAlong;
  float petals = vFlower * step(0.8, s);
  vec3 albedo = mix(${rgb("#16301a")}, vTint, max(smoothstep(0.0, 0.6, s), petals));
  albedo = mix(albedo, ${rgb("#b4b26e")}, smoothstep(0.65, 1.0, s) * 0.3 * (1.0 - petals));
  albedo = mix(albedo, ${rgb("#0c3d2b")} * 1.6, uNight * 0.6 * (1.0 - petals));
  albedo = mix(albedo, ${rgb("#22200f")}, vBrushed * 0.6 * (1.0 - petals) * (1.0 - uNight));
  float ao = mix(0.28, 1.0, smoothstep(0.0, 0.8, s)) * (1.0 - vBrushed * 0.82 * (1.0 - s * 0.25));
  float wrap = max(dot(n, L) * 0.5 + 0.5, 0.0);
  float backlight = pow(max(dot(-V, L), 0.0), 8.0);
  float edge = smoothstep(0.35, 1.0, abs(vSide));
  float translucency = backlight * smoothstep(0.3, 1.0, s) * (0.3 + 0.7 * edge);
  vec3 skyLight = skyBase(normalize(vec3(n.x * 0.5, 0.75, n.z * 0.5)));
  vec3 col = albedo * (skyLight * 0.8 * ao * uAmbient + uKeyColor * wrap * vLit * ao * 0.62);
  col += albedo * ${rgb("#f2e48a")} * uKeyColor * translucency * vLit * 1.1 * (1.0 - uNight);
  float underside = vGlow * smoothstep(0.25, 1.0, s) + vBrushed * 0.18 * s;
  col += mix(${rgb("#1f9c7c")}, ${rgb("#b4f5dc")}, s * vGlow) * underside * uNight * 0.36;
  col = atmosphere(col, vWorld);
  col = mix(col, mistPaint(), valleyMist(gl_FragCoord.xy) * 0.82);
  outColor = vec4(encodeColor(col), 1.0);
  vec2 along = vec2(dFdx(vAlong), dFdy(vAlong));
  outFlow = encodeFlow(length(along) > 1e-6 ? along : vec2(0.0, 1.0), mix(0.32, 0.18, petals), 1.0);
}
`;
var PAINT_FS = `${HEADER}
uniform sampler2D uScene;
uniform sampler2D uFlow;
uniform vec2 uTexel;
uniform float uRadius;
in vec2 vUv;
out vec4 outColor;

void main() {
  vec4 flow = texture(uFlow, vUv);
  vec2 orientation = flow.xy * 2.0 - 1.0;
  float coherence = clamp(length(orientation), 0.0, 1.0);
  float angle = 0.5 * atan(orientation.y, orientation.x);
  vec2 along = vec2(cos(angle), sin(angle));
  vec2 across = vec2(-along.y, along.x);
  float radius = uRadius * mix(0.7, 1.6, flow.z);
  float stretch = mix(1.0, 2.3, coherence);
  vec2 axisA = along * radius * stretch * uTexel;
  vec2 axisB = across * radius / stretch * uTexel;
  vec3 sum0 = vec3(0.0), sum1 = vec3(0.0), sum2 = vec3(0.0), sum3 = vec3(0.0);
  vec3 sq0 = vec3(0.0), sq1 = vec3(0.0), sq2 = vec3(0.0), sq3 = vec3(0.0);
  float w0 = 0.0, w1 = 0.0, w2 = 0.0, w3 = 0.0;
  for (int j = -3; j <= 3; j++) {
    for (int i = -3; i <= 3; i++) {
      vec2 q = vec2(float(i), float(j)) / 3.0;
      float d2 = dot(q, q);
      if (d2 > 1.05) continue;
      vec3 c = texture(uScene, vUv + axisA * q.x + axisB * q.y).rgb;
      float w = exp(-d2 * 1.6);
      vec3 cw = c * w;
      vec3 c2w = c * c * w;
      if (q.x >= 0.0 && q.y >= 0.0) { sum0 += cw; sq0 += c2w; w0 += w; }
      if (q.x <= 0.0 && q.y >= 0.0) { sum1 += cw; sq1 += c2w; w1 += w; }
      if (q.x <= 0.0 && q.y <= 0.0) { sum2 += cw; sq2 += c2w; w2 += w; }
      if (q.x >= 0.0 && q.y <= 0.0) { sum3 += cw; sq3 += c2w; w3 += w; }
    }
  }
  vec3 m0 = sum0 / w0, m1 = sum1 / w1, m2 = sum2 / w2, m3 = sum3 / w3;
  float v0 = dot(abs(sq0 / w0 - m0 * m0), vec3(1.0));
  float v1 = dot(abs(sq1 / w1 - m1 * m1), vec3(1.0));
  float v2 = dot(abs(sq2 / w2 - m2 * m2), vec3(1.0));
  float v3 = dot(abs(sq3 / w3 - m3 * m3), vec3(1.0));
  float k0 = 1.0 / (1.0 + pow(v0 * 900.0, 2.0));
  float k1 = 1.0 / (1.0 + pow(v1 * 900.0, 2.0));
  float k2 = 1.0 / (1.0 + pow(v2 * 900.0, 2.0));
  float k3 = 1.0 / (1.0 + pow(v3 * 900.0, 2.0));
  vec3 color = (m0 * k0 + m1 * k1 + m2 * k2 + m3 * k3) / (k0 + k1 + k2 + k3);
  float levels = mix(26.0, 18.0, step(flow.a, 0.25));
  color = mix(color, floor(color * levels + 0.5) / levels, 0.35);
  outColor = vec4(color, 1.0);
}
`;
var FINAL_FS = `${HEADER}${COMMON}
uniform sampler2D uPaint;
uniform sampler2D uFlow;
uniform sampler2D uSmear;
uniform sampler2D uHorizonTex;
uniform vec2 uResolution;
uniform float uDpr;
uniform vec3 uLight;
uniform vec3 uSpecColor;
uniform vec2 uSunPx;
uniform vec2 uMoonPx;
uniform float uSunRadiusPx;
uniform float uRelief;
in vec2 vUv;
out vec4 outColor;


vec2 hash22(vec2 p) {
  return vec2(hash12(p), hash12(p + 19.19));
}


void main() {
  vec2 pixel = gl_FragCoord.xy;
  vec2 smear = texture(uSmear, pixel / uResolution).xy;
  float regionAtPixel = texture(uFlow, pixel / uResolution).a;
  vec2 painted = pixel - smear * uResolution * mix(0.35, 1.0, regionAtPixel);
  vec2 uv = painted / uResolution;
  vec3 base = texture(uPaint, uv).rgb;

  float cellSize = 16.0 * uDpr;
  float reach = 32.3 * uDpr;
  float reach2 = reach * reach;
  vec2 cell = floor(painted / cellSize);
  float bestOrder = -1.0;
  vec2 bestLocal = vec2(0.0);
  vec2 bestCenter = vec2(0.0);
  float bestSeed = 0.0;
  float bestRegion = 0.0;
  for (int j = -2; j <= 2; j++) {
    for (int i = -2; i <= 2; i++) {
      vec2 id = cell + vec2(float(i), float(j));
      vec2 jitter = hash22(id);
      vec2 center = (id + jitter) * cellSize;
      vec2 d = painted - center;
      if (dot(d, d) > reach2) continue;
      vec4 flow = texture(uFlow, center / uResolution);
      vec2 orientation = flow.xy * 2.0 - 1.0;
      float angle = 0.5 * atan(orientation.y, orientation.x) + (jitter.x - 0.5) * 0.28;
      vec2 along = vec2(cos(angle), sin(angle));
      float size = mix(0.4, 1.0, flow.z);
      float halfLength = mix(11.0, 27.0, size) * uDpr * (0.85 + jitter.y * 0.3);
      float halfWidth = mix(3.4, 7.5, size) * uDpr * (0.85 + jitter.x * 0.3);
      float a = dot(d, along) / halfLength;
      float b = dot(d, vec2(-along.y, along.x)) / (halfWidth * (1.0 - 0.35 * smoothstep(0.1, 1.0, a)));
      if (pow(abs(a), 2.6) + b * b < 1.0) {
        float order = hash12(id + 7.13);
        if (order > bestOrder) {
          bestOrder = order;
          bestLocal = vec2(a, b);
          bestCenter = center;
          bestSeed = jitter.y;
          bestRegion = flow.a;
        }
      }
    }
  }

  float height = 0.0;
  vec3 color = base;
  if (bestOrder >= 0.0) {
    float across = abs(bestLocal.y);
    float body = sqrt(max(1.0 - across * across, 0.0)) * (1.0 - smoothstep(0.8, 1.0, abs(bestLocal.x)));
    float groove = 1.0 - abs(valueNoise(vec2(bestLocal.x * 0.8, bestLocal.y * 4.2) + bestSeed * 61.0));
    float lip = exp(-pow((bestLocal.x - 0.8) / 0.12, 2.0)) * (1.0 - across * 0.7);
    float banks = smoothstep(0.6, 0.86, across) * (1.0 - smoothstep(0.86, 1.0, across));
    float gain = bestRegion < 0.25 ? 0.78 : bestRegion < 0.75 ? 1.0 : 0.7;
    height = (0.4 * body + 0.3 * groove * groove * body + 0.34 * lip + 0.2 * banks + bestOrder * 0.16) * gain;
    vec3 dab = texture(uPaint, bestCenter / uResolution).rgb * (0.96 + bestSeed * 0.08);
    color = mix(base, dab, 0.55) * (1.0 - 0.05 * bestLocal.x);
  }
  vec2 weave = sin(pixel / uDpr * vec2(1.05, 1.15));
  float grain = weave.x * weave.y * 0.5 + valueNoise(pixel / uDpr * 0.7) * 0.5;
  height += grain * 0.012;

  vec3 normal = normalize(vec3(-dFdx(height) * uRelief / uDpr, -dFdy(height) * uRelief / uDpr, 1.0));
  float diffuse = dot(normal, uLight) - uLight.z;
  vec3 halfway = normalize(uLight + vec3(0.0, 0.0, 1.0));
  float spec = max(pow(max(dot(normal, halfway), 0.0), 18.0) - pow(halfway.z, 18.0), 0.0);
  color = color * (1.0 + diffuse * 0.8) * (1.0 + grain * 0.03) + uSpecColor * spec * mix(0.1, 0.22, bestRegion);

  float sunDistance = length(pixel - uSunPx);
  float sunVisible = smoothstep(-0.03, 0.06, asin(uSunDir.y) - shadowHorizon(texture(uHorizonTex, terrainUv(uCamPos.xz))));
  float glow = exp(-max(sunDistance - uSunRadiusPx, 0.0) / (uSunRadiusPx * 0.8)) * 0.4 + exp(-sunDistance / (uSunRadiusPx * 5.0)) * 0.14;
  color += pow(uGlow * 1.4 + vec3(0.035, 0.018, 0.0), vec3(1.0 / 2.2)) * glow * 0.5 * sunVisible * (1.0 - uNight);
  float moonDistance = length(pixel - uMoonPx);
  color += vec3(0.55, 0.62, 0.8) * exp(-max(moonDistance - uSunRadiusPx * 0.8, 0.0) / (uSunRadiusPx * 1.4)) * 0.3 * uNight;

  color += (hash12(pixel + fract(uTime * 3.7) * 97.0) - 0.5) / 255.0;
  outColor = vec4(color, 1.0);
}
`;
var PARTICLE_VS = `${HEADER}
layout(location = 0) in vec4 aPlace;
layout(location = 1) in vec4 aColor;
layout(location = 2) in float aKind;
uniform vec2 uResolution;
out vec4 vColor;
out float vKind;
out float vAngle;
void main() {
  vColor = aColor;
  vKind = aKind;
  vAngle = aPlace.w;
  gl_Position = vec4(aPlace.x / uResolution.x * 2.0 - 1.0, 1.0 - aPlace.y / uResolution.y * 2.0, 0.0, 1.0);
  gl_PointSize = aPlace.z;
}
`;
var PARTICLE_FS = `${HEADER}
in vec4 vColor;
in float vKind;
in float vAngle;
out vec4 outColor;
void main() {
  vec2 q = gl_PointCoord * 2.0 - 1.0;
  if (vKind < 0.5) {
    float r2 = dot(q, q);
    float glow = exp(-r2 * 5.0) * 0.8 + exp(-r2 * 40.0) * 1.2;
    outColor = vec4(vColor.rgb * glow, 0.0);
    return;
  }
  vec2 r = mat2(cos(vAngle), sin(vAngle), -sin(vAngle), cos(vAngle)) * q;
  float shape = length(vec2(r.x, r.y * 1.9 + r.x * r.x * 0.6));
  float alpha = (1.0 - smoothstep(0.78, 0.95, shape)) * vColor.a;
  float shade = 0.82 + 0.18 * r.y;
  outColor = vec4(vColor.rgb * shade * alpha / max(vColor.a, 1e-3), alpha);
}
`;
var SHADERS = {
  fullscreenVs: FULLSCREEN_VS,
  bakeHeightFs: BAKE_HEIGHT_FS,
  bakeAuxFs: BAKE_AUX_FS,
  terrainVs: TERRAIN_VS,
  terrainFs: TERRAIN_FS,
  skyFs: SKY_FS,
  grassVs: GRASS_VS,
  grassFs: GRASS_FS,
  paintFs: PAINT_FS,
  finalFs: FINAL_FS,
  particleVs: PARTICLE_VS,
  particleFs: PARTICLE_FS
};

// src/meadow/smear.ts
var HEAL_SECONDS = 0.45;
var MAX_SHIFT = 0.045;
var SETTLED_SHIFT = 0.0003;

class WetPaint {
  columns;
  rows;
  field;
  last = { x: 0, y: 0, set: false };
  idle = 0;
  constructor(columns, rows) {
    this.columns = columns;
    this.rows = rows;
    this.field = new Float32Array(columns * rows * 2);
  }
  get settled() {
    return this.idle > 4;
  }
  step(dt, pointer, width, height, radiusPx) {
    const { columns, rows, field } = this;
    const heal = Math.exp(-dt / HEAL_SECONDS);
    let peak = 0;
    for (let i = 0;i < field.length; i++) {
      field[i] *= heal;
      peak = Math.max(peak, Math.abs(field[i]));
    }
    const last = this.last;
    this.idle = peak < SETTLED_SHIFT ? this.idle + 1 : 0;
    if (!pointer.active || dt <= 0) {
      last.set = false;
      return;
    }
    const hadLast = last.set;
    const moveX = (pointer.x - last.x) / width;
    const moveY = -(pointer.y - last.y) / height;
    last.x = pointer.x;
    last.y = pointer.y;
    last.set = true;
    if (!hadLast)
      return;
    if (Math.abs(moveX) + Math.abs(moveY) < 0.00001)
      return;
    this.idle = 0;
    const centerU = pointer.x / width;
    const centerV = 1 - pointer.y / height;
    for (let row = 0;row < rows; row++) {
      const dy = ((row + 0.5) / rows - centerV) * height;
      if (Math.abs(dy) > radiusPx)
        continue;
      for (let col = 0;col < columns; col++) {
        const dx = ((col + 0.5) / columns - centerU) * width;
        const distance = Math.hypot(dx, dy);
        if (distance > radiusPx)
          continue;
        const t = 1 - distance / radiusPx;
        const falloff = t * t * (3 - 2 * t);
        const index = (row * columns + col) * 2;
        field[index] = clamp(field[index] + moveX * falloff * 0.6);
        field[index + 1] = clamp(field[index + 1] + moveY * falloff * 0.6);
      }
    }
  }
}
function clamp(value) {
  return Math.max(-MAX_SHIFT, Math.min(MAX_SHIFT, value));
}

// src/meadow/scene.ts
var BAKE_STRIPS = 4;
var BRUSH_COLUMNS = 84;
var BRUSH_ROWS = 30;
var SMEAR_COLUMNS = 64;
var SMEAR_ROWS = 40;
var PAINT_SCALE = 0.62;
var WIND_DIR = normalize2(1, 0.32);
var STACKED_HORIZON_SCREEN = 0.69;
var SHARE_ROW_SLACK = 8;
var TAP_PX = 10;
var AMBIENT_FRAME_MS = 1000 / 30;
var ACTIVE_HOLD_MS = 700;
var CYCLE_RAMP_SECONDS = 2.5;
var DRAG_FOLLOW = 18;
var BODY_HIT_PX = 46;
var BODY_UP = degrees3(-1.5);
var CONTINUITY_PX = 120;
var DRAG_SAMPLES = 360;
var SKY_DARK_NIGHT = 0.4;
var PROBE_INTERVAL_MS = 400;
var FIREFLY_TEXT_REACH = 48;
var SUN_MIN_RED = 200;
var SUN_MAX_BLUE_SHARE = 0.45;
var MOON_MIN_SUM = 520;
var INTERACTIVE = "a, button, input, textarea, select, label, summary, [data-send-panel]";
function degrees3(value) {
  return value * Math.PI / 180;
}
var mix2 = (a, b, t) => a + (b - a) * t;
function normalize2(x, y) {
  const length = Math.hypot(x, y);
  return [x / length, y / length];
}
function pickTier() {
  const coarse = matchMedia("(pointer: coarse)").matches;
  const phone = coarse && Math.min(screen.width, screen.height) < 700;
  if (phone)
    return { phone, dprCap: 2, pixelBudget: 1100000, blades: 30000, bakeSize: [512, 1024], gridSize: [300, 380], brushRadius: 96 };
  return { phone, dprCap: 1.6, pixelBudget: 2400000, blades: 80000, bakeSize: [768, 1536], gridSize: [520, 600], brushRadius: 130 };
}
function createMeadow(options) {
  const { canvas, hero, hint, reducedMotion } = options;
  const gl = canvas.getContext("webgl2", {
    antialias: false,
    alpha: false,
    depth: false,
    stencil: false,
    premultipliedAlpha: false,
    preserveDrawingBuffer: false
  });
  if (!gl)
    return null;
  const tier = pickTier();
  const brush = new GrassBrush(BRUSH_COLUMNS, BRUSH_ROWS);
  const wet = new WetPaint(SMEAR_COLUMNS, SMEAR_ROWS);
  const particles = new Particles;
  const pointer = { x: 0, y: 0, active: false, touch: false, downX: 0, downY: 0, downAt: 0, down: false, drag: null, lastX: 0, lastY: 0 };
  const windOn = !reducedMotion;
  const look = { x: 0, y: 0, settled: true };
  const startCycle = reducedMotion ? SUNRISE_TO : SUNRISE_FROM;
  const day = { c: startCycle, target: startCycle, mode: reducedMotion ? "rest" : "sunrise", from: 0, to: 0, start: 0, ramp: 0 };
  const bodies = { sun: { x: -999, y: -999, up: false }, moon: { x: -999, y: -999, up: false }, radius: 40 };
  const projection = new Float32Array(16);
  const view = new Float32Array(16);
  const viewProjection = new Float32Array(16);
  const inverseViewProjection = new Float32Array(16);
  let phase = "compile";
  let batch = null;
  let gpu = null;
  let targets = null;
  let bakeStrip = 0;
  let raf = 0;
  let ambientTimer = 0;
  let paused = false;
  let lastRenderAt = 0;
  let activeUntil = 0;
  let previousFrameBusy = false;
  let lost = false;
  let heroVisible = true;
  let firstFrameSent = false;
  let lastNow = 0;
  let windTime = 0;
  let renderScale = 1;
  let frameCost = 0;
  let framesSinceScale = 0;
  let brushUploaded = false;
  let smearUploaded = false;
  let needsRender = true;
  let framing = framingFor(1.6);
  const veil = { left: 0, top: 0, right: 0, bottom: 0 };
  const tones = new TextTones(hero, document.querySelector("[data-bar]"), (tone) => {
    hero.dataset.sky = tone;
  });
  let probe = null;
  let tonesFromScene = false;
  let lastProbeAt = -Infinity;
  let probedCycle = -1;
  let sunSeen = true;
  let moonSeen = true;
  let stack = { clear: 0, horizon: 0 };
  let cssWidth = 1;
  let cssHeight = 1;
  let heroDocLeft = 0;
  let heroDocTop = 0;
  let scrollTop = window.scrollY;
  let scrollLeft = window.scrollX;
  let scrollStale = false;
  let viewProj = null;
  let eye = [0, CAMERA_HEIGHT, 0];
  let grassTopCss = 0;
  let hasDragged = false;
  let cursor = "";
  let hintBody = null;
  let hintWidth = 0;
  let hintTransform = "";
  const fail = (error) => {
    phase = "failed";
    canvas.dataset.meadow = "failed";
    console.warn(error);
  };
  const startCompile = () => {
    try {
      batch = new ProgramBatch(gl, {
        bakeHeight: [SHADERS.fullscreenVs, SHADERS.bakeHeightFs],
        bakeAux: [SHADERS.fullscreenVs, SHADERS.bakeAuxFs],
        terrain: [SHADERS.terrainVs, SHADERS.terrainFs],
        sky: [SHADERS.fullscreenVs, SHADERS.skyFs],
        grass: [SHADERS.grassVs, SHADERS.grassFs],
        paint: [SHADERS.fullscreenVs, SHADERS.paintFs],
        final: [SHADERS.fullscreenVs, SHADERS.finalFs],
        particles: [SHADERS.particleVs, SHADERS.particleFs]
      });
      phase = "compile";
    } catch (error) {
      fail(error);
    }
  };
  const buildGpu = (programs) => {
    const emptyVao = gl.createVertexArray();
    const bladeVertices = [];
    for (let segment = 0;segment < GRASS_SEGMENTS; segment++)
      bladeVertices.push(segment, -1, segment, 1);
    bladeVertices.push(GRASS_SEGMENTS, 0);
    const grassVao = gl.createVertexArray();
    gl.bindVertexArray(grassVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(bladeVertices), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    const [columns, rows] = tier.gridSize;
    const uv = new Float32Array((columns + 1) * (rows + 1) * 2);
    for (let row = 0;row <= rows; row++) {
      const v = 1 - (1 - row / rows) ** 1.5;
      for (let col = 0;col <= columns; col++) {
        const index = (row * (columns + 1) + col) * 2;
        uv[index] = col / columns;
        uv[index + 1] = v;
      }
    }
    const indices = new Uint32Array(rows * ((columns + 1) * 2 + 1));
    let cursorIndex = 0;
    for (let row = 0;row < rows; row++) {
      for (let col = 0;col <= columns; col++) {
        indices[cursorIndex++] = (row + 1) * (columns + 1) + col;
        indices[cursorIndex++] = row * (columns + 1) + col;
      }
      indices[cursorIndex++] = 4294967295;
    }
    const terrainVao = gl.createVertexArray();
    gl.bindVertexArray(terrainVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ARRAY_BUFFER, uv, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, indices, gl.STATIC_DRAW);
    const particleVao = gl.createVertexArray();
    gl.bindVertexArray(particleVao);
    const particleBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, particleBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, particles.data.byteLength, gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 4, gl.FLOAT, false, PARTICLE_STRIDE, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 4, gl.FLOAT, false, PARTICLE_STRIDE, 16);
    gl.enableVertexAttribArray(2);
    gl.vertexAttribPointer(2, 1, gl.FLOAT, false, PARTICLE_STRIDE, 32);
    gl.bindVertexArray(null);
    const [bakeWidth, bakeHeight] = tier.bakeSize;
    const heightTex = createTexture(gl, bakeWidth, bakeHeight);
    const materialTex = createTexture(gl, bakeWidth, bakeHeight);
    const auxTex = createTexture(gl, bakeWidth, bakeHeight);
    const horizonTex = createTexture(gl, bakeWidth, bakeHeight);
    const bakeFramebuffer = createFramebuffer(gl, [heightTex, materialTex]);
    const auxFramebuffer = createFramebuffer(gl, [auxTex, horizonTex]);
    const brushTex = createTexture(gl, BRUSH_COLUMNS, BRUSH_ROWS, gl.RGBA16F, gl.RGBA, gl.FLOAT);
    const smearTex = createTexture(gl, SMEAR_COLUMNS, SMEAR_ROWS, gl.RG16F, gl.RG, gl.FLOAT);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return {
      programs,
      emptyVao,
      grassVao,
      terrainVao,
      particleVao,
      particleBuffer,
      terrainIndexCount: indices.length,
      heightTex,
      materialTex,
      auxTex,
      horizonTex,
      bakeFramebuffer,
      auxFramebuffer,
      brushTex,
      smearTex
    };
  };
  const bakeStep = (g) => {
    const [width, height] = tier.bakeSize;
    const stripHeight = Math.ceil(height / BAKE_STRIPS);
    const strip = bakeStrip % BAKE_STRIPS;
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.BLEND);
    gl.bindVertexArray(g.emptyVao);
    gl.viewport(0, 0, width, height);
    gl.enable(gl.SCISSOR_TEST);
    gl.scissor(0, strip * stripHeight, width, stripHeight);
    if (bakeStrip < BAKE_STRIPS) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, g.bakeFramebuffer);
      g.programs.bakeHeight.use().vec2("uBakeSize", width, height);
    } else {
      gl.bindFramebuffer(gl.FRAMEBUFFER, g.auxFramebuffer);
      bindTexture(gl, 0, g.heightTex);
      g.programs.bakeAux.use().int("uHeightTex", 0).vec4("uAzimuths", SHADOW_AZIMUTHS[0], SHADOW_AZIMUTHS[1], SHADOW_AZIMUTHS[2], SHADOW_AZIMUTHS[3]);
    }
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.disable(gl.SCISSOR_TEST);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    bakeStrip++;
    return bakeStrip >= BAKE_STRIPS * 2;
  };
  const releaseTargets = () => {
    probe?.dispose();
    probe = null;
    if (!targets)
      return;
    gl.deleteTexture(targets.sceneColor);
    gl.deleteTexture(targets.sceneFlow);
    gl.deleteTexture(targets.paint);
    gl.deleteRenderbuffer(targets.depth);
    gl.deleteFramebuffer(targets.sceneFramebuffer);
    gl.deleteFramebuffer(targets.paintFramebuffer);
    targets = null;
  };
  const ensureSize = () => {
    const budgetDpr = Math.sqrt(tier.pixelBudget / Math.max(1, cssWidth * cssHeight));
    const dpr = Math.min(window.devicePixelRatio || 1, tier.dprCap, budgetDpr) * renderScale;
    const width = Math.max(1, Math.round(cssWidth * dpr));
    const height = Math.max(1, Math.round(cssHeight * dpr));
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
      framing = framingFor(width / height, stack.clear, stack.horizon);
      particles.resize(cssWidth, cssHeight);
      needsRender = true;
    }
    const paintWidth = Math.max(1, Math.round(width * PAINT_SCALE));
    const paintHeight = Math.max(1, Math.round(height * PAINT_SCALE));
    if (targets && targets.width === paintWidth && targets.height === paintHeight)
      return;
    releaseTargets();
    const sceneColor = createTexture(gl, paintWidth, paintHeight);
    const sceneFlow = createTexture(gl, paintWidth, paintHeight);
    const sceneFramebuffer = createFramebuffer(gl, [sceneColor, sceneFlow]);
    const depth = gl.createRenderbuffer();
    gl.bindRenderbuffer(gl.RENDERBUFFER, depth);
    gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT24, paintWidth, paintHeight);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, depth);
    const paint = createTexture(gl, paintWidth, paintHeight);
    const paintFramebuffer = createFramebuffer(gl, [paint]);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    targets = { width: paintWidth, height: paintHeight, sceneColor, sceneFlow, depth, sceneFramebuffer, paint, paintFramebuffer };
    probe = new ColorProbe(gl, paintWidth, paintHeight);
    probedCycle = -1;
  };
  const grassArea = (aspect) => {
    const tanHalfH = Math.tan(framing.verticalFov / 2) * aspect;
    return { near: GRASS_NEAR, far: GRASS_FAR, rootWidth: GRASS_ROOT_WIDTH, slope: tanHalfH * 1.08 + 0.1 };
  };
  const project = (x, y, z) => {
    if (!viewProj)
      return null;
    const w = viewProj[3] * x + viewProj[7] * y + viewProj[11] * z + viewProj[15];
    if (w <= 0)
      return null;
    const ndcX = (viewProj[0] * x + viewProj[4] * y + viewProj[8] * z + viewProj[12]) / w;
    const ndcY = (viewProj[1] * x + viewProj[5] * y + viewProj[9] * z + viewProj[13]) / w;
    return { x: (ndcX * 0.5 + 0.5) * cssWidth, y: (0.5 - ndcY * 0.5) * cssHeight, ndcX, ndcY };
  };
  const projectDirection = (dir) => project(eye[0] + dir[0] * 1e4, eye[1] + dir[1] * 1e4, eye[2] + dir[2] * 1e4);
  const bodyPoint = (cycle, body) => {
    const { p, moon } = dayAt(cycle);
    if (body === "sun") {
      const sun = sunPath(p, framing.sunPeak, framing.sunCeiling, framing.sunSweep);
      return projectDirection(directionFrom(sun.azimuth, sun.elevation));
    }
    const path = moonPath(moon, framing);
    return projectDirection(directionFrom(path.azimuth, path.elevation));
  };
  const nearestCycle = (x, y, body) => {
    const [from, to] = body === "sun" ? SUN_RANGE : MOON_RANGE;
    let best = day.target;
    let bestScore = Infinity;
    for (let i = 0;i <= DRAG_SAMPLES; i++) {
      const cycle = from + (to - from) * i / DRAG_SAMPLES;
      const point = bodyPoint(cycle, body);
      if (!point)
        continue;
      const score = Math.hypot(point.x - x, point.y - y) + Math.abs(cycleDelta(day.target, cycle)) * CONTINUITY_PX;
      if (score < bestScore) {
        bestScore = score;
        best = wrapCycle(cycle);
      }
    }
    return best;
  };
  const hitBody = (x, y) => {
    let hit = null;
    let nearest = Math.max(BODY_HIT_PX, bodies.radius * 1.7);
    for (const name of ["sun", "moon"]) {
      const body = bodies[name];
      if (!body.up)
        continue;
      const distance = Math.hypot(x - body.x, y - body.y);
      if (distance < nearest) {
        nearest = distance;
        hit = name;
      }
    }
    return hit;
  };
  const setCursor = (next) => {
    if (next === cursor)
      return;
    cursor = next;
    if (next)
      hero.dataset.cursor = next;
    else
      delete hero.dataset.cursor;
  };
  const startDrag = (body) => {
    pointer.drag = body;
    day.mode = "drag";
    day.target = day.c;
    hasDragged = true;
    hint?.classList.remove("is-shown");
    setCursor("grabbing");
    wake();
  };
  const resumeCycle = () => {
    day.mode = reducedMotion ? "rest" : "cycle";
    day.ramp = 0;
  };
  const advanceToNextStop = () => {
    let delta = 1;
    for (const stop of CYCLE_STOPS) {
      const ahead = wrapCycle(stop - day.c);
      if (ahead > 0.01 && ahead < delta)
        delta = ahead;
    }
    if (reducedMotion) {
      day.c = day.target = wrapCycle(day.c + delta);
      day.mode = "rest";
      needsRender = true;
      return;
    }
    day.mode = "settle";
    day.from = day.c;
    day.to = day.c + delta;
    day.start = performance.now();
  };
  const release = (x, y) => {
    pointer.drag = null;
    if (Math.hypot(x - pointer.downX, y - pointer.downY) < TAP_PX)
      advanceToNextStop();
    else
      resumeCycle();
    setCursor(hitBody(x, y) ? "grab" : "");
    wake();
  };
  const updateDay = (now, dt) => {
    if (day.mode === "sunrise") {
      const elapsed = sunriseElapsed(now);
      day.c = day.target = mix2(SUNRISE_FROM, SUNRISE_TO, sunriseProgress(elapsed));
      if (elapsed > SUNRISE_HOLD_MS + DAY_MOVE_MS)
        resumeCycle();
      return;
    }
    if (day.mode === "settle") {
      const t = (now - day.start) / DAY_MOVE_MS;
      day.c = day.target = wrapCycle(mix2(day.from, day.to, easeInOutSine(t)));
      if (t >= 1)
        resumeCycle();
      return;
    }
    if (day.mode === "cycle") {
      day.ramp = Math.min(1, day.ramp + dt / CYCLE_RAMP_SECONDS);
      const advance = easeInOutSine(day.ramp) * dt / CYCLE_SECONDS;
      day.target = wrapCycle(day.target + advance);
      day.c = wrapCycle(day.c + advance);
    }
    const lag = cycleDelta(day.c, day.target);
    day.c = Math.abs(lag) < 0.00001 ? day.target : wrapCycle(day.c + lag * (1 - Math.exp(-dt * DRAG_FOLLOW)));
  };
  const isBusy = (now) => {
    if (needsRender || day.mode === "sunrise" || day.mode === "drag" || day.mode === "settle")
      return true;
    if (Math.abs(cycleDelta(day.c, day.target)) > 0.0001)
      return true;
    if (reducedMotion)
      return !!probe && (probe.pending || probedCycle !== day.c);
    return now < activeUntil || !look.settled || !brush.settled || !wet.settled || particles.busy;
  };
  const fireflyShade = (x, y) => tones.shadeAt(x, y, FIREFLY_TEXT_REACH);
  const captureProbe = (now, t) => {
    if (!probe || probe.pending)
      return;
    if (reducedMotion ? probedCycle === day.c : now - lastProbeAt < PROBE_INTERVAL_MS)
      return;
    probe.capture(t.paintFramebuffer, t.width, t.height);
    lastProbeAt = now;
    probedCycle = day.c;
  };
  const readProbe = () => {
    if (!probe?.poll())
      return;
    tones.decide(probe.pixels, probe.width, probe.height, cssWidth, cssHeight);
    if (!tonesFromScene) {
      tonesFromScene = true;
      tones.ease(Infinity);
    }
    const sun = probe.colorAt(bodies.sun.x, bodies.sun.y, bodies.radius * 0.45, cssWidth, cssHeight, true);
    const moon = probe.colorAt(bodies.moon.x, bodies.moon.y, bodies.radius * 0.8, cssWidth, cssHeight);
    sunSeen = !!sun && sun[0] >= SUN_MIN_RED && sun[2] <= sun[0] * SUN_MAX_BLUE_SHARE;
    moonSeen = !!moon && moon[0] + moon[1] + moon[2] >= MOON_MIN_SUM;
  };
  function readScroll() {
    if (!scrollStale)
      return;
    scrollStale = false;
    scrollTop = window.scrollY;
    scrollLeft = window.scrollX;
  }
  const applyShared = (program, light, skySpan) => {
    const padX = 24;
    const padY = 10;
    const feather = 64;
    return program.vec4("uVeil", (veil.left - padX) / cssWidth, 1 - (veil.bottom + padY) / cssHeight, (veil.right + padX) / cssWidth, 1 - (veil.top - padY) / cssHeight).vec2("uVeilFeather", feather / cssWidth, feather / cssHeight).vec2("uTargetSize", targets?.width ?? 1, targets?.height ?? 1).vec3("uSunDir", light.sunDir).vec3("uKeyDir", light.keyDir).vec3("uKeyColor", light.keyColor).float("uKeyElev", light.keyElevation).vec4("uShadowMix", ...light.shadowMix).vec3("uMoonDir", light.moonDir).vec3("uCamPos", eye).vec3("uSkyHorizon", light.skyHorizon).vec3("uSkyLow", light.skyLow).vec3("uSkyMid", light.skyMid).vec3("uSkyTop", light.skyTop).vec3("uGlow", light.glow).float("uSkySpan", skySpan).float("uAmbient", light.ambient).float("uHaze", light.haze).float("uMist", light.mist).float("uNight", light.night).float("uTime", windTime);
  };
  const render = (now, dt) => {
    if (!gpu || !targets)
      return;
    const g = gpu;
    const t = targets;
    const { programs } = g;
    const { width, height } = canvas;
    const aspect = width / height;
    const dpr = width / cssWidth;
    updateDay(now, dt);
    readScroll();
    const scroll = reducedMotion ? 0 : Math.min(1, Math.max(0, scrollTop / cssHeight));
    if (!pointer.drag) {
      const follow = 1 - Math.exp(-dt * 2.4);
      const hovering = !reducedMotion && pointer.active && !pointer.touch;
      const targetX = Math.max(-1, Math.min(1, hovering ? pointer.x / cssWidth * 2 - 1 : 0));
      const targetY = Math.max(-1, Math.min(1, hovering ? 1 - pointer.y / cssHeight * 2 : 0));
      look.x += (targetX - look.x) * follow;
      look.y += (targetY - look.y) * follow;
      look.settled = Math.abs(targetX - look.x) + Math.abs(targetY - look.y) < 0.03;
    }
    eye = [look.x * 0.34, CAMERA_HEIGHT + look.y * 0.07 + scroll * 0.85, -scroll * 0.6];
    const yaw = framing.yaw - look.x * degrees3(1.1);
    const pitch = framing.pitch + look.y * degrees3(0.7) - scroll * degrees3(4);
    perspective(framing.verticalFov, aspect, 0.2, 40000, projection);
    viewProj = multiply(projection, lookFrom(eye, yaw, pitch, view), viewProjection);
    const inverseViewProj = invert(viewProj, inverseViewProjection);
    const tanHalfV = Math.tan(framing.verticalFov / 2);
    const area = grassArea(aspect);
    const { p, moon } = dayAt(day.c);
    const light = daylightAt(p, framing, moon);
    const skySpan = Math.max(0.15, Math.sin(pitch + framing.verticalFov / 2));
    const pixelAngle = 2 * tanHalfV / t.height;
    const sunPoint = projectDirection(light.sunDir);
    const moonPoint = projectDirection(light.moonDir);
    bodies.radius = framing.sunRadius / tanHalfV * cssHeight / 2;
    bodies.sun.x = sunPoint ? sunPoint.x : -999;
    bodies.sun.y = sunPoint ? sunPoint.y : -999;
    bodies.sun.up = !!sunPoint && sunSeen && light.sunElevation > BODY_UP && light.night < 0.6;
    bodies.moon.x = moonPoint ? moonPoint.x : -999;
    bodies.moon.y = moonPoint ? moonPoint.y : -999;
    bodies.moon.up = !!moonPoint && moonSeen && light.moonElevation > BODY_UP && light.night > 0.3;
    const grassEdge = project(0, 0, GRASS_FAR * 0.75);
    grassTopCss = grassEdge ? grassEdge.y : cssHeight * 0.7;
    if (tonesFromScene) {
      tones.fallback(light.night > SKY_DARK_NIGHT ? "dark" : "light");
      tones.ease(reducedMotion ? Infinity : dt);
    }
    if (hint)
      placeHint(now);
    if (!reducedMotion) {
      const touch = { u: 0, v: 0, active: false };
      if (pointer.active && !pointer.drag) {
        const ndcX = pointer.x / cssWidth * 2 - 1;
        const ndcY = 1 - pointer.y / cssHeight * 2;
        const near = transformPoint(inverseViewProj, ndcX, ndcY, -1);
        const far = transformPoint(inverseViewProj, ndcX, ndcY, 1);
        const dirY = far[1] - near[1];
        if (dirY < 0) {
          const along = (0.24 - near[1]) / dirY;
          const hitX = near[0] + (far[0] - near[0]) * along;
          const hitZ = near[2] + (far[2] - near[2]) * along;
          if (hitZ > area.near * 0.6 && hitZ < area.far) {
            touch.u = (hitX / (area.rootWidth + hitZ * area.slope) + 1) / 2;
            touch.v = (1 / hitZ - 1 / area.near) / (1 / area.far - 1 / area.near);
            touch.active = touch.u > -0.2 && touch.u < 1.2;
          }
        }
      }
      const focal = cssHeight / 2 / tanHalfV;
      const pointerSpeed = dt > 0 ? Math.hypot(pointer.x - pointer.lastX, pointer.y - pointer.lastY) / dt : 0;
      pointer.lastX = pointer.x;
      pointer.lastY = pointer.y;
      if (touch.active)
        particles.sparkle(Math.min(dt, 1 / 30), pointer.x, pointer.y, pointerSpeed, light.night);
      const brushWidth = cssWidth * area.slope / (tanHalfV * aspect);
      const brushHeight = focal * (CAMERA_HEIGHT - 0.24) * (1 / area.near - 1 / area.far);
      const step = Math.min(dt, 1 / 30);
      const substeps = Math.min(4, Math.max(1, Math.ceil(dt * 60 - 0.01)));
      if (touch.active || !brush.resting) {
        for (let i = 0;i < substeps; i++)
          brush.step(Math.min(dt, 1 / 15) / substeps, touch, brushWidth, brushHeight, tier.brushRadius);
      }
      if (!brush.resting || !brushUploaded) {
        gl.bindTexture(gl.TEXTURE_2D, g.brushTex);
        gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, BRUSH_COLUMNS, BRUSH_ROWS, gl.RGBA, gl.FLOAT, brush.field);
        brushUploaded = brush.resting;
      }
      const smearing = pointer.active && !pointer.drag;
      if (smearing || !wet.settled)
        wet.step(step, { x: pointer.x, y: pointer.y, active: smearing }, cssWidth, cssHeight, tier.phone ? 70 : 90);
      if (!wet.settled || !smearUploaded) {
        gl.bindTexture(gl.TEXTURE_2D, g.smearTex);
        gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, SMEAR_COLUMNS, SMEAR_ROWS, gl.RG, gl.FLOAT, wet.field);
        smearUploaded = wet.settled;
      }
      particles.step(step, light.night, { x: pointer.x, y: pointer.y, active: pointer.active });
    } else if (!brushUploaded) {
      gl.bindTexture(gl.TEXTURE_2D, g.brushTex);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, BRUSH_COLUMNS, BRUSH_ROWS, gl.RGBA, gl.FLOAT, brush.field);
      gl.bindTexture(gl.TEXTURE_2D, g.smearTex);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, SMEAR_COLUMNS, SMEAR_ROWS, gl.RG, gl.FLOAT, wet.field);
      brushUploaded = true;
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, t.sceneFramebuffer);
    gl.viewport(0, 0, t.width, t.height);
    gl.disable(gl.BLEND);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LESS);
    gl.depthMask(true);
    gl.clearDepth(1);
    gl.clear(gl.DEPTH_BUFFER_BIT);
    const bandHeight = Math.min(t.height * 0.7, t.height / 2 / tanHalfV * CAMERA_HEIGHT * (1 / area.near - 1 / area.far) * 0.45);
    const columns = Math.max(8, Math.round(Math.sqrt(tier.blades * t.width / Math.max(1, bandHeight))));
    const bladeCount = tier.phone ? tier.blades : tier.blades * Math.min(1.3, Math.max(0.5, cssWidth * cssHeight / (1440 * 900)));
    const rows = Math.max(8, Math.round(bladeCount / columns));
    bindTexture(gl, 0, g.brushTex);
    bindTexture(gl, 1, g.horizonTex);
    applyShared(programs.grass.use(), light, skySpan).mat4("uViewProj", viewProj).vec2("uGrid", columns, rows).vec4("uGrassArea", area.near, area.far, area.rootWidth, area.slope).float("uWind", windOn ? 1 : 0).vec2("uWindDir", WIND_DIR[0], WIND_DIR[1]).float("uPixelAngle", pixelAngle).int("uBrushTex", 0).int("uHorizonTex", 1);
    gl.bindVertexArray(g.grassVao);
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, GRASS_SEGMENTS * 2 + 1, columns * rows);
    bindTexture(gl, 0, g.heightTex);
    bindTexture(gl, 1, g.materialTex);
    bindTexture(gl, 2, g.auxTex);
    bindTexture(gl, 3, g.horizonTex);
    applyShared(programs.terrain.use(), light, skySpan).mat4("uViewProj", viewProj).int("uHeightTex", 0).int("uMaterialTex", 1).int("uAuxTex", 2).int("uHorizonTex", 3).float("uGrassFar", area.far).float("uHillScale", framing.hillScale);
    gl.bindVertexArray(g.terrainVao);
    gl.drawElements(gl.TRIANGLE_STRIP, g.terrainIndexCount, gl.UNSIGNED_INT, 0);
    gl.depthFunc(gl.LEQUAL);
    gl.depthMask(false);
    gl.bindVertexArray(g.emptyVao);
    applyShared(programs.sky.use(), light, skySpan).mat4("uInvViewProj", inverseViewProj).float("uSunRadius", framing.sunRadius).vec2("uSunNdc", sunPoint ? sunPoint.ndcX : 0, sunPoint ? sunPoint.ndcY : 2).float("uSunDiscNdc", bodies.radius / (cssHeight / 2)).float("uAspect", aspect);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.depthMask(true);
    gl.disable(gl.DEPTH_TEST);
    gl.bindFramebuffer(gl.FRAMEBUFFER, t.paintFramebuffer);
    bindTexture(gl, 0, t.sceneColor);
    bindTexture(gl, 1, t.sceneFlow);
    programs.paint.use().int("uScene", 0).int("uFlow", 1).vec2("uTexel", 1 / t.width, 1 / t.height).float("uRadius", 2.3 * (t.width / cssWidth));
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    captureProbe(now, t);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, width, height);
    bindTexture(gl, 0, t.paint);
    bindTexture(gl, 1, t.sceneFlow);
    bindTexture(gl, 2, g.smearTex);
    bindTexture(gl, 3, g.horizonTex);
    const moonShare = Math.min(1, Math.max(0, (light.night - 0.35) / 0.3));
    const handover = moonShare * moonShare * (3 - 2 * moonShare);
    const angleToward = (point) => point ? Math.atan2(cssHeight / 2 - point.y, point.x - cssWidth / 2) : Math.PI / 2;
    const sunAngle = angleToward(sunPoint);
    const turn = Math.atan2(Math.sin(angleToward(moonPoint) - sunAngle), Math.cos(angleToward(moonPoint) - sunAngle));
    const lightAngle = sunAngle + turn * handover;
    const lightDir = [Math.cos(lightAngle) * 0.62, Math.sin(lightAngle) * 0.62, 0.78];
    const specColor = [mix2(1, 0.45, handover), mix2(0.9, 0.55, handover), mix2(0.72, 0.75, handover)];
    applyShared(programs.final.use(), light, skySpan).int("uPaint", 0).int("uFlow", 1).int("uSmear", 2).int("uHorizonTex", 3).vec2("uResolution", width, height).float("uDpr", dpr).vec3("uLight", lightDir).vec3("uSpecColor", specColor).vec2("uSunPx", bodies.sun.x * dpr, (cssHeight - bodies.sun.y) * dpr).vec2("uMoonPx", moonPoint ? moonPoint.x * dpr : -9999, moonPoint ? (cssHeight - moonPoint.y) * dpr : -9999).float("uSunRadiusPx", bodies.radius * dpr).float("uRelief", 1.5 * Math.min(1, Math.max(0.55, dpr / 2)));
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    if (!reducedMotion) {
      const count = particles.fill(dpr, light.night, fireflyShade);
      if (count > 0) {
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
        gl.bindVertexArray(g.particleVao);
        gl.bindBuffer(gl.ARRAY_BUFFER, g.particleBuffer);
        gl.bufferSubData(gl.ARRAY_BUFFER, 0, particles.data, 0, count * PARTICLE_STRIDE / 4);
        programs.particles.use().vec2("uResolution", width, height);
        gl.drawArrays(gl.POINTS, 0, count);
        gl.disable(gl.BLEND);
      }
    }
    gl.bindVertexArray(null);
    if (!firstFrameSent) {
      firstFrameSent = true;
      canvas.dataset.meadow = "ready";
      options.onFirstFrame();
    }
  };
  const frame = (now) => {
    raf = 0;
    if (lost || phase === "failed")
      return;
    try {
      if (phase === "compile") {
        if (batch?.ready) {
          const programs = batch.finish();
          batch = null;
          gpu = buildGpu(programs);
          phase = "bake";
          bakeStrip = 0;
        }
      } else if (phase === "bake" && gpu) {
        if (bakeStep(gpu)) {
          phase = "live";
          lastNow = now;
        }
      } else if (phase === "live") {
        readProbe();
        const busy = isBusy(now);
        const dt = Math.min(0.1, Math.max(0, (now - lastNow) / 1000));
        lastNow = now;
        if (windOn && firstFrameSent)
          windTime += dt;
        ensureSize();
        const started = performance.now();
        render(now, dt);
        needsRender = false;
        lastRenderAt = now;
        if (busy && previousFrameBusy)
          trackCost(dt, performance.now() - started);
        previousFrameBusy = busy;
      }
    } catch (error) {
      fail(error);
      return;
    }
    schedule();
  };
  const trackCost = (dt, cpuMs) => {
    if (reducedMotion || dt <= 0)
      return;
    frameCost = frameCost === 0 ? dt * 1000 : frameCost * 0.94 + dt * 1000 * 0.06;
    framesSinceScale++;
    if (framesSinceScale > 240 && frameCost > 24 && renderScale > 0.6 && cpuMs < 12) {
      renderScale *= 0.85;
      framesSinceScale = 0;
      frameCost = 0;
    }
  };
  const pause = () => {
    paused = true;
    previousFrameBusy = false;
  };
  const schedule = () => {
    if (raf || ambientTimer || lost || phase === "failed")
      return;
    if (document.hidden)
      return pause();
    if (phase === "live") {
      if (!heroVisible)
        return pause();
      const now = performance.now();
      if (!isBusy(now)) {
        if (reducedMotion)
          return pause();
        const wait = lastRenderAt + AMBIENT_FRAME_MS - now - 6;
        if (wait > 0) {
          previousFrameBusy = false;
          ambientTimer = window.setTimeout(() => {
            ambientTimer = 0;
            schedule();
          }, wait);
          return;
        }
      }
    }
    raf = requestAnimationFrame(frame);
  };
  function wake() {
    if (paused) {
      paused = false;
      lastNow = performance.now();
    }
    if (ambientTimer) {
      clearTimeout(ambientTimer);
      ambientTimer = 0;
    }
    schedule();
  }
  const markActive = () => {
    activeUntil = performance.now() + ACTIVE_HOLD_MS;
    wake();
  };
  const placeHint = (now) => {
    if (!hint)
      return;
    const body = bodies.sun.up ? "sun" : bodies.moon.up ? "moon" : null;
    const settledIn = reducedMotion || sunriseElapsed(now) > SUNRISE_HOLD_MS + DAY_MOVE_MS + 500;
    const ready = !hasDragged && body !== null && (day.mode === "cycle" || day.mode === "rest") && settledIn;
    if (ready && body !== hintBody) {
      hintBody = body;
      hint.textContent = `Drag the ${body}`;
      hintWidth = hint.offsetWidth;
    }
    const point = body ? bodies[body] : null;
    const show = ready && !!point && point.x > 0 && point.x < cssWidth;
    hint.classList.toggle("is-shown", show);
    if (!show || !point)
      return;
    const radius = body === "moon" ? bodies.radius * 0.8 : bodies.radius;
    const roomRight = point.x + radius + 24 + hintWidth < cssWidth;
    const hintX = roomRight ? point.x + radius + 14 : point.x - radius - 14 - hintWidth;
    const side = roomRight ? "right" : "left";
    const transform = `translate(${Math.round(hintX)}px, ${Math.round(point.y - 7)}px)`;
    if (hint.dataset.side !== side)
      hint.dataset.side = side;
    if (transform !== hintTransform) {
      hintTransform = transform;
      hint.style.transform = transform;
    }
  };
  const localPoint = (clientX, clientY) => {
    readScroll();
    return { x: clientX - (heroDocLeft - scrollLeft), y: clientY - (heroDocTop - scrollTop) };
  };
  const isInteractive = (target) => target instanceof Element && !!target.closest(INTERACTIVE);
  const isTap = (x, y) => Math.hypot(x - pointer.downX, y - pointer.downY) < 10 && performance.now() - pointer.downAt < 400;
  const nightNow = () => {
    const { p, moon } = dayAt(day.c);
    return daylightAt(p, framing, moon).night;
  };
  const inHero = (x, y) => y >= 0 && y <= cssHeight && x >= 0 && x <= cssWidth;
  const onPointerDown = (event) => {
    if (event.pointerType === "touch" || event.button !== 0 || isInteractive(event.target))
      return;
    const { x, y } = localPoint(event.clientX, event.clientY);
    if (!inHero(x, y))
      return;
    Object.assign(pointer, { x, y, active: true, touch: false, down: true, downX: x, downY: y, downAt: performance.now() });
    const body = hitBody(x, y);
    if (body) {
      event.preventDefault();
      startDrag(body);
    }
    markActive();
  };
  const onPointerMove = (event) => {
    if (event.pointerType === "touch")
      return;
    const { x, y } = localPoint(event.clientX, event.clientY);
    const inside = inHero(x, y);
    const wasActive = pointer.active;
    Object.assign(pointer, { x, y, active: inside, touch: false });
    if (pointer.drag) {
      day.target = nearestCycle(x, y, pointer.drag);
      markActive();
      return;
    }
    if (inside || wasActive)
      markActive();
    if (!inside || isInteractive(event.target))
      setCursor("");
    else if (hitBody(x, y))
      setCursor("grab");
    else if (!reducedMotion && y > grassTopCss)
      setCursor("brush");
    else
      setCursor("");
  };
  const onPointerUp = (event) => {
    if (event.pointerType === "touch")
      return;
    const { x, y } = localPoint(event.clientX, event.clientY);
    if (pointer.drag)
      release(x, y);
    else if (!reducedMotion && pointer.down && isTap(x, y) && !isInteractive(event.target))
      particles.burst(x, y, nightNow());
    pointer.down = false;
    markActive();
  };
  const onPointerLeave = () => {
    pointer.active = false;
    if (pointer.drag)
      release(pointer.x, pointer.y);
    setCursor("");
    markActive();
  };
  const onTouchStart = (event) => {
    const touch = event.touches[0];
    if (!touch || event.touches.length > 1)
      return;
    const { x, y } = localPoint(touch.clientX, touch.clientY);
    Object.assign(pointer, { x, y, active: true, touch: true, down: true, downX: x, downY: y, downAt: performance.now() });
    markActive();
    if (isInteractive(event.target))
      return;
    const body = hitBody(x, y);
    if (body) {
      event.preventDefault();
      startDrag(body);
    } else if (!reducedMotion && y > grassTopCss) {
      hero.dataset.brushing = "";
    }
  };
  const onTouchMove = (event) => {
    const touch = event.touches[0];
    if (!touch)
      return;
    const { x, y } = localPoint(touch.clientX, touch.clientY);
    Object.assign(pointer, { x, y, active: true, touch: true });
    markActive();
    if (pointer.drag) {
      event.preventDefault();
      day.target = nearestCycle(x, y, pointer.drag);
    }
  };
  const onTouchEnd = (event) => {
    delete hero.dataset.brushing;
    if (pointer.drag)
      release(pointer.x, pointer.y);
    else if (!reducedMotion && pointer.down && isTap(pointer.x, pointer.y) && !isInteractive(event.target))
      particles.burst(pointer.x, pointer.y, nightNow());
    pointer.down = false;
    pointer.active = false;
    markActive();
  };
  const onScroll = () => {
    scrollStale = true;
    if (!reducedMotion && heroVisible)
      markActive();
  };
  const onVisibility = () => {
    if (!document.hidden)
      return wake();
    cancelAnimationFrame(raf);
    raf = 0;
    clearTimeout(ambientTimer);
    ambientTimer = 0;
    pause();
  };
  const onLost = (event) => {
    event.preventDefault();
    lost = true;
    cancelAnimationFrame(raf);
    raf = 0;
    clearTimeout(ambientTimer);
    ambientTimer = 0;
    gpu = null;
    targets = null;
    batch = null;
  };
  const onRestored = () => {
    lost = false;
    bakeStrip = 0;
    brushUploaded = false;
    smearUploaded = false;
    needsRender = true;
    startCompile();
    wake();
  };
  const textBlock = hero.querySelector(".hero-text");
  const lede = hero.querySelector(".lede");
  const untransformedBox = (element) => {
    let left = 0;
    let top = 0;
    let node = element;
    while (node && node !== hero) {
      left += node.offsetLeft;
      top += node.offsetTop;
      node = node.offsetParent;
    }
    return { left, top, right: left + element.offsetWidth, bottom: top + element.offsetHeight };
  };
  const measureHero = () => {
    const rect = hero.getBoundingClientRect();
    scrollTop = window.scrollY;
    scrollLeft = window.scrollX;
    heroDocTop = rect.top + scrollTop;
    heroDocLeft = rect.left + scrollLeft;
    cssWidth = Math.max(1, canvas.clientWidth);
    cssHeight = Math.max(1, canvas.clientHeight);
  };
  const measureText = () => {
    const heroHeight = canvas.offsetHeight;
    if (!textBlock || heroHeight <= 0)
      return;
    const veiled = [lede].filter((element) => !!element?.offsetParent).map(untransformedBox);
    if (veiled.length) {
      veil.left = Math.min(...veiled.map((box) => box.left));
      veil.top = Math.min(...veiled.map((box) => box.top));
      veil.right = Math.max(...veiled.map((box) => box.right));
      veil.bottom = Math.max(...veiled.map((box) => box.bottom));
    }
    tones.measure(heroDocTop);
    const shareRow = textBlock.querySelector(".send-more");
    const clearEdge = shareRow?.offsetParent ? untransformedBox(shareRow).bottom - SHARE_ROW_SLACK : untransformedBox(textBlock).bottom;
    const firstScreen = Math.min(heroHeight, window.innerHeight - Math.max(0, heroDocTop));
    const next = { clear: clearEdge / heroHeight, horizon: firstScreen * STACKED_HORIZON_SCREEN / heroHeight };
    if (Math.abs(next.clear - stack.clear) < 0.002 && Math.abs(next.horizon - stack.horizon) < 0.002)
      return;
    stack = next;
    framing = framingFor(canvas.width / Math.max(1, canvas.height), stack.clear, stack.horizon);
  };
  const resizeObserver = new ResizeObserver(() => {
    measureHero();
    measureText();
    needsRender = true;
    wake();
  });
  const visibilityObserver = new IntersectionObserver((entries) => {
    heroVisible = entries.some((entry) => entry.isIntersecting);
    if (heroVisible)
      wake();
  });
  canvas.addEventListener("webglcontextlost", onLost);
  canvas.addEventListener("webglcontextrestored", onRestored);
  document.addEventListener("visibilitychange", onVisibility);
  resizeObserver.observe(canvas);
  if (textBlock)
    resizeObserver.observe(textBlock);
  visibilityObserver.observe(hero);
  const listeners = [
    [window, "scroll", onScroll, { passive: true }],
    [window, "pointerdown", onPointerDown, { passive: false }],
    [window, "pointermove", onPointerMove, { passive: true }],
    [window, "pointerup", onPointerUp, { passive: true }],
    [window, "blur", onPointerLeave, { passive: true }],
    [document.documentElement, "pointerleave", onPointerLeave, { passive: true }],
    [hero, "touchstart", onTouchStart, { passive: false }],
    [hero, "touchmove", onTouchMove, { passive: false }],
    [hero, "touchend", onTouchEnd, { passive: true }],
    [hero, "touchcancel", onTouchEnd, { passive: true }]
  ];
  for (const [target, type, listener, opts] of listeners)
    target.addEventListener(type, listener, opts);
  measureHero();
  startCompile();
  wake();
  return {
    dispose() {
      cancelAnimationFrame(raf);
      raf = 0;
      clearTimeout(ambientTimer);
      ambientTimer = 0;
      phase = "failed";
      resizeObserver.disconnect();
      visibilityObserver.disconnect();
      canvas.removeEventListener("webglcontextlost", onLost);
      canvas.removeEventListener("webglcontextrestored", onRestored);
      document.removeEventListener("visibilitychange", onVisibility);
      for (const [target, type, listener] of listeners)
        target.removeEventListener(type, listener);
      delete hero.dataset.brushing;
      tones.reset();
      releaseTargets();
    }
  };
}

// src/index.ts
function createPainterlySky(opts) {
  const { hero } = opts;
  const canvas = opts.canvas ?? hero.querySelector("[data-meadow-canvas]");
  if (!canvas || !("WebGL2RenderingContext" in window))
    return null;
  return createMeadow({
    canvas,
    hero,
    hint: opts.hint ?? hero.querySelector("[data-sun-hint]"),
    reducedMotion: matchMedia("(prefers-reduced-motion: reduce)").matches,
    onFirstFrame() {
      requestAnimationFrame(() => requestAnimationFrame(() => {
        hero.dataset.meadow = "ready";
        startSunrise(hero);
      }));
    }
  });
}
export {
  createPainterlySky
};
