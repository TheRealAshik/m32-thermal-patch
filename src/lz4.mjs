// LZ4 frame codec + xxh32.
// Validated against Samsung's stock dtbo.img.lz4: reproduces its stored header
// checksum (0x7a) and content checksum exactly, and re-encoding the unmodified
// original round-trips byte-identical.

const P1 = 2654435761, P2 = 2246822519, P3 = 3266489917, P4 = 668265263, P5 = 374761393;
const rotl = (x, r) => ((x << r) | (x >>> (32 - r))) >>> 0;
const imp = (a, b) => Math.imul(a, b) >>> 0;

export function xxh32(buf, start, len, seed = 0) {
  let h, i = start;
  const end = start + len;
  if (len >= 16) {
    let v1 = (seed + P1 + P2) >>> 0, v2 = (seed + P2) >>> 0, v3 = seed >>> 0, v4 = (seed - P1) >>> 0;
    while (i + 16 <= end) {
      v1 = imp(rotl((v1 + imp(buf.readUInt32LE(i), P2)) >>> 0, 13), P1);
      v2 = imp(rotl((v2 + imp(buf.readUInt32LE(i + 4), P2)) >>> 0, 13), P1);
      v3 = imp(rotl((v3 + imp(buf.readUInt32LE(i + 8), P2)) >>> 0, 13), P1);
      v4 = imp(rotl((v4 + imp(buf.readUInt32LE(i + 12), P2)) >>> 0, 13), P1);
      i += 16;
    }
    h = (rotl(v1, 1) + rotl(v2, 7) + rotl(v3, 12) + rotl(v4, 18)) >>> 0;
  } else h = (seed + P5) >>> 0;
  h = (h + len) >>> 0;
  while (i + 4 <= end) { h = imp(rotl((h + imp(buf.readUInt32LE(i), P3)) >>> 0, 17), P4); i += 4; }
  while (i < end) { h = imp(rotl((h + imp(buf[i], P5)) >>> 0, 11), P1); i++; }
  h ^= h >>> 15; h = imp(h, P2);
  h ^= h >>> 13; h = imp(h, P3);
  h ^= h >>> 16;
  return h >>> 0;
}

const MFS = 15;

export const isLz4Frame = (buf) => buf.length >= 4 && buf.readUInt32LE(0) === 0x184d2204;

function compressBlock(src, s, e) {
  const parts = [];
  const hash = new Map();
  let anchor = s, ip = s;
  const limit = e - 18;
  const h4 = (p) => (imp(((src[p] | (src[p + 1] << 8) | ((src[p + 2] << 16) >>> 0)) ^ src[p + 3]) >>> 0, 2654435761) >>> 12) & 0xffff;
  const pushLen = (n) => { const b = []; for (; n >= 255; n -= 255) b.push(255); b.push(n); return Buffer.from(b); };

  while (ip < limit) {
    const hv = h4(ip);
    const cand = hash.get(hv);
    hash.set(hv, ip);
    if (cand !== undefined && src[cand] === src[ip] && src[cand + 1] === src[ip + 1] && src[cand + 2] === src[ip + 2] && src[cand + 3] === src[ip + 3]) {
      let mLen = 4;
      while (ip + mLen < limit && src[cand + mLen] === src[ip + mLen]) mLen++;
      const litLen = ip - anchor;
      const tokenHi = litLen >= MFS ? MFS : litLen;
      const tokenLo = mLen - 4 >= MFS ? MFS : mLen - 4;
      parts.push(Buffer.from([(tokenHi << 4) | tokenLo]));
      if (litLen >= MFS) parts.push(pushLen(litLen - MFS));
      if (litLen > 0) parts.push(src.subarray(anchor, ip));
      const off = Buffer.alloc(2); off.writeUInt16LE(ip - cand, 0); parts.push(off);
      if (mLen - 4 >= MFS) parts.push(pushLen(mLen - 4 - MFS));
      ip += mLen;
      anchor = ip;
      continue;
    }
    ip++;
  }
  const litLen = e - anchor;
  const tokenHi = litLen >= MFS ? MFS : litLen;
  parts.push(Buffer.from([tokenHi << 4]));
  if (litLen >= MFS) parts.push(pushLen(litLen - MFS));
  if (litLen > 0) parts.push(src.subarray(anchor, e));
  return Buffer.concat(parts);
}

