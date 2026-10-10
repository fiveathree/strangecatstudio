#!/usr/bin/env python3
"""Build the site's web fonts.

The pages use Google's Noto Sans TC (body) and Noto Serif TC (headings), both
free under the SIL Open Font License. A full Chinese font is several megabytes,
so instead of loading the whole thing this script keeps only the characters
that actually appear on the site and writes four small files to assets/fonts/.

Run it again whenever the site's text changes; a character that is missing
from the subset simply falls back to the device's own font.

    python3 tools/build_fonts.py

Needs: fonttools, playwright (with Chromium), and the Noto CJK fonts installed
(Debian/Ubuntu: fonts-noto-cjk fonts-noto-cjk-extra).
"""
import asyncio
import pathlib

from fontTools import subset
from fontTools.ttLib import TTCollection
from playwright.async_api import async_playwright

ROOT = pathlib.Path(__file__).resolve().parent.parent
OUT = ROOT / 'assets' / 'fonts'
NOTO = pathlib.Path('/usr/share/fonts/opentype/noto')
TC_INDEX = 3  # position of the Traditional Chinese face inside each .ttc

# output name -> source collection
FACES = {
    'sans-regular': 'NotoSansCJK-Regular.ttc',
    'sans-bold': 'NotoSansCJK-Bold.ttc',
    'serif-medium': 'NotoSerifCJK-Medium.ttc',
    'serif-bold': 'NotoSerifCJK-Bold.ttc',
}
# Always included, so prices, dates and typed text render in the web font.
BASICS = ''.join(chr(c) for c in range(0x20, 0x7F)) + '，。、；：！？「」（）［］【】・／～–—…×＋％＠ ' + '0123456789'

# Sorts every piece of text on a page into the face the browser will use for it.
COLLECT = """
() => {
  const out = {'sans-regular': '', 'sans-bold': '', 'serif-medium': '', 'serif-bold': ''};
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) {
    const node = walker.currentNode;
    const el = node.parentElement;
    if (!el || ['SCRIPT', 'STYLE'].includes(el.tagName)) continue;
    const cs = getComputedStyle(el);
    const family = cs.fontFamily.includes('Serif') ? 'serif' : 'sans';
    const heavy = parseInt(cs.fontWeight, 10) >= 600;
    const key = family === 'serif' ? (heavy ? 'serif-bold' : 'serif-medium') : (heavy ? 'sans-bold' : 'sans-regular');
    out[key] += node.nodeValue;
  }
  document.querySelectorAll('[placeholder]').forEach(e => { out['sans-regular'] += e.placeholder; });
  return out;
}
"""


async def collect_text():
    buckets = {k: set(BASICS) for k in FACES}
    async with async_playwright() as p:
        browser = await p.chromium.launch()
        page = await browser.new_page()
        for html in sorted(ROOT.glob('*.html')):
            await page.goto(html.as_uri())
            await page.wait_for_timeout(300)
            found = await page.evaluate(COLLECT)
            for key, text in found.items():
                buckets[key].update(text)
        await browser.close()
    return buckets


def build(name, source, chars):
    font = TTCollection(str(NOTO / source)).fonts[TC_INDEX]
    options = subset.Options()
    options.flavor = 'woff'
    options.layout_features = ['kern', 'liga', 'locl']  # drop vertical/alternate forms the site never uses
    options.hinting = False
    options.desubroutinize = True
    options.name_IDs = [1, 2]
    options.notdef_outline = True
    sub = subset.Subsetter(options)
    sub.populate(text=''.join(sorted(chars)))
    sub.subset(font)
    font.flavor = 'woff'
    target = OUT / (name + '.woff')
    font.save(str(target))
    print('%-14s %4d characters  %4d KB' % (name, len(chars), target.stat().st_size // 1024))


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    buckets = asyncio.run(collect_text())
    # Text that scripts add after load (booking widget, admin page) is not in
    # the page yet when it is scanned, so take it from the script sources.
    scripted = set()
    for src in list((ROOT / 'js').glob('*.js')) + [ROOT / 'admin.html']:
        scripted.update(ch for ch in src.read_text(encoding='utf-8') if ord(ch) > 0x2E7F)
    buckets['sans-regular'] |= scripted
    buckets['sans-bold'] |= scripted
    buckets['serif-medium'] |= scripted
    for name, source in FACES.items():
        build(name, source, buckets[name])


if __name__ == '__main__':
    main()
