"""Renders docs/promo.gif, a short illustrative animation. Needs Pillow.

The sizes shown are made up for the animation; docs/demo.gif shows a real run.
Usage: python render_promo.py <output.gif>
"""
import sys

from PIL import Image, ImageDraw, ImageFont

W, H, SS, FRAME_MS = 600, 338, 2, 50
OUT_W, OUT_H = 480, 270
BG, TEXT, MUTED, GREEN, RED, LINE = "#0f1412", "#eef2ef", "#8b9a92", "#4fe39a", "#ff6b5e", "#26302b"
PROJECTS = ["shop", "blog", "admin", "intro", "api"]
CHIPS = [
    ("#61dafb", 72), ("#f7df1e", 48), ("#bd93f9", 100), ("#ff79c6", 40),
    ("#ffb86c", 68), ("#50fa7b", 34), ("#8be9fd", 58), ("#ff5555", 50),
]
BEFORE, AFTER = 52.4, 11.8
SCENES = {"fill": 14, "hold": 6, "merge": 30, "reveal": 18, "cta": 16, "fade": 4}


def font(name, size):
    for candidate in name:
        try:
            return ImageFont.truetype(candidate, size * SS)
        except OSError:
            continue
    raise SystemExit("Font not found")


SANS = ("segoeuib.ttf", "DejaVuSans-Bold.ttf")
MONO = ("consolab.ttf", "DejaVuSansMono-Bold.ttf")
HEAD, LABEL, COUNT = font(SANS, 21), font(MONO, 13), font(SANS, 25)
TAG, CTA = font(SANS, 16), font(MONO, 22)


def rgb(color):
    return tuple(int(color[i:i + 2], 16) for i in (1, 3, 5))


def mix(a, b, t):
    """Blends colour a toward b by t (0 keeps a)."""
    t = max(0.0, min(1.0, t))
    return tuple(round(x + (y - x) * t) for x, y in zip(rgb(a), rgb(b)))


def ease(t):
    t = max(0.0, min(1.0, t))
    return t * t * (3 - 2 * t)


def back(t):
    t = max(0.0, min(1.0, t)) - 1
    return 1 + 2.4 * t ** 3 + 1.4 * t ** 2


ROW_Y = [66 + i * 38 for i in range(len(PROJECTS))]
STORE_Y = ROW_Y[-1] + 44
CHIP_X0, CHIP_H = 78, 24
_x = CHIP_X0
CHIP_X = []
for _color, _width in CHIPS:
    CHIP_X.append(_x)
    _x += _width + 4


def rect(draw, x, y, w, h, fill=None, outline=None, radius=5):
    box = [x * SS, y * SS, (x + w) * SS, (y + h) * SS]
    draw.rounded_rectangle(box, radius * SS, fill=fill, outline=outline, width=SS)


def text(draw, xy, value, typeface, fill, anchor="la"):
    draw.text((xy[0] * SS, xy[1] * SS), value, font=typeface, fill=fill, anchor=anchor)


def base_scene(draw, fill_t, merge_t):
    headline = "Same packages. Copied everywhere." if merge_t <= 0.15 else "Keep one. Link the rest."
    text(draw, (24, 18), headline, HEAD, TEXT)
    size = BEFORE + (AFTER - BEFORE) * ease(merge_t)
    text(draw, (W - 24, 17), f"{size:.1f} GB", COUNT, mix(RED, GREEN, merge_t * 1.4), "ra")

    for row, (name, y) in enumerate(zip(PROJECTS, ROW_Y)):
        text(draw, (24, y + 12), name, LABEL, MUTED, "lm")
        for index, ((color, width), x) in enumerate(zip(CHIPS, CHIP_X)):
            appear = ease(fill_t * 2.2 - (row * 0.16 + index * 0.05))
            if appear <= 0:
                continue
            start = (index * 0.045 + (4 - row) * 0.05)
            move = ease((merge_t - start) / 0.48)
            rect(draw, x, y, width, CHIP_H, outline=mix(BG, LINE, move))
            if move < 1:
                chip_y = y + (STORE_Y - y) * move
                rect(draw, x, chip_y, width, CHIP_H, fill=mix(BG, color, appear * (1 - move * 0.25)))

    store_t = ease(merge_t * 3)
    if store_t > 0:
        text(draw, (24, STORE_Y + 12), "store", LABEL, mix(BG, GREEN, store_t), "lm")
        for index, ((color, width), x) in enumerate(zip(CHIPS, CHIP_X)):
            landed = ease((merge_t - (index * 0.045 + 0.2)) / 0.48)
            if landed > 0:
                rect(draw, x, STORE_Y, width, CHIP_H, fill=mix(BG, color, landed))


