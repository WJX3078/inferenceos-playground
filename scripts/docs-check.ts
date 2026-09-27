#!/usr/bin/env node
// Documentation consistency check: keeps README claims in sync with reality.
//
//   npm run docs:check
//
// Verifies: every doc linked from README exists; scenario count claims in
// README match the code; every documented file path exists; the docs catalog
// in docs/experiments.md covers every scenario id. Exits non-zero on drift.

import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const problems: string[] = [];

const readme = readFileSync(resolve(root, 'README.md'), 'utf8');

// 1. Every relative markdown link in README resolves.
const linkRe = /\]\(([^)#\s]+)(?:#[^)]*)?\)/g;
for (const match of readme.matchAll(linkRe)) {
  const target = match[1];
  if (/^https?:|^mailto:/.test(target)) continue;
  if (!existsSync(resolve(root, target))) problems.push(`README links to missing file: ${target}`);
}

// 2. Scenario count claims match the code.
const scenariosSrc = readFileSync(resolve(root, 'src/simulation/scenarios.ts'), 'utf8');
const scenarioCount = (scenariosSrc.match(/    id: '/g) ?? []).length;
for (const m of readme.matchAll(/(\d+) built-in scenarios/g)) {
  if (Number(m[1]) !== scenarioCount) {
    problems.push(`README claims ${m[1]} built-in scenarios but the code defines ${scenarioCount}`);
  }
}
for (const m of readme.matchAll(/(\d+) teaching scenarios/g)) {
  if (Number(m[1]) !== scenarioCount) {
    problems.push(`README claims ${m[1]} teaching scenarios but the code defines ${scenarioCount}`);
  }
}

// 3. Every scenario id appears in docs/experiments.md (the catalog).
const experimentsDoc = readFileSync(resolve(root, 'docs/experiments.md'), 'utf8');
const ids = [...scenariosSrc.matchAll(/id: '([a-z0-9-]+)'/g)].map(m => m[1]);
for (const id of ids) {
  if (!experimentsDoc.includes(id)) problems.push(`docs/experiments.md does not document scenario "${id}"`);
}

// 4. Documented source paths exist.
const archDoc = readFileSync(resolve(root, 'docs/architecture.md'), 'utf8');
for (const m of archDoc.matchAll(/`([a-z]+\.ts|scheduler\/|runtime\/)[^`]*`/g)) {
  const p = `src/simulation/${m[1]}`;
  if (!existsSync(resolve(root, p)) && !m[1].includes('/')) problems.push(`docs/architecture.md references missing path: ${p}`);
}

// 5. Legacy claim guard: the README must not promise real-hardware fidelity.
for (const badPhrase of ['matches real', 'calibrated to A100', 'hardware benchmark results', 'GPU benchmark']) {
  if (readme.toLowerCase().includes(badPhrase.toLowerCase())) {
    problems.push(`README contains a forbidden benchmark-sounding phrase: "${badPhrase}"`);
  }
}

if (problems.length) {
  console.error('docs:check FAILED');
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log(`docs:check OK (${ids.length} scenarios documented, links resolve, no stale claims)`);
