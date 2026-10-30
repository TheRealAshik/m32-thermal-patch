// Flattened Device Tree (DTB) reader for Samsung dtbo.img.
//
// A dtbo.img holds several overlay DTBs concatenated, and they are NOT required
// to start on a 4-byte boundary. Samsung's M325F dtbo puts the second DTB at
// 87342 (87342 % 4 == 2), so every alignment calculation here is relative to the
// DTB base - getting this wrong silently mis-reads property values.

const TAG = { BEGIN: 1, END_NODE: 2, PROP: 3, NOP: 4, END: 9 };
const DTB_MAGIC = 0xd00dfeed;

export function findDtbRoots(img) {
  const roots = [];
  for (let base = 0; base + 40 <= img.length; base++) {
    if (img.readUInt32BE(base) !== DTB_MAGIC) continue;
    const totalsize = img.readUInt32BE(base + 4);
    const offStruct = img.readUInt32BE(base + 8);
    const offStrings = img.readUInt32BE(base + 12);
    const version = img.readUInt32BE(base + 20);
    const sizeStrings = img.readUInt32BE(base + 32);
    const sizeStruct = img.readUInt32BE(base + 36);
    void sizeStrings;
    if (totalsize < 1024 || base + totalsize > img.length) continue;
    if (offStruct % 4 !== 0 || offStruct > totalsize) continue;
    if (offStruct + sizeStruct !== offStrings) continue;
    if (offStrings + sizeStrings > totalsize) continue;
    if (version < 16 || version > 18) continue;
    if (img.readUInt32BE(base + offStruct) !== TAG.BEGIN) continue;
    roots.push({ base, totalsize, offStruct, offStrings, sizeStruct, version });
  }
  // drop nested/overlapping hits, keeping the outermost at each offset
  return roots.filter((r, i) => !roots.some((o, j) => j < i && o.base <= r.base && o.base + o.totalsize > r.base));
}

export function parseDtb(img, root) {
  const { base, offStruct, offStrings, sizeStruct } = root;
  const strTab = base + offStrings;
  const nameAt = (o) => {
    let p = strTab + o, s = '';
    while (p < img.length && img[p] !== 0) s += String.fromCharCode(img[p++]);
    return s;
  };
  const align = (r) => (r + 3) & ~3;
  const props = [];
  const nodes = [];
  const stack = [];
  let rel = offStruct;
  const end = offStruct + sizeStruct;
  let tagCount = 0;
  while (rel < end) {
    const tag = img.readUInt32BE(base + rel);
    rel += 4;
    tagCount++;
    if (tagCount > 5_000_000) throw new Error('DTB walk runaway - aborting');
    if (tag === TAG.BEGIN) {
      let p = base + rel, name = '';
      while (p < img.length && img[p] !== 0) name += String.fromCharCode(img[p++]);
      rel = align(p + 1 - base);
      stack.push(name);
      nodes.push({ path: '/' + stack.join('/') });
    } else if (tag === TAG.END_NODE) {
      stack.pop();
    } else if (tag === TAG.PROP) {
      const len = img.readUInt32BE(base + rel);
      const nameoff = img.readUInt32BE(base + rel + 4);
      const dataRel = rel + 8;
      if (base + dataRel + len > img.length) throw new Error('property data past end of image');
      props.push({ path: '/' + stack.join('/'), name: nameAt(nameoff), len, abs: base + dataRel });
      rel = align(dataRel + len);
    } else if (tag === TAG.NOP) {
      /* continue */
    } else if (tag === TAG.END) {
      break;
    } else {
      throw new Error(`invalid FDT tag ${tag} at abs ${base + rel - 4} in DTB @${base} - not a parsable device tree`);
    }
  }
  return { props, nodes };
}

export function readU32(img, prop) {
  if (prop.len !== 4) return null;
  return img.readUInt32BE(prop.abs);
}

export function describe(img, prop) {
  const bytes = img.subarray(prop.abs, prop.abs + prop.len);
  const ascii = bytes.toString('latin1');
  if (prop.len > 0 && /^[\x20-\x7e]*\0*$/.test(ascii) && /[\x20-\x7e]/.test(ascii) && bytes.includes(0)) {
    return `str="${ascii.split('\0')[0]}"`;
  }
  if (prop.len === 4) return `u32=${bytes.readUInt32BE(0)}`;
  if (prop.len === 0) return '<empty>';
  if (prop.len % 4 === 0) return `[${Array.from({ length: prop.len / 4 }, (_, i) => bytes.readUInt32BE(i * 4)).join(', ')}]`;
  return `hex(${prop.len})=${bytes.toString('hex').slice(0, 40)}`;
}
