# Usage: python3 scripts/sheet.py <dir> <out_prefix> [cols] — contact sheet of t*.png frames
import sys, glob, re
from PIL import Image, ImageDraw
d, out = sys.argv[1], sys.argv[2]
cols = int(sys.argv[3]) if len(sys.argv) > 3 else 6
def tval(p): return float(re.search(r't([\d_]+)\.png', p).group(1).replace('_', '.'))
fs = sorted(glob.glob(d + '/t*.png'), key=tval)
tw, th = 400, 409
per = cols * 3
for s in range(0, len(fs), per):
    chunk = fs[s:s + per]
    rows = (len(chunk) + cols - 1) // cols
    sheet = Image.new('RGB', (cols * tw, rows * th), 'white')
    for i, f in enumerate(chunk):
        im = Image.open(f).convert('RGB').crop((560, 0, 1440, 900)).resize((tw, th))
        ImageDraw.Draw(im).text((6, 6), 't=%.2f' % tval(f), fill=(220, 0, 0))
        sheet.paste(im, ((i % cols) * tw, (i // cols) * th))
    sheet.save('%s%d.png' % (out, s // per))
    print('%s%d.png' % (out, s // per))
