#!/usr/bin/env node
// Raise or restore the Samsung sec_battery emergency overheat threshold in dtbo.img.
//
// Properties are located BY NAME inside every DTB in the image, never by hardcoded
// byte offset, so this works across firmware builds. It refuses to write unless the
// value it found is plausible and the resulting image re-parses with an exact,
// expected diff.
//
//   node src/patch-dtbo.mjs --input AP_M325FXXSDDYE3.tar.md5 --list
//   node src/patch-dtbo.mjs --input AP_M325FXXSDDYE3.tar.md5 --apply
//   node src/patch-dtbo.mjs --input dtbo.img.lz4 --threshold 700 --recovery 680 --apply

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import { isLz4Frame, lz4Frame, unlz4Frame } from './lz4.mjs';
import { findDtbRoots, parseDtb, describe, readU32 } from './dtb.mjs';
import { findMember, readRange, buildTar, withMd5Trailer, md5 } from './tar.mjs';

process.on('uncaughtException', (e) => {
  console.error(`\nerror: ${e.message}`);
  console.error('nothing was written. See README.md for what this tool expects as input.');
  process.exit(1);
});

function argv(spec) {
  const out = { ...spec };
  const a = process.argv.slice(2);
  for (let i = 0; i < a.length; i++) {
    if (!a[i].startsWith('--')) continue;
    const k = a[i].slice(2);
    if (k in spec) { out[k] = k === 'apply' || k === 'list' ? true : a[++i]; continue; }
    throw new Error(`unknown option --${k}`);
  }
  return out;
}

const opt = argv({ input: '', outdir: 'out', threshold: '2000', recovery: '1980', name: 'dtbo.img', list: false, apply: false });
if (!opt.input) {
  console.error('usage: node src/patch-dtbo.mjs --input <AP.tar.md5|dtbo.img.lz4|dtbo.img> [--list] [--apply] [--threshold N] [--recovery N] [--outdir dir]');
  process.exit(2);
}

const TARGETS = [
  { name: 'battery,overheatlimit_threshold', to: Number(opt.threshold) },
  { name: 'battery,overheatlimit_recovery', to: Number(opt.recovery) },
];

// --- 1. obtain the raw dtbo image, remembering how it was packaged ---
let image, member = null, wasLz4 = false;
const lower = opt.input.toLowerCase();
if (lower.endsWith('.tar') || lower.endsWith('.tar.md5')) {
  member = findMember(opt.input, [opt.name]);
  if (!member) throw new Error(`no "${opt.name}*" member found in ${opt.input}`);
  let payload = readRange(opt.input, member.dataOff, member.size);
  wasLz4 = isLz4Frame(payload);
  image = wasLz4 ? unlz4Frame(payload) : payload;
  console.log(`input archive : ${opt.input}`);
  console.log(`member        : ${member.name} (${member.size} bytes, ${wasLz4 ? 'lz4 frame' : 'raw'})`);
} else {
  const raw = readFileSync(opt.input);
  wasLz4 = isLz4Frame(raw);
  image = wasLz4 ? unlz4Frame(raw) : raw;
  console.log(`input image   : ${opt.input} (${raw.length} bytes -> ${image.length} decompressed)`);
}

// --- 2. locate the target properties by name ---
const roots = findDtbRoots(image);
if (!roots.length) throw new Error('no valid DTB found in image - is this really a dtbo.img?');
console.log(`DTB structures: ${roots.map((r) => `@${r.base} (${r.totalsize} B)`).join(', ')}`);

const found = [];
for (const root of roots) {
  const { props } = parseDtb(image, root);
  for (const p of props) {
    for (const t of TARGETS) {
      if (p.name === t.name && p.path.endsWith('/battery')) found.push({ ...p, root: root.base, target: t });
    }
  }
}
if (!found.length) {
  throw new Error(`could not find "battery,overheatlimit_threshold" in any /battery node. The layout differs from this tool's expectation - NOT writing anything. Inspect with --list.`);
}

console.log('\nlocating targets:');
for (const f of found) {
  const cur = readU32(image, f);
  console.log(`  DTB@${String(f.root).padEnd(7)} ${f.name.padEnd(34)} now=${String(cur).padEnd(6)} (${(cur / 10).toFixed(1)} C)  @${f.abs} len=${f.len}`);
  if (cur === null) throw new Error(`  unexpected encoding for ${f.name} (len=${f.len}) - refusing`);
  if (cur < 0 || cur > 1200) throw new Error(`  current value ${cur} is outside 0..1200 (0.1 C units); this does not look like a real threshold - refusing to write`);
  if (f.target.to < 0 || f.target.to > 4000) throw new Error(`  requested value ${f.target.to} is implausible - refusing`);
}

