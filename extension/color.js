// Color analysis and sorting. Pure functions, no DOM or chrome.* access,
// so the same file runs in the content script and under `node --test`.
(function (root) {
  'use strict';

  const K = 5;                 // clusters per image
  const ITERATIONS = 10;
  const NEUTRAL_CHROMA = 0.035; // below this the dominant color reads as gray
  const HUE_START = 15;        // degrees; spectrum begins just before red
  const HUE_BIN = 15;          // degrees per band in the spectrum sort

  function linear(c) {
    c /= 255;
    return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  }

  // sRGB 0..255 -> OKLab
  function rgbToOklab(r, g, b) {
    const lr = linear(r), lg = linear(g), lb = linear(b);
    const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
    const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
    const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);
    return [
      0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s,
      1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s,
      0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s,
    ];
  }

  function labToLch(L, a, b) {
    const C = Math.hypot(a, b);
    let h = (Math.atan2(b, a) * 180) / Math.PI;
    if (h < 0) h += 360;
    return { L, C, h };
  }

  function dist2(p, q) {
    const d0 = p[0] - q[0], d1 = p[1] - q[1], d2 = p[2] - q[2];
    return d0 * d0 + d1 * d1 + d2 * d2;
  }

  // pixels: Uint8ClampedArray RGBA (canvas ImageData.data).
  // Returns null when the image has no opaque pixels.
  function analyzePixels(pixels) {
    const lab = [], rgb = [];
    for (let i = 0; i < pixels.length; i += 4) {
      if (pixels[i + 3] < 128) continue;
      rgb.push([pixels[i], pixels[i + 1], pixels[i + 2]]);
      lab.push(rgbToOklab(pixels[i], pixels[i + 1], pixels[i + 2]));
    }
    const n = lab.length;
    if (!n) return null;

    // Deterministic farthest-point seeding: start at the mean, then keep
    // taking the pixel farthest from every chosen center.
    const mean = [0, 0, 0];
    for (const p of lab) { mean[0] += p[0] / n; mean[1] += p[1] / n; mean[2] += p[2] / n; }
    const centers = [mean];
    const nearest = lab.map((p) => dist2(p, mean));
    while (centers.length < Math.min(K, n)) {
      let best = 0;
      for (let i = 1; i < n; i++) if (nearest[i] > nearest[best]) best = i;
      if (nearest[best] === 0) break; // fewer distinct colors than K
      centers.push(lab[best].slice());
      for (let i = 0; i < n; i++) nearest[i] = Math.min(nearest[i], dist2(lab[i], lab[best]));
    }

    const assign = new Int32Array(n);
    for (let it = 0; it < ITERATIONS; it++) {
      for (let i = 0; i < n; i++) {
        let bi = 0, bd = Infinity;
        for (let c = 0; c < centers.length; c++) {
          const d = dist2(lab[i], centers[c]);
          if (d < bd) { bd = d; bi = c; }
        }
        assign[i] = bi;
      }
      const sums = centers.map(() => [0, 0, 0, 0]);
      for (let i = 0; i < n; i++) {
        const s = sums[assign[i]];
        s[0] += lab[i][0]; s[1] += lab[i][1]; s[2] += lab[i][2]; s[3]++;
      }
      sums.forEach((s, c) => { if (s[3]) centers[c] = [s[0] / s[3], s[1] / s[3], s[2] / s[3]]; });
    }

    const clusters = centers.map(() => ({ count: 0, r: 0, g: 0, b: 0 }));
    for (let i = 0; i < n; i++) {
      const cl = clusters[assign[i]];
      cl.count++; cl.r += rgb[i][0]; cl.g += rgb[i][1]; cl.b += rgb[i][2];
    }

    const palette = [];
    clusters.forEach((cl, c) => {
      if (!cl.count) return;
      const lch = labToLch(...centers[c]);
      palette.push({
        rgb: [Math.round(cl.r / cl.count), Math.round(cl.g / cl.count), Math.round(cl.b / cl.count)],
        weight: cl.count / n,
        L: lch.L, C: lch.C, h: lch.h,
      });
    });
    palette.sort((p, q) => q.weight - p.weight);

    // The dominant color is the one you notice: area matters, but a saturated
    // patch outranks a slightly larger expanse of gray or white.
    let dominant = palette[0], bestScore = -1;
    for (const p of palette) {
      const score = p.weight * (0.04 + p.C);
      if (score > bestScore) { bestScore = score; dominant = p; }
    }

    let avgL = 0;
    for (const p of palette) avgL += p.weight * p.L;

    return {
      rgb: dominant.rgb,
      avgL,
      L: dominant.L, C: dominant.C, h: dominant.h,
      neutral: dominant.C < NEUTRAL_CHROMA,
      palette: palette.map((p) => ({ rgb: p.rgb, weight: +p.weight.toFixed(3) })),
    };
  }

  function hueFromStart(h) {
    return (h - HUE_START + 360) % 360;
  }

  // items: [{ color: analyzePixels result | null, ... }]
  // mode: 'spectrum' | 'light' | 'vivid'. Returns a new array.
  // Items without color (text blocks, nested channels, failed images) keep
  // their relative order and always go last.
  function sortItems(items, mode, reverse) {
    const colored = items.filter((it) => it.color);
    const rest = items.filter((it) => !it.color);
    let sorted;

    if (mode === 'light') {
      // Whole-image lightness reads better here than the dominant color's.
      const light = (it) => (it.color.avgL != null ? it.color.avgL : it.color.L);
      sorted = colored.slice().sort((a, b) => light(b) - light(a));
    } else if (mode === 'vivid') {
      sorted = colored.slice().sort((a, b) => b.color.C - a.color.C || b.color.L - a.color.L);
    } else {
      // Spectrum: chromatic blocks in hue bands, snaking light->dark then
      // dark->light so neighbouring bands meet at similar lightness. Neutrals
      // follow, white to black.
      const chroma = colored.filter((it) => !it.color.neutral);
      const neutral = colored.filter((it) => it.color.neutral);
      const band = (it) => Math.floor(hueFromStart(it.color.h) / HUE_BIN);
      chroma.sort((a, b) => {
        const ba = band(a), bb = band(b);
        if (ba !== bb) return ba - bb;
        const dir = ba % 2 === 0 ? -1 : 1;
        return dir * (a.color.L - b.color.L) || hueFromStart(a.color.h) - hueFromStart(b.color.h);
      });
      neutral.sort((a, b) => b.color.L - a.color.L);
      sorted = chroma.concat(neutral);
    }

    if (reverse) sorted.reverse();
    return sorted.concat(rest);
  }

  // images.are.na URLs are a base64 JSON edit request. Rewriting the resize
  // asks the CDN for a 32px thumbnail instead of a 400px one.
  function tinyImageUrl(src, size) {
    size = size || 32;
    try {
      const u = new URL(src);
      if (u.hostname !== 'images.are.na') return null;
      const payload = JSON.parse(atob(decodeURIComponent(u.pathname.slice(1))));
      if (!payload.bucket || !payload.key) return null;
      payload.edits = {
        resize: { width: size, height: size, fit: 'fill' },
        jpeg: { quality: 80 },
      };
      return 'https://images.are.na/' + btoa(JSON.stringify(payload));
    } catch (_) {
      return null;
    }
  }

  const api = { rgbToOklab, labToLch, analyzePixels, sortItems, tinyImageUrl, NEUTRAL_CHROMA };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.ArenaColor = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
