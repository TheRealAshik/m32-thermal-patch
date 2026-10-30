// Builds a firmware-free synthetic dtbo image so CI can test the real code paths.
//
// Two DTBs are emitted and the second is deliberately placed at an offset that is
// NOT 4-byte aligned. That is exactly the trap in Samsung's M32 dtbo (second DTB at
// 87342, 87342 % 4 == 2): any code that pads on absolute file offsets reads wrong
// values out of the second tree without ever erroring.

import { mkdirSync, writeFileSync } from 'node:fs';
import { lz4Frame } from '../src/lz4.mjs';
import { buildTar, withMd5Trailer } from '../src/tar.mjs';

const TAG = { BEGIN: 1, END_NODE: 2, PROP: 3, END: 9 };
const RSVMAP = 40;

function buildDtb(batteryProps) {
  const strings = [];
  const strOff = (s) => {
    let i = 0;
    for (const x of strings) { if (x === s) return i; i += x.length + 1; }
    strings.push(s);
    return i;
  };
  for (const key of ['compatible', 'model']) strOff(key);
  for (const p of batteryProps) strOff(p.name);

  const struct = [];
  const push = (b) => struct.push(b);
  const align = () => {
    const cur = struct.reduce((n, b) => n + b.length, 0);
    const pad = (4 - (cur % 4)) % 4;
    if (pad) push(Buffer.alloc(pad));
  };
  const token = (t) => { const b = Buffer.alloc(4); b.writeUInt32BE(t, 0); push(b); };
  const node = (name) => { token(TAG.BEGIN); push(Buffer.from(name + '\0', 'latin1')); align(); };
  const multiU32 = (nums) => {
    const b = Buffer.alloc(nums.length * 4);
    nums.forEach((n, i) => b.writeUInt32BE(n >>> 0, i * 4));
    return b;
  };
  // FDT_PROP = tag, length, nameoff, then the value padded up to a 4-byte boundary.
  const prop = (name, val) => {
    const b = Buffer.alloc(12 + val.length + ((4 - (val.length % 4)) % 4));
    b.writeUInt32BE(TAG.PROP, 0);
    b.writeUInt32BE(val.length, 4);
    b.writeUInt32BE(strOff(name), 8);
    val.copy(b, 12);
    push(b);
  };

  node('');
  prop('compatible', Buffer.from('samsung,test-board\0', 'latin1'));
  node('samsung_mobile_device');
  node('battery');
  for (const p of batteryProps) {
    const val = Buffer.alloc(4);
    val.writeUInt32BE(p.value, 0);
    prop(p.name, val);
  }
  // A real dtbo DTB is ~87 KB; findDtbRoots() rejects trees under 1 KB so it cannot
  // light on random noise. Filler nodes keep the fixture above that floor and make
  // the parser exercise multi-u32 and string properties, not just single u32s.
  for (let i = 0; i < 40; i++) {
    node(`thermal-zone-${i}`);
    prop('samsung,adc-table', multiU32([96, 113, 133, 158, 3583]));
    prop('samsung,temp-table', multiU32([900, 850, 800, 750, -200]));
    prop('samsung,tripping', Buffer.from(`trip-point-${i}\0`, 'latin1'));
    const single = Buffer.alloc(4);
    single.writeUInt32BE(i, 0);
    prop('polling-delay', single);
    token(TAG.END_NODE);
  }
  token(TAG.END_NODE);
  token(TAG.END_NODE);
  token(TAG.END);

  const structBuf = Buffer.concat(struct);
  const strBuf = Buffer.from(strings.map((s) => s + '\0').join(''), 'latin1');

  const offStruct = RSVMAP;
  const offStrings = offStruct + structBuf.length;
  const totalsize = offStrings + strBuf.length;

  const header = Buffer.alloc(40);
  header.writeUInt32BE(0xd00dfeed, 0);
  header.writeUInt32BE(totalsize, 4);
  header.writeUInt32BE(offStruct, 8);
  header.writeUInt32BE(offStrings, 12);
  header.writeUInt32BE(40, 16); // off_mem_rsvmap
  header.writeUInt32BE(17, 20); // version
  header.writeUInt32BE(16, 24); // last_comp_version
  header.writeUInt32BE(0, 28); // boot_cpuid
  header.writeUInt32BE(strBuf.length, 32);
  header.writeUInt32BE(structBuf.length, 36);

  const rsvmap = Buffer.alloc(offStruct - 40);
  return Buffer.concat([header, rsvmap, structBuf, strBuf]);
}

const BATTERY = [
  { name: 'battery,overheatlimit_threshold', value: 700 },
  { name: 'battery,overheatlimit_recovery', value: 680 },
  { name: 'battery,temp_check_count', value: 20 },
  { name: 'battery,adc_check_count', value: 5 },
  { name: 'battery,thermal_source', value: 4 },
];

const dtb1 = buildDtb(BATTERY);
const dtb2 = buildDtb(BATTERY);
// align to a 4-byte boundary, then insert 2 stray bytes so the second DTB starts at
// an offset that is 2 mod 4 - reproducing the real image (second DTB at 87342)
const pad = (4 - (dtb1.length % 4)) % 4;
const image = Buffer.concat([Buffer.alloc(96), dtb1, Buffer.alloc(pad), Buffer.alloc(2), dtb2, Buffer.alloc(4223)]);

export function fixtureImage() { return image; }
export function expectedRoots() {
  return [96, 96 + dtb1.length + pad + 2];
}
// The container the CLI is tested against: the same bytes Samsung ships, with our
// synthetic image inside.
export function fixtureTar() {
  return withMd5Trailer(buildTar({ name: 'dtbo.img.lz4', payload: lz4Frame(image) }), 'fixture_AP.tar');
}

if (process.argv[1] && process.argv[1].endsWith('build-fixture.mjs')) {
  writeFileSync('fixture_dtbo.img', image);
  mkdirSync('tmp', { recursive: true });
  writeFileSync('tmp/fixture_AP.tar.md5', fixtureTar());
  console.log(`wrote fixture_dtbo.img ${image.length} bytes; DTB roots at ${expectedRoots().join(', ')} (second root % 4 = ${expectedRoots()[1] % 4})`);
  console.log('wrote tmp/fixture_AP.tar.md5 (the container the CLI tests run against)');
}
