# -*- coding: utf-8 -*-
"""Generate TechProposal Studio / 构案 app icon master PNG (1024x1024)."""
from __future__ import annotations

from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter

OUT = Path(r"D:\nas\myproject\tech-proposal-studio\src-tauri\icons\app-icon-source.png")
SIZE = 1024


def lerp(a, b, t):
    return tuple(int(a[i] + (b[i] - a[i]) * t) for i in range(len(a)))


def rounded_rect_mask(size, radius):
    m = Image.new("L", size, 0)
    d = ImageDraw.Draw(m)
    d.rounded_rectangle([0, 0, size[0] - 1, size[1] - 1], radius=radius, fill=255)
    return m


def main():
    # Brand: deep indigo → teal accent (tech proposal / architecture feel)
    bg_top = (30, 41, 78)       # #1e294e
    bg_bot = (15, 23, 48)       # #0f1730
    accent = (94, 234, 212)     # teal-300
    accent2 = (125, 211, 252)   # sky-300
    paper = (248, 250, 252)     # slate-50
    ink = (30, 41, 59)          # slate-800
    line = (148, 163, 184)      # slate-400

    img = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    # Background with vertical gradient
    bg = Image.new("RGBA", (SIZE, SIZE))
    px = bg.load()
    for y in range(SIZE):
        t = y / (SIZE - 1)
        c = lerp(bg_top, bg_bot, t)
        for x in range(SIZE):
            # subtle radial light from top-left
            dx = (x - SIZE * 0.28) / SIZE
            dy = (y - SIZE * 0.22) / SIZE
            glow = max(0.0, 1.0 - (dx * dx + dy * dy) * 3.2) * 28
            px[x, y] = (
                min(255, int(c[0] + glow)),
                min(255, int(c[1] + glow * 0.9)),
                min(255, int(c[2] + glow * 1.1)),
                255,
            )
    mask = rounded_rect_mask((SIZE, SIZE), radius=int(SIZE * 0.22))
    img.paste(bg, (0, 0), mask)

    draw = ImageDraw.Draw(img)

    # Soft outer ring (glass)
    pad = int(SIZE * 0.06)
    draw.rounded_rectangle(
        [pad, pad, SIZE - pad - 1, SIZE - pad - 1],
        radius=int(SIZE * 0.18),
        outline=(*accent2, 40),
        width=max(2, SIZE // 180),
    )

    # Document card
    doc_w, doc_h = int(SIZE * 0.46), int(SIZE * 0.56)
    doc_x = int(SIZE * 0.22)
    doc_y = int(SIZE * 0.20)
    doc = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    dd = ImageDraw.Draw(doc)
    # shadow
    shadow = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    sd = ImageDraw.Draw(shadow)
    sd.rounded_rectangle(
        [doc_x + 10, doc_y + 18, doc_x + doc_w + 10, doc_y + doc_h + 18],
        radius=int(SIZE * 0.05),
        fill=(0, 0, 0, 90),
    )
    shadow = shadow.filter(ImageFilter.GaussianBlur(radius=18))
    img = Image.alpha_composite(img, shadow)
    draw = ImageDraw.Draw(img)

    # folded corner
    fold = int(SIZE * 0.11)
    dd.rounded_rectangle(
        [doc_x, doc_y, doc_x + doc_w, doc_y + doc_h],
        radius=int(SIZE * 0.045),
        fill=(*paper, 255),
    )
    # corner fold polygon
    cx, cy = doc_x + doc_w, doc_y
    dd.polygon(
        [
            (cx - fold, cy),
            (cx, cy + fold),
            (cx - fold, cy + fold),
        ],
        fill=(226, 232, 240, 255),
    )
    dd.polygon(
        [
            (cx - fold, cy),
            (cx, cy),
            (cx, cy + fold),
        ],
        fill=(203, 213, 225, 255),
    )
    img = Image.alpha_composite(img, doc)
    draw = ImageDraw.Draw(img)

    # Text lines on document
    lx0 = doc_x + int(SIZE * 0.07)
    lx1 = doc_x + doc_w - int(SIZE * 0.07)
    y0 = doc_y + int(SIZE * 0.16)
    gap = int(SIZE * 0.055)
    widths = [1.0, 0.92, 0.78, 0.88, 0.65]
    for i, w in enumerate(widths):
        y = y0 + i * gap
        x1 = lx0 + int((lx1 - lx0) * w)
        # first line as "title" thicker
        th = max(6, SIZE // (70 if i == 0 else 95))
        color = (*ink, 220) if i == 0 else (*line, 200)
        draw.rounded_rectangle([lx0, y, x1, y + th], radius=th // 2, fill=color)

    # Accent structure mark — left rail / chapter bar (构案 architecture)
    bar_x = doc_x + int(SIZE * 0.045)
    bar_y = doc_y + int(SIZE * 0.14)
    bar_h = int(SIZE * 0.28)
    draw.rounded_rectangle(
        [bar_x, bar_y, bar_x + max(8, SIZE // 55), bar_y + bar_h],
        radius=6,
        fill=(*accent, 255),
    )

    # Floating pen / stylus suggesting writing proposals
    pen = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    pd = ImageDraw.Draw(pen)
    # pen body rotated via affine-ish polygon
    # tip near bottom-right of doc
    tip_x, tip_y = doc_x + doc_w - int(SIZE * 0.02), doc_y + doc_h - int(SIZE * 0.08)
    # diagonal pen
    length = int(SIZE * 0.38)
    width = max(10, SIZE // 42)
    # unit direction (up-right)
    import math
    ang = math.radians(-52)
    dx, dy = math.cos(ang), math.sin(ang)
    px_, py_ = -dy, dx  # perpendicular

    def pt(along, across):
        return (
            tip_x + dx * along + px_ * across,
            tip_y + dy * along + py_ * across,
        )

    body = [
        pt(width * 0.6, 0),
        pt(length, width * 0.55),
        pt(length, -width * 0.55),
        pt(width * 0.6, 0),
    ]
    # tip triangle
    tip = [pt(0, 0), pt(width * 1.1, width * 0.55), pt(width * 1.1, -width * 0.55)]
    pd.polygon(tip, fill=(15, 23, 42, 255))
    pd.polygon(
        [pt(width * 0.9, width * 0.5), pt(length * 0.72, width * 0.5), pt(length * 0.72, -width * 0.5), pt(width * 0.9, -width * 0.5)],
        fill=(*accent, 255),
    )
    pd.polygon(
        [pt(length * 0.72, width * 0.52), pt(length, width * 0.52), pt(length, -width * 0.52), pt(length * 0.72, -width * 0.52)],
        fill=(*accent2, 255),
    )
    # metal band
    pd.polygon(
        [pt(length * 0.68, width * 0.55), pt(length * 0.74, width * 0.55), pt(length * 0.74, -width * 0.55), pt(length * 0.68, -width * 0.55)],
        fill=(241, 245, 249, 255),
    )
    # soft shadow under pen
    pen_shadow = pen.filter(ImageFilter.GaussianBlur(8))
    # offset shadow
    sh = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    sh.paste((0, 0, 0, 70), (8, 12), pen.split()[-1])
    sh = sh.filter(ImageFilter.GaussianBlur(10))
    img = Image.alpha_composite(img, sh)
    img = Image.alpha_composite(img, pen)

    # small sparkle / node (AI hint)
    draw = ImageDraw.Draw(img)
    sx, sy = int(SIZE * 0.78), int(SIZE * 0.22)
    r = int(SIZE * 0.035)
    draw.ellipse([sx - r, sy - r, sx + r, sy + r], fill=(*accent, 230))
    draw.ellipse([sx - r // 2, sy - r // 2, sx + r // 2, sy + r // 2], fill=(255, 255, 255, 200))

    # re-apply rounded mask to clip anything outside
    final = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    final.paste(img, (0, 0), mask)
    OUT.parent.mkdir(parents=True, exist_ok=True)
    final.save(OUT, "PNG")
    print(f"wrote {OUT} {final.size}")


if __name__ == "__main__":
    main()
