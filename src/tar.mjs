// Samsung firmware .tar.md5 reader/writer.
// A .tar.md5 is a plain ustar archive followed by an md5sum-style text line:
//   "<32-hex-md5>  <archive-name>.tar\n"
// Odin maps members to partitions by filename, so member name, mode, uid/gid and
// mtime are preserved from the stock header to keep the archive as close to
// original as possible.

import { openSync, closeSync, readSync, fstatSync } from 'node:fs';
import { createHash } from 'node:crypto';

const BLOCK = 512;

export function walkTar(path, onMember) {
  const fd = openSync(path, 'r');
  try {
    const total = fstatSync(fd).size;
    const hdr = Buffer.alloc(BLOCK);
    let off = 0;
    while (off + BLOCK <= total) {
      readSync(fd, hdr, 0, BLOCK, off);
      if (hdr.every((b) => b === 0)) break;
      const name = hdr.subarray(0, 100).toString('latin1').split('\0')[0];
      const prefix = hdr.subarray(345, 500).toString('latin1').split('\0')[0];
      const sizeStr = hdr.subarray(124, 136).toString('latin1').split('\0')[0].trim();
      const size = parseInt(sizeStr || '0', 8);
      if (Number.isNaN(size)) throw new Error(`unparsable tar size for "${name}" at ${off}`);
      const full = prefix ? `${prefix}/${name}` : name;
      const dataOff = off + BLOCK;
      const keepGoing = onMember({ name: full, size, headerOff: off, dataOff, header: Buffer.from(hdr) });
      off = dataOff + Math.ceil(size / BLOCK) * BLOCK;
      if (keepGoing === false) return;
    }
  } finally {
    closeSync(fd);
  }
}

export function readRange(path, offset, length) {
  const fd = openSync(path, 'r');
  try {
    const buf = Buffer.alloc(length);
    let got = 0;
    while (got < length) {
      const n = readSync(fd, buf, got, length - got, offset + got);
      if (n <= 0) break;
      got += n;
    }
    if (got !== length) throw new Error(`short read at ${offset}: wanted ${length} got ${got}`);
    return buf;
  } finally {
    closeSync(fd);
  }
}

export function findMember(path, wantedNames) {
  let hit = null;
  walkTar(path, (m) => {
    const base = m.name.split('/').pop();
    if (wantedNames.some((w) => base === w || base.startsWith(w))) { hit = m; return false; }
  });
  return hit;
}

function octal(value, len) {
  return value.toString(8).padStart(len - 1, '0');
}

function checksumHeader(hdr) {
  hdr.fill(0x20, 148, 156);
  let sum = 0;
  for (let i = 0; i < BLOCK; i++) sum += hdr[i];
  hdr.write(octal(sum, 7), 148, 6, 'latin1');
  hdr[154] = 0;
  hdr[155] = 32;
  return hdr;
}

export function makeHeaderFromTemplate(template, size) {
  const hdr = Buffer.from(template);
  hdr.fill(0x30, 124, 135);
  hdr.write(octal(size, 12), 124, 11, 'latin1');
  hdr[135] = 0;
  return checksumHeader(hdr);
}

export function makeHeader({ name, size, mode = 0o644, uid = 1000, gid = 1000, mtime = Math.floor(Date.now() / 1000) }) {
  const hdr = Buffer.alloc(BLOCK);
  hdr.write(name.split('/').pop(), 0, 100, 'latin1');
  hdr.write(octal(mode, 8), 100, 7, 'latin1'); hdr[107] = 32;
  hdr.write(octal(uid, 8), 108, 7, 'latin1'); hdr[115] = 32;
  hdr.write(octal(gid, 8), 116, 7, 'latin1'); hdr[123] = 32;
  hdr.write(octal(size, 12), 124, 11, 'latin1'); hdr[135] = 0;
  hdr.write(octal(mtime, 12), 136, 11, 'latin1'); hdr[147] = 32;
  hdr[156] = 0x30; // typeflag '0' = regular file
  hdr.write('ustar', 257, 5, 'latin1');
  hdr.write('00', 263, 2, 'latin1');
  hdr.write('dpi', 265, 32, 'latin1');
  hdr.write('dpi', 325, 32, 'latin1');
  return checksumHeader(hdr);
}

export function buildTar({ name, payload, template }) {
  const hdr = template ? makeHeaderFromTemplate(template, payload.length) : makeHeader({ name, size: payload.length });
  const pad = BLOCK - (payload.length % BLOCK || BLOCK);
  return Buffer.concat([hdr, payload, Buffer.alloc(pad), Buffer.alloc(2 * BLOCK)]);
}

export function withMd5Trailer(tarBuf, innerTarName) {
  const md5 = createHash('md5').update(tarBuf).digest('hex');
  return Buffer.concat([tarBuf, Buffer.from(`${md5}  ${innerTarName}\n`, 'latin1')]);
}

export const md5 = (buf) => createHash('md5').update(buf).digest('hex');
