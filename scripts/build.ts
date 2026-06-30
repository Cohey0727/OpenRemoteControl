#!/usr/bin/env bun
/**
 * Cross-compile open-rc into standalone executables for the major
 * desktop platforms. Each output is a single binary that bundles Bun
 * plus our source code — no `node_modules`, no Bun install required
 * on the target.
 *
 * Targets:
 *   - linux-x64
 *   - linux-arm64
 *   - darwin-x64
 *   - darwin-arm64
 *   - windows-x64
 *
 * Output:
 *   dist/open-rc-<os>-<arch>[.exe]
 *
 * Run:
 *   bun run build           # build current platform only
 *   bun run build --all     # build all five targets
 */

import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

interface Target {
  os: 'linux' | 'darwin' | 'windows';
  arch: 'x64' | 'arm64';
  bunTarget: string;
  ext: string;
}

const TARGETS: Target[] = [
  { os: 'linux', arch: 'x64', bunTarget: 'bun-linux-x64', ext: '' },
  { os: 'linux', arch: 'arm64', bunTarget: 'bun-linux-aarch64', ext: '' },
  { os: 'darwin', arch: 'x64', bunTarget: 'bun-darwin-x64', ext: '' },
  { os: 'darwin', arch: 'arm64', bunTarget: 'bun-darwin-aarch64', ext: '' },
  { os: 'windows', arch: 'x64', bunTarget: 'bun-windows-x64', ext: '.exe' },
];

const projectRoot = new URL('..', import.meta.url).pathname;
const distDir = join(projectRoot, 'dist');
const entrypoint = join(projectRoot, 'src', 'cli.ts');

const args = process.argv.slice(2);
const buildAll = args.includes('--all');
const currentPlatform = `${process.platform}-${process.arch}` as `${NodeJS.Platform}-${string}`;

function pickTargets(): Target[] {
  if (buildAll) return TARGETS;
  // Default: build the target matching the current host only.
  const match = TARGETS.find((t) => `${t.os}-${t.arch}` === currentPlatform);
  if (!match) {
    throw new Error(`no build target matches host ${currentPlatform}`);
  }
  return [match];
}

async function main(): Promise<void> {
  const targets = pickTargets();
  rmSync(distDir, { recursive: true, force: true });
  mkdirSync(distDir, { recursive: true });

  for (const t of targets) {
    const outName = `open-rc-${t.os}-${t.arch}${t.ext}`;
    const outPath = join(distDir, outName);
    console.log(`→ ${outName}`);
    const proc = Bun.spawnSync({
      cmd: [
        'bun',
        'build',
        '--compile',
        `--target=${t.bunTarget}`,
        '--outfile',
        outPath,
        entrypoint,
      ],
      stdout: 'inherit',
      stderr: 'inherit',
    });
    if (proc.exitCode !== 0) {
      throw new Error(`bun build failed for ${outName}`);
    }
  }
  console.log(`\n✓ built ${targets.length} binary(ies) to ${distDir}`);
}

await main();