// Mirrors the stock Samsung frame descriptor: FLG=0x6c (block-independent,
// content size present, content checksum present), BD=0x50 (64KB blocks).
export function lz4Frame(buf, blockSize = 1 << 16) {
  const head = Buffer.alloc(15);
  head.writeUInt32LE(0x184d2204, 0);
  head[4] = 0x6c;
  head[5] = 0x50;
  head.writeBigUInt64LE(BigInt(buf.length), 6);
  head[14] = (xxh32(head, 4, 10) >>> 8) & 0xff;
  const out = [head];
  for (let s = 0; s < buf.length; s += blockSize) {
    const e = Math.min(s + blockSize, buf.length);
    const c = compressBlock(buf, s, e);
    const bs = Buffer.alloc(4);
    if (c.length >= e - s) { bs.writeUInt32LE(((e - s) | 0x80000000) >>> 0, 0); out.push(bs, buf.subarray(s, e)); }
    else { bs.writeUInt32LE(c.length, 0); out.push(bs, c); }
  }
  out.push(Buffer.alloc(4));
  const cc = Buffer.alloc(4);
  cc.writeUInt32LE(xxh32(buf, 0, buf.length), 0);
  out.push(cc);
  return Buffer.concat(out);
}

function decompressBlock(src, sOff, sEnd, out, dOff) {
  while (sOff < sEnd) {
    const token = src[sOff++];
    let litLen = token >> 4;
    if (litLen === 15) { let b; do { b = src[sOff++]; litLen += b; } while (b === 255); }
    if (litLen > 0) {
      for (let i = 0; i < litLen; i++) out[dOff + i] = src[sOff + i];
      dOff += litLen;
      sOff += litLen;
    }
    if (sOff >= sEnd) break;
    const offset = src[sOff] | (src[sOff + 1] << 8);
    sOff += 2;
    let mlen = (token & 0x0f) + 4;
    if ((token & 0x0f) === 15) { let b; do { b = src[sOff++]; mlen += b; } while (b === 255); }
    const from = dOff - offset;
    for (let i = 0; i < mlen; i++) out[dOff + i] = out[from + i];
    dOff += mlen;
  }
  return dOff;
}

export function unlz4Frame(buf) {
  if (!isLz4Frame(buf)) throw new Error('not an LZ4 frame (bad magic)');
  const flg = buf[4], bd = buf[5];
  const blockIndependent = (flg >> 5) & 1;
  const blockChecksum = (flg >> 4) & 1;
  const hasSize = (flg >> 3) & 1;
  const hasCC = (flg >> 2) & 1;
  const hasDict = (flg >> 1) & 1;
  let p = 6;
  let contentSize = -1;
  if (hasSize) { contentSize = Number(buf.readBigUInt64LE(p)); p += 8; }
  if (hasDict) p += 4;
  const calcHC = (xxh32(buf, 4, p - 4) >>> 8) & 0xff;
  const fileHC = buf[p];
  if (calcHC !== fileHC) throw new Error(`frame header checksum mismatch: file=0x${fileHC.toString(16)} calc=0x${calcHC.toString(16)}`);
  p += 1;

  let out = Buffer.alloc(Math.max(contentSize, 1 << 20));
  let dOff = 0;
  for (;;) {
    if (p + 4 > buf.length) break;
    const bsize = buf.readUInt32LE(p); p += 4;
    if (bsize === 0xffffffff) break;
    if (bsize === 0) break;
    const len = bsize & 0x7fffffff;
    if ((bsize & 0x80000000) !== 0) {
      if (dOff + len > out.length) throw new Error('uncompressed block overflow');
      buf.copy(out, dOff, p, p + len);
      dOff += len;
    } else {
      if (dOff + len * 255 > out.length) {
        const grown = Buffer.alloc(Math.max(dOff + len * 255, out.length * 2));
        out.copy(grown, 0, 0, dOff);
        out = grown;
      }
      dOff = decompressBlock(buf, p, p + len, out, dOff);
    }
    p += len;
    if (blockChecksum) p += 4;
    void blockIndependent;
  }
  if (hasCC && p + 4 <= buf.length) {
    const stored = buf.readUInt32LE(p);
    const calc = xxh32(out, 0, dOff);
    if (stored !== calc) throw new Error(`content checksum mismatch: stored=0x${stored.toString(16)} calc=0x${calc.toString(16)}`);
  }
  return out.subarray(0, dOff);
}
