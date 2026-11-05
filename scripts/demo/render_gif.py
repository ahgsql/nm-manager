"""Turns the captures from record.sh into README GIFs. Needs Pillow.

Usage: python render_gif.py <capture-dir> <output-dir>
Only the pace is staged; every line of text is the program's real output.
"""
import json
import re
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

COLS, ROWS = 92, 26
FONT_SIZE, CELL_W, CELL_H, PAD = 15, 9, 20, 16
BG, FG, DIM, GREEN, YELLOW, PROMPT = "#14181a", "#d9dfdc", "#7d8a84", "#58d68d", "#e6b45c", "#5ec8e5"
ANSI = re.compile(r"\x1b\[(\d+)m")


def load_font(bold):
    names = ["consolab.ttf"] if bold else ["consola.ttf"]
    names += ["DejaVuSansMono-Bold.ttf" if bold else "DejaVuSansMono.ttf"]
    for name in names:
        try:
            return ImageFont.truetype(name, FONT_SIZE)
        except OSError:
            continue
    raise SystemExit("No monospace font found")


REGULAR, BOLD = load_font(False), load_font(True)


def spans(line):
    """Splits a line into (text, colour, bold) using the ANSI codes the CLI emits."""
    color, bold, result, position = FG, False, [], 0
    for match in ANSI.finditer(line):
        if match.start() > position:
            result.append((line[position:match.start()], color, bold))
        code = match.group(1)
        if code == "0":
            color, bold = FG, False
        elif code == "1":
            bold = True
        elif code == "2":
            color = DIM
        elif code == "32":
            color = GREEN
        elif code == "33":
            color = YELLOW
        position = match.end()
    result.append((line[position:], color, bold))
    return result


def draw_terminal(lines):
    image = Image.new("RGB", (COLS * CELL_W + PAD * 2, ROWS * CELL_H + PAD * 2), BG)
    draw = ImageDraw.Draw(image)
    for row, line in enumerate(lines[-ROWS:]):
        column = 0
        for text, color, bold in spans(line):
            draw.text((PAD + column * CELL_W, PAD + row * CELL_H), text, fill=color, font=BOLD if bold else REGULAR)
            column += len(text)
    return image


def save_gif(path, frames, durations):
    palette = [frame.convert("P", palette=Image.ADAPTIVE, colors=128) for frame in frames]
    palette[0].save(path, save_all=True, append_images=palette[1:], duration=durations, loop=0, optimize=True, disposal=1)
    print(f"{path}: {len(frames)} frames, {path.stat().st_size / 1024:.0f} KB")


def terminal_gif(capture, output):
    steps = json.loads((capture / "terminal.json").read_text(encoding="utf8"))
    lines, frames, durations = [], [], []

    def show(duration):
        frames.append(draw_terminal(lines))
        durations.append(duration)

    for step in steps:
        prompt = f"\x1b[36m~\x1b[0m $ "
        command = step["command"]
        lines.append(prompt)
        show(350)
        for end in range(3, len(command) + 3, 3):
            lines[-1] = prompt + command[:end]
            show(45)
        show(300)
        output_lines = step["output"].rstrip("\n").split("\n")
        for index, line in enumerate(output_lines):
            lines.append(line[:COLS * 3])
            show(60 if index < len(output_lines) - 1 else 100)
        show(2800)
        lines.append("")
    durations[-1] = 5000
    save_gif(output / "demo.gif", frames, durations)


def ui_gif(capture, output):
    data = json.loads((capture / "ui" / "frames.json").read_text(encoding="utf8"))
    frames = [Image.open(capture / "ui" / item["file"]).convert("RGB") for item in data["frames"]]
    frames = [frame.resize((832, int(frame.height * 832 / frame.width)), Image.LANCZOS) for frame in frames]
    save_gif(output / "demo-ui.gif", frames, [item["hold"] for item in data["frames"]])
    Image.open(capture / "ui" / "still-done.png").save(output / "ui.png", optimize=True)


def main():
    capture, output = Path(sys.argv[1]), Path(sys.argv[2])
    output.mkdir(parents=True, exist_ok=True)
    terminal_gif(capture, output)
    ui_gif(capture, output)


if __name__ == "__main__":
    main()
