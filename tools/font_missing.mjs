// Lists characters missing from one of the subset fonts, for when tools/build_fonts.py cannot be run.
//   node tools/font_missing.mjs assets/fonts/sans-regular.woff "新的文字"
import { readFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
const [file, text] = process.argv.slice(2);
const w = readFileSync(file);
if (w.toString('latin1', 0, 4) !== 'wOFF') throw new Error('not WOFF');
let cmap = null;
for (let i = 0, n = w.readUInt16BE(12); i < n; i++) {
  const e = 44 + i * 20;
  if (w.toString('latin1', e, e + 4) !== 'cmap') continue;
  const off = w.readUInt32BE(e + 4), comp = w.readUInt32BE(e + 8), orig = w.readUInt32BE(e + 12);
  const raw = w.subarray(off, off + comp);
  cmap = comp < orig ? inflateSync(raw) : raw;
}
const has = new Set();
for (let i = 0, n = cmap.readUInt16BE(2); i < n; i++) {
  const off = cmap.readUInt32BE(4 + i * 8 + 4), t = cmap.subarray(off), fmt = t.readUInt16BE(0);
  if (fmt === 12) {
    for (let g = 0, ng = t.readUInt32BE(12); g < ng; g++) {
      const a = t.readUInt32BE(16 + g * 12), b = t.readUInt32BE(20 + g * 12);
      for (let c = a; c <= b; c++) has.add(c);
    }
  } else if (fmt === 4) {
    const seg = t.readUInt16BE(6) / 2;
    for (let s = 0; s < seg; s++) {
      const end = t.readUInt16BE(14 + s * 2), start = t.readUInt16BE(16 + seg * 2 + s * 2);
      for (let c = start; c <= end && c !== 0xffff; c++) has.add(c);
    }
  }
}
const missing = [...new Set(text)].filter((ch) => ch.trim() && !has.has(ch.codePointAt(0)));
console.log(file.split(/[\/]/).pop(), has.size, 'chars; missing:', missing.join('') || '(none)');