def blank():
    return Image.new("RGB", (W * SS, H * SS), BG)


def finish(image, fade=0.0):
    image = image.resize((OUT_W, OUT_H), Image.LANCZOS)
    return Image.blend(image, Image.new("RGB", (OUT_W, OUT_H), BG), fade) if fade else image


def scene_frame(fill_t, merge_t):
    image = blank()
    base_scene(ImageDraw.Draw(image), fill_t, merge_t)
    return image


def reveal_frame(backdrop, reveal_t, cta_t, fade=0.0):
    image = Image.blend(backdrop, blank(), ease(reveal_t * 2.5))
    draw = ImageDraw.Draw(image)
    pop_t = (reveal_t - 0.25) / 0.55
    if pop_t > 0:
        big = font(SANS, max(8, round(62 * back(pop_t))))
        text(draw, (W / 2, 118), f"{BEFORE - AFTER:.1f} GB freed", big, GREEN, "mm")
    tag_t = ease(reveal_t * 3 - 1.2)
    if tag_t > 0:
        text(draw, (W / 2, 172), "Same projects. No migration. Undo anytime.", TAG, mix(BG, TEXT, tag_t), "mm")
    if cta_t > 0:
        appear = ease(cta_t * 3)
        offset = (1 - appear) * 10
        rect(draw, W / 2 - 150, 212 + offset, 300, 50, fill=mix(BG, "#1a2420", appear), outline=mix(BG, GREEN, appear), radius=9)
        typed = "npx nm-manager"[: round(14 * min(1.0, cta_t * 2.5))]
        text(draw, (W / 2 - 124, 237 + offset), f"$ {typed}", CTA, mix(BG, TEXT, appear), "lm")
    return finish(image, fade)


def main():
    frames, durations = [], []
    scenes = SCENES

    def add(frame, hold=FRAME_MS):
        frames.append(frame)
        durations.append(hold)

    for i in range(scenes["fill"]):
        add(finish(scene_frame(i / (scenes["fill"] - 1), 0)))
    add(finish(scene_frame(1, 0)), FRAME_MS * scenes["hold"])
    for i in range(scenes["merge"]):
        add(finish(scene_frame(1, i / (scenes["merge"] - 1))))
    backdrop = scene_frame(1, 1)
    for i in range(scenes["reveal"]):
        add(reveal_frame(backdrop, i / (scenes["reveal"] - 1), 0))
    for i in range(scenes["cta"]):
        add(reveal_frame(backdrop, 1, i / (scenes["cta"] - 1)))
    add(reveal_frame(backdrop, 1, 1), 1700)
    for i in range(scenes["fade"]):
        add(reveal_frame(backdrop, 1, 1, (i + 1) / scenes["fade"]))

    # One shared palette prevents colours flickering between frames.
    sample = Image.new("RGB", (OUT_W, OUT_H * 4))
    picks = (frames[scenes["fill"]], frames[len(frames) // 3], frames[len(frames) // 2], frames[-6])
    for slot, frame in enumerate(picks):
        sample.paste(frame, (0, slot * OUT_H))
    palette = sample.quantize(colors=64, method=Image.MEDIANCUT)
    indexed = [frame.quantize(palette=palette, dither=Image.NONE) for frame in frames]
    indexed[0].save(sys.argv[1], save_all=True, append_images=indexed[1:], duration=durations, loop=0, optimize=True, disposal=1)


if __name__ == "__main__":
    main()
