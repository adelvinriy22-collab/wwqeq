"""Прибрати темний фон зі скріншота подарунка Telegram і зберегти компактний PNG 200×200
(прозорий фон, палітра 256 кольорів — ~10 КБ) для web/img/<id>.png.

    python3 scripts/cutout-gift.py скріншот.jpg web/img/rose.png [--glow]

--glow — для подарунків із сяйвом (свічки торта): сяйво стає напівпрозорим.
Потрібен Pillow (pip install pillow) — лише для розробки, не для бота."""
import sys
from collections import deque
from PIL import Image, ImageFilter

SIZE = 200


def is_bg(p, strict=False):
    r, g, b = p[:3]
    mx, mn = max(r, g, b), min(r, g, b)
    # Фон — темний і сірий (без кольору). Обводки подарунків кольорові, тож лишаються.
    return mx < (58 if strict else 72) and (mx - mn) < 20


def cutout(src, dst):
    im = Image.open(src).convert('RGBA')
    w, h = im.size
    px = im.load()
    bg = [[False] * w for _ in range(h)]
    q = deque()
    for x in range(w):
        for y in (0, h - 1):
            if is_bg(px[x, y]): q.append((x, y)); bg[y][x] = True
    for y in range(h):
        for x in (0, w - 1):
            if is_bg(px[x, y]) and not bg[y][x]: q.append((x, y)); bg[y][x] = True
    while q:
        x, y = q.popleft()
        for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            nx, ny = x + dx, y + dy
            if 0 <= nx < w and 0 <= ny < h and not bg[ny][nx] and is_bg(px[nx, ny]):
                bg[ny][nx] = True
                q.append((nx, ny))
    mask = Image.new('L', (w, h), 255)
    mp = mask.load()
    for y in range(h):
        for x in range(w):
            if bg[y][x]: mp[x, y] = 0
    # М'який край замість «драбинки».
    mask = mask.filter(ImageFilter.MinFilter(3)).filter(ImageFilter.GaussianBlur(1.1))
    im.putalpha(mask)
    if GLOW:
        # Сяйво (полум'я свічок) на темному тлі — «віднімаємо» тло: темно-жовті
        # пікселі стають напівпрозорим жовтим замість брудно-оливкового.
        BG = 28
        px2 = im.load()
        for y in range(h):
            for x in range(w):
                r, g, b, a0 = px2[x, y]
                if a0 == 0:
                    continue
                mx = max(r, g, b)
                if mx < 175 and r >= g * 0.85 and g > b * 1.35 and b < 110:
                    a = max(0.0, min(1.0, (mx - BG) / (200 - BG)))
                    if a <= 0.02:
                        px2[x, y] = (0, 0, 0, 0)
                        continue
                    un = lambda c: int(max(0, min(255, (c - BG * (1 - a)) / a)))
                    px2[x, y] = (un(r), un(g), un(b), int(a0 * a))
    box = mask.point(lambda v: 255 if v > 40 else 0).getbbox()
    if box:
        im = im.crop(box)
    # Квадрат із невеликим відступом, як у наявних призів.
    cw, ch = im.size
    side = int(max(cw, ch) * 1.08)
    canvas = Image.new('RGBA', (side, side), (0, 0, 0, 0))
    canvas.paste(im, ((side - cw) // 2, (side - ch) // 2), im)
    canvas = canvas.resize((SIZE, SIZE), Image.LANCZOS)
    # Палітра на 256 кольорів — у кілька разів менший файл, прозорість зберігається.
    small = canvas.quantize(colors=256, method=Image.Quantize.FASTOCTREE)
    small.save(dst, optimize=True)


GLOW = False
if __name__ == '__main__':
    GLOW = '--glow' in sys.argv
    cutout(sys.argv[1], sys.argv[2])
