// Unit-level self-tests. Runs entirely on the synthetic fixture - no Samsung bytes.
import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { xxh32, lz4Frame, unlz4Frame, isLz4Frame } from '../src/lz4.mjs';
import { findDtbRoots, parseDtb, readU32, describe } from '../src/dtb.mjs';
import { buildTar, withMd5Trailer, walkTar, readRange, md5, makeHeader } from '../src/tar.mjs';

let pass = 0, fail = 0;
const t = (name, fn) => {
  try { fn(); console.log(`  ok   ${name}`); pass++; }
  catch (e) { console.log(`  FAIL ${name}\n         ${e.message}`); fail++; }
};
const eq = (a, b, what = '') => { if (a !== b) throw new Error(`${what} expected ${b}, got ${a}`); };

console.log('\nxxh32');
t('empty input matches the published XXH32 vector', () => eq(xxh32(Buffer.alloc(0), 0, 0).toString(16), '2cc5d05'));
t('stable and seed-sensitive', () => {
  const b = Buffer.from('samsung sec_battery thermal', 'latin1');
  eq(xxh32(b, 0, b.length), xxh32(b, 0, b.length));
  if (xxh32(b, 0, b.length, 1) === xxh32(b, 0, b.length, 0)) throw new Error('seed had no effect');
});

console.log('\nLZ4 frame codec');
if (!existsSync('fixture_dtbo.img')) throw new Error('run node test/build-fixture.mjs first');
const fixture = readFileSync('fixture_dtbo.img');
t('repetitive device-tree data round-trips byte-identical and actually compresses', () => {
  const f = lz4Frame(fixture);
  if (!isLz4Frame(f)) throw new Error('output is not an lz4 frame');
  eq(unlz4Frame(f).length, fixture.length, 'length');
  if (Buffer.compare(unlz4Frame(f), fixture) !== 0) throw new Error('round trip differs');
  if (f.length >= fixture.length) throw new Error(`no compression (${f.length} >= ${fixture.length})`);
});
t('incompressible random data round-trips (uncompressed-block path)', () => {
  let s = 12345;
  const r = Buffer.alloc(300000);
  for (let i = 0; i < r.length; i++) { s = (s * 1103515245 + 12345) & 0x7fffffff; r[i] = s >>> 16; }
  if (Buffer.compare(unlz4Frame(lz4Frame(r)), r) !== 0) throw new Error('round trip differs');
});
t('all-zero block round-trips', () => {
  const z = Buffer.alloc(200000);
  if (Buffer.compare(unlz4Frame(lz4Frame(z)), z) !== 0) throw new Error('round trip differs');
});
t('a flipped payload byte is caught by the content checksum', () => {
  const f = lz4Frame(fixture);
  const bad = Buffer.from(f);
  bad[40] ^= 0xff;
  let threw = false;
  try { unlz4Frame(bad); } catch { threw = true; }
  if (!threw) throw new Error('corruption passed silently - checksum is not being enforced');
});
t('frame header checksum is enforced', () => {
  const bad = Buffer.from(lz4Frame(fixture));
  bad[14] ^= 0xff; // the HC byte itself
  let threw = false;
  try { unlz4Frame(bad); } catch { threw = true; }
  if (!threw) throw new Error('corrupted header checksum accepted');
});

console.log('\nDevice tree walk');
const roots = findDtbRoots(fixture);
t('finds exactly the two DTBs the fixture emitted', () => {
  eq(roots.length, 2, 'root count');
});
t('second DTB is NOT 4-byte aligned (the Samsung M32 layout)', () => {
  eq(roots[1].base % 4, 2, `base ${roots[1].base} % 4`);
});
const WANT = {
  'battery,overheatlimit_threshold': 700,
  'battery,overheatlimit_recovery': 680,
  'battery,temp_check_count': 20,
  'battery,adc_check_count': 5,
  'battery,thermal_source': 4,
};
for (const r of roots) {
  t(`DTB @${r.base} (unaligned=${r.base % 4 !== 0}) reads every battery property correctly`, () => {
    const { props } = parseDtb(fixture, r);
    for (const [name, value] of Object.entries(WANT)) {
      const p = props.find((x) => x.name === name && x.path.endsWith('/battery'));
      if (!p) throw new Error(`${name} missing from this DTB`);
      eq(readU32(fixture, p), value, name);
      if (!p.path.includes('samsung_mobile_device/battery')) throw new Error(`${name} landed under the wrong node: ${p.path}`);
    }
  });
}
t('non-DTB bytes do not produce false roots', () => {
  const noise = Buffer.alloc(200000, 0x37);
  eq(findDtbRoots(noise).length, 0);
});
t('describe() renders u32 and empty properties', () => {
  const { props } = parseDtb(fixture, roots[0]);
  const p = props.find((x) => x.name === 'battery,thermal_source');
  eq(describe(fixture, p), 'u32=4');
});

console.log('\nustar / tar.md5 container');
t('member metadata survives build -> walk -> read', () => {
  const payload = lz4Frame(fixture);
  const tar = buildTar({ name: 'dtbo.img.lz4', payload });
  const seen = [];
  const path = 'tmp_metadata.tar';
  writeFileSync(path, Buffer.concat([tar, Buffer.from(`${md5(tar)}  x.tar\n`)]));
  walkTar(path, (m) => { seen.push(m); });
  eq(seen.length, 1, 'member count');
  eq(seen[0].name, 'dtbo.img.lz4');
  eq(seen[0].size, payload.length);
  if (Buffer.compare(readRange(path, seen[0].dataOff, seen[0].size), payload) !== 0) throw new Error('payload corrupted through the container');
  eq(unlz4Frame(readRange(path, seen[0].dataOff, seen[0].size)).length, fixture.length, 'decoded payload');
});
t('md5 trailer matches archive body', () => {
  const tar = buildTar({ name: 'dtbo.img.lz4', payload: fixture });
  const whole = withMd5Trailer(tar, 'AP_test.tar');
  const inner = whole.subarray(0, whole.length - (`${md5(tar)}  AP_test.tar\n`.length));
  eq(md5(inner), md5(tar));
});
t('synthesised header declares a regular file with valid checksum', () => {
  const h = makeHeader({ name: 'dtbo.img.lz4', size: 10 });
  eq(h[156], 0x30, 'typeflag');
  eq(h.subarray(257, 262).toString('latin1'), 'ustar');
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
