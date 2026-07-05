#!/usr/bin/env python3
"""Compose Attio App Store listing frames (2960x1848, 16:10) from the raw app
captures. Regenerate raws first:
  cd packages/desktop && SKIP_E2E_BUILD=1 pnpm e2e:fast listing-shots.spec.ts
then: python3 marketing/attio-app-store/compose.py
Attio requires marketing-quality images (raw screenshots are rejected):
https://docs.attio.com/share/listing-images
"""
from PIL import Image, ImageDraw, ImageFilter, ImageFont
import glob, os

DIR = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(DIR, "..", ".."))
W, H = 2960, 1848

def load_font(size, bold=True):
    # DM Sans ships in the web app's next/font output; Helvetica Neue fallback.
    for c in sorted(glob.glob(os.path.join(ROOT, "apps/web/.next/static/media/*.woff2"))):
        try:
            return ImageFont.truetype(c, size)
        except Exception:
            continue
    for sys in ["/System/Library/Fonts/HelveticaNeue.ttc", "/System/Library/Fonts/Helvetica.ttc"]:
        try:
            return ImageFont.truetype(sys, size, index=1 if bold else 0)
        except Exception:
            continue
    return ImageFont.load_default()

def gradient_bg():
    top, bottom = (248, 248, 250), (234, 247, 238)  # --bg → soft green tint
    bg = Image.new("RGB", (W, H))
    px = bg.load()
    for y in range(H):
        t = y / (H - 1)
        row = tuple(int(top[i] + (bottom[i] - top[i]) * t) for i in range(3))
        for x in range(W):
            px[x, y] = row
    return bg

def rounded(im, radius):
    mask = Image.new("L", im.size, 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, im.size[0], im.size[1]], radius=radius, fill=255)
    out = Image.new("RGBA", im.size)
    out.paste(im, (0, 0), mask)
    return out

SHOTS = [
    ("raw-1-wizard-configure.png", "attio-listing-1.png", "Choose exactly what syncs from Attio"),
    ("raw-2-synced-grid.png", "attio-listing-2.png", "Your Attio records, live in an AI grid"),
    ("raw-3-sync-log.png", "attio-listing-3.png", "Every sync, explained in plain English"),
]

font_h, font_sub = load_font(88), load_font(40, bold=False)

for raw_name, out_name, headline in SHOTS:
    bg = gradient_bg().convert("RGBA")
    d = ImageDraw.Draw(bg)
    tw = d.textlength(headline, font=font_h)
    d.text(((W - tw) / 2, 120), headline, font=font_h, fill=(17, 17, 24))
    sub = "GTM Grid × Attio — read-only sync, refreshed daily"
    sw = d.textlength(sub, font=font_sub)
    d.text(((W - sw) / 2, 248), sub, font=font_sub, fill=(90, 90, 110))

    raw = Image.open(os.path.join(DIR, raw_name)).convert("RGB")
    card_w = 2400
    card_h = int(card_w * raw.size[1] / raw.size[0])
    card = rounded(raw.resize((card_w, card_h), Image.LANCZOS), 28)
    cx, cy = (W - card_w) // 2, 380
    visible_h = H - cy

    sh = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    ImageDraw.Draw(sh).rounded_rectangle(
        [cx - 4, cy + 18, cx + card_w + 4, cy + visible_h + 60], radius=30, fill=(13, 30, 20, 70)
    )
    bg = Image.alpha_composite(bg, sh.filter(ImageFilter.GaussianBlur(36)))

    bordered = Image.new("RGBA", (card_w + 4, card_h + 4), (0, 0, 0, 0))
    ImageDraw.Draw(bordered).rounded_rectangle([0, 0, card_w + 3, card_h + 3], radius=30, fill=(228, 228, 234, 255))
    bordered.paste(card, (2, 2), card)
    clip = bordered.crop((0, 0, card_w + 4, visible_h))
    bg.paste(clip, (cx, cy), clip)

    out = bg.convert("RGB")
    assert out.size == (W, H)
    out.save(os.path.join(DIR, out_name), "PNG")
    print(out_name, out.size)
