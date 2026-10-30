// End-to-end CLI tests against a synthetic tar.md5 - proves the shipped binary path
// (extract -> decode -> locate -> patch -> re-encode -> repack -> re-verify) works,
// and that the refusal guards actually stop a run.
import { spawnSync } from 'node:child_process';
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { lz4Frame, unlz4Frame } from '../src/lz4.mjs';
import { buildTar, withMd5Trailer, findMember, readRange } from '../src/tar.mjs';
import { findDtbRoots, parseDtb, readU32 } from '../src/dtb.mjs';
import { fixtureImage, fixtureTar, expectedRoots } from './build-fixture.mjs';

let pass = 0, fail = 0;
const t = (name, fn) => {
  try { fn(); console.log(`  ok   ${name}`); pass++; }
  catch (e) { console.log(`  FAIL ${name}\n         ${e.message}`); fail++; }
};

if (!existsSync('fixture_dtbo.img')) writeFileSync('fixture_dtbo.img', fixtureImage());
mkdirSync('tmp', { recursive: true });
const INPUT = 'tmp/fixture_AP.tar.md5';
if (!existsSync(INPUT)) writeFileSync(INPUT, fixtureTar());

const run = (args) => spawnSync(process.execPath, ['src/patch-dtbo.mjs', ...args], { encoding: 'utf8', timeout: 120000 });
const out = (r) => (r.stdout || '') + (r.stderr || '');

const patchedValuesOf = (path) => {
  const m = findMember(path, ['dtbo.img']);
  if (!m) throw new Error(`no dtbo member in ${path}`);
  const raw = readRange(path, m.dataOff, m.size);
  const img = unlz4Frame(raw);
  const got = [];
  for (const r of findDtbRoots(img)) {
    for (const p of parseDtb(img, r).props) {
      if ((p.name === 'battery,overheatlimit_threshold' || p.name === 'battery,overheatlimit_recovery') && p.path.endsWith('/battery')) {
        got.push(`${r.base}:${p.name}=${readU32(img, p)}`);
      }
    }
  }
  if (!got.length) throw new Error('patched artifact has no overheat properties at all');
  return got.sort().join(' ');
};

console.log('\nCLI end-to-end on a synthetic firmware container');
t('--list exits 0 and shows the located targets', () => {
  const r = run(['--input', INPUT, '--list']);
  if (r.status !== 0) throw new Error(`exit ${r.status}: ${out(r).slice(-300)}`);
  if (!out(r).includes('battery,overheatlimit_threshold')) throw new Error('targets not listed');
  if (!out(r).includes('70.0 C')) throw new Error('did not render the stock threshold as 70.0 C');
});

t('dry run writes nothing', () => {
  const r = run(['--input', INPUT, '--outdir', 'tmp/dry']);
  if (r.status !== 0) throw new Error(`exit ${r.status}: ${out(r).slice(-300)}`);
  if (!out(r).includes('dry run')) throw new Error('did not report a dry run');
  if (existsSync('tmp/dry/AP_dtbo_patched.tar.md5')) throw new Error('dry run produced an artifact');
});

t('--apply patches every DTB in the image, not just the first', () => {
  const r = run(['--input', INPUT, '--apply', '--outdir', 'tmp/ok']);
  if (r.status !== 0) throw new Error(`exit ${r.status}: ${out(r).slice(-400)}`);
  const roots = expectedRoots();
  if (roots.length !== 2) throw new Error('fixture lost its second DTB');
  const vals = patchedValuesOf('tmp/ok/AP_dtbo_patched.tar.md5');
  const count = (vals.match(/=2000/g) || []).length + (vals.match(/=1980/g) || []).length;
  if (count !== roots.length * 2) throw new Error(`expected ${roots.length * 2} patched properties, got ${count}: ${vals}`);
  if (!out(r).includes('every other property in the device tree is byte-identical')) throw new Error('self-verification did not run');
});

t('honours a custom threshold', () => {
  const r = run(['--input', INPUT, '--apply', '--outdir', 'tmp/custom', '--threshold', '950', '--recovery', '930']);
  if (r.status !== 0) throw new Error(`exit ${r.status}: ${out(r).slice(-300)}`);
  const vals = patchedValuesOf('tmp/custom/AP_dtbo_patched.tar.md5');
  if (!vals.includes('=950') || !vals.includes('=930')) throw new Error(`custom values not applied: ${vals}`);
});

console.log('\nRefusal guards');
t('refuses to re-patch an already-patched image', () => {
  const r = run(['--input', 'tmp/ok/AP_dtbo_patched.tar.md5', '--apply', '--outdir', 'tmp/again']);
  if (r.status === 0) throw new Error('double-patching was allowed - plausibility guard is not working');
  if (!out(r).includes('refusing')) throw new Error(`did not explain why: ${out(r).slice(-200)}`);
  if (existsSync('tmp/again/AP_dtbo_patched.tar.md5')) throw new Error('wrote an artifact despite refusing');
});

t('rejects an implausible requested threshold', () => {
  const r = run(['--input', INPUT, '--apply', '--outdir', 'tmp/bad', '--threshold', '99999']);
  if (r.status === 0) throw new Error('accepted a nonsensical value');
  if (!out(r).includes('implausible')) throw new Error(`wrong message: ${out(r).slice(-200)}`);
});

t('rejects an image with no matching property', () => {
  const unrelated = Buffer.alloc(40000, 7);
  writeFileSync('tmp/unrelated.img', unrelated);
  const r = run(['--input', 'tmp/unrelated.img', '--apply', '--outdir', 'tmp/nope']);
  if (r.status === 0) throw new Error('patched something it should not recognise');
  if (!out(r).includes('error')) throw new Error('no error reported');
});

t('rejects a container without a dtbo member', () => {
  // Same bytes as the working fixture, only filed under a name the tool must not accept.
  writeFileSync('tmp/nodtbo.tar.md5',
    withMd5Trailer(buildTar({ name: 'preloader.img.lz4', payload: lz4Frame(fixtureImage()) }), 'nodtbo.tar'));
  const r = run(['--input', 'tmp/nodtbo.tar.md5']);
  if (r.status === 0) throw new Error('accepted an archive with no dtbo');
  if (!out(r).includes('no "dtbo.img*" member found')) throw new Error(`wrong message: ${out(r).slice(-200)}`);
});

t('requires an input path', () => {
  const r = run([]);
  if (r.status === 0) throw new Error('ran with no --input');
  if (!out(r).includes('usage:')) throw new Error('no usage text');
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