if (opt.list) {
  console.log('\nall thermal-related properties per DTB:');
  for (const root of roots) {
    const { props } = parseDtb(image, root);
    const rows = props.filter((p) => /therm|overheat|temp_|_temp|chg|dchg|cool|shutdown/i.test(p.name));
    console.log(`\n  ### DTB @${root.base} - ${rows.length} thermal properties`);
    for (const p of rows) console.log(`    ${p.path.split('/').slice(-2).join('/')} :: ${p.name} = ${describe(image, p)}  [abs=${p.abs} len=${p.len}]`);
  }
  if (!opt.apply) process.exit(0);
}

if (!opt.apply) {
  console.log('\ndry run - nothing written. Re-run with --apply to produce a patched archive.');
  process.exit(0);
}

// --- 3. patch in place, then prove nothing else moved ---
const before = Buffer.from(image);
for (const f of found) {
  if (f.len !== 4) throw new Error('cannot write non-u32 property');
  image.writeUInt32BE(f.target.to, f.abs);
}
const ranges = found.map((f) => [f.abs, f.abs + f.len]);
let diffBytes = 0;
const outside = [];
for (let i = 0; i < before.length; i++) {
  if (before[i] === image[i]) continue;
  diffBytes++;
  if (!ranges.some(([s, e]) => i >= s && i < e)) outside.push(i);
}
if (outside.length) throw new Error(`${diffBytes} bytes changed but ${outside.length} fall outside the patched properties (first at ${outside[0]}) - refusing to emit`);
if (diffBytes === 0) throw new Error('no bytes changed - the requested values equal the current ones');
console.log(`\npatched ${found.length} properties; ${diffBytes} bytes changed, all inside those properties; image size unchanged (${image.length})`);

// --- 4. re-encode + package, using the original member header as the template ---
let frame = image;
if (wasLz4) frame = lz4Frame(image);
mkdirSync(opt.outdir, { recursive: true });
const imgPath = join(opt.outdir, 'dtbo_patched.img');
writeFileSync(imgPath, image);
let artifact = imgPath;
if (wasLz4) {
  artifact = join(opt.outdir, 'dtbo_patched.img.lz4');
  writeFileSync(artifact, frame);
}
if (member) {
  const tar = buildTar({ name: member.name.split('/').pop(), payload: frame, template: member.header });
  artifact = join(opt.outdir, 'AP_dtbo_patched.tar.md5');
  writeFileSync(artifact, withMd5Trailer(tar, 'AP_dtbo_patched.tar'));
  console.log(`artifact      : ${artifact} (${frame.length} B member, ${tar.length + 54} B archive) md5=${md5(tar)}`);
} else {
  console.log(`artifact      : ${artifact}`);
}

// --- 5. independently re-read the artifact from disk and verify the whole tree ---
function snapshot(path) {
  let buf;
  if (path.endsWith('.tar.md5') || path.endsWith('.tar')) {
    const m = findMember(path, ['dtbo.img']);
    if (!m) throw new Error('artifact tar has no dtbo member');
    const payload = readRange(path, m.dataOff, m.size);
    buf = isLz4Frame(payload) ? unlz4Frame(payload) : payload;
  } else if (isLz4Frame(readFileSync(path).subarray(0, 4))) {
    buf = unlz4Frame(readFileSync(path));
  } else buf = readFileSync(path);
  const map = new Map();
  for (const r of findDtbRoots(buf)) for (const p of parseDtb(buf, r).props) map.set(`${r.base}|${p.path}|${p.name}`, describe(buf, p));
  return map;
}

const origMap = snapshot(opt.input);
const newMap = snapshot(artifact);
const changed = [...newMap].filter(([k, v]) => origMap.get(k) !== v);
const removed = [...origMap.keys()].filter((k) => !newMap.has(k));
const added = [...newMap.keys()].filter((k) => !origMap.has(k));
console.log(`\nverification - re-parsed ${artifact}:`);
console.log(`  properties in tree: ${origMap.size} -> ${newMap.size}${removed.length || added.length ? ' (MISMATCH)' : ''}`);
console.log(`  properties changed: ${changed.length} (expected ${found.length})`);
for (const [k, v] of changed) console.log(`    ${k.split('|').slice(1).join(' :: ')} = ${v}`);
if (removed.length) console.log(`  LOST: ${removed.slice(0, 5).join(', ')}`);
if (added.length) console.log(`  APPEARED: ${added.slice(0, 5).join(', ')}`);
const expectedNames = new Set(found.map((f) => `${f.root}|${f.path}|${f.name}`));
if (changed.length !== found.length || [...changed].some(([k]) => !expectedNames.has(k)) || removed.length || added.length) {
  throw new Error('VERIFICATION FAILED - artifact touches more than the intended properties. Do NOT flash it.');
}
console.log(`\nOK: every other property in the device tree is byte-identical to your input.`);
console.log(`Flashing notes, risks and rollback are in README.md. Short version: Odin, AP slot only, Re-Partition OFF, battery above 50%.`);
console.log(`source: ${basename(opt.input)}`);
