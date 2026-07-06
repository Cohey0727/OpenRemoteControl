#!/usr/bin/env bun
/**
 * Rasterise `ui/icon.svg` into the PNG sizes the PWA manifest, the
 * iOS home-screen icon, and the service-worker badge need.
 *
 * IMPORTANT: this is NOT a UI build step. `open-rc serve` serves the
 * PNGs straight off disk; you only run this script when the SVG
 * changes and you want to refresh the PNGs that ship in the repo.
 * The image colors and layout live in the SVG (one source of truth);
 * the PNGs are an artefact.
 *
 * Outputs (written next to the SVG, into `ui/`):
 *   - ui/icon-192.png         — manifest 192×192
 *   - ui/icon-512.png         — manifest 512×512
 *   - ui/icon-maskable-512.png — adaptive launcher, with safe-zone
 *                                 padding so the mark survives circle
 *                                 and squircle masks
 *   - ui/apple-touch-icon.png  — 180×180, used by iOS Safari when the
 *                                 user pins the PWA to the home screen
 *
 * Run:
 *   bun run build-icons
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { Resvg } from '@resvg/resvg-js';

interface Target {
  out: string;
  size: number;
  /** When true, add a neutral background-safe padding before the
   *  rasters, so the mark stays inside the masked safe-zone of an
   *  adaptive launcher (typically the inner 80% of the canvas). */
  padForMaskable: boolean;
}

const projectRoot = new URL('..', import.meta.url).pathname;
// Static PWA assets live in ui/public/ (Vite copies them verbatim into
// ui/dist/). icon.svg is the source of truth; the PNGs sit beside it.
const uiDir = join(projectRoot, 'ui', 'public');
const svgPath = join(uiDir, 'icon.svg');

const TARGETS: Target[] = [
  { out: 'icon-192.png', size: 192, padForMaskable: false },
  { out: 'icon-512.png', size: 512, padForMaskable: false },
  { out: 'icon-maskable-512.png', size: 512, padForMaskable: true },
  { out: 'apple-touch-icon.png', size: 180, padForMaskable: false },
];

function buildPaddedSvg(svgSource: string): string {
  // Maskable icons are FULL-BLEED: the launcher applies its own circle
  // or squircle mask, so the background must cover the entire canvas
  // (transparent corners would read as holes) and every meaningful
  // element must sit inside the central safe-zone circle — radius 40%
  // of the canvas per the W3C maskable spec. The mark's outer client
  // dots reach ~0.37 of the width from centre, so scaling the whole
  // tile to 88% keeps them (dot radius included) inside that circle,
  // and the bleed around it is painted with the same tile surface
  // colour so the seam is invisible.
  const size = 512;
  const scale = 0.88;
  const inner = Math.round(size * scale);
  const offset = Math.round((size - inner) / 2);
  // Nest the whole source SVG (its own viewBox intact) into a smaller
  // centred box instead of string-patching its opening tag — nested
  // <svg x y width height> scales reliably and keeps namespaces.
  const body = svgSource.replace(/<\?xml[^>]*\?>/, '').replace(/<!--[\s\S]*?-->/g, '');
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}">`,
    `  <rect x="0" y="0" width="${size}" height="${size}" fill="#16181d"/>`,
    `  <svg x="${offset}" y="${offset}" width="${inner}" height="${inner}">${body}</svg>`,
    '</svg>',
  ].join('\n');
}

async function main(): Promise<void> {
  mkdirSync(uiDir, { recursive: true });
  const svg = readFileSync(svgPath, 'utf8');
  for (const t of TARGETS) {
    const source = t.padForMaskable ? buildPaddedSvg(svg) : svg;
    const resvg = new Resvg(source, {
      fitTo: { mode: 'width', value: t.size },
      // No background fill — the inner SVG paints its own dark
      // rounded-tile background, which gives the icon a uniform
      // surface on every platform.
      background: 'transparent',
    });
    const png = resvg.render().asPng();
    const outPath = join(uiDir, t.out);
    writeFileSync(outPath, png);
    console.log(`→ ${outPath} (${t.size}×${t.size}, ${png.byteLength} B)`);
  }
  console.log(`\n✓ wrote ${TARGETS.length} PNG(s) to ${uiDir}`);
}

await main();
