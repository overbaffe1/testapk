#!/usr/bin/env python3
"""Генерирует иконки расширения (PNG) без внешних зависимостей."""
import math
import struct
import zlib
from pathlib import Path

OUT = Path(__file__).resolve().parent.parent / "extension" / "icons"


def lerp(a, b, t):
    return tuple(round(a[i] + (b[i] - a[i]) * t) for i in range(3))


def rounded_alpha(x, y, size, radius):
    """Сглаженная альфа маска скруглённого квадрата."""
    cx = min(max(x, radius), size - radius)
    cy = min(max(y, radius), size - radius)
    dist = math.hypot(x - cx, y - cy)
    return max(0.0, min(1.0, radius - dist + 0.5))


def circle_alpha(x, y, size, cx, cy, r):
    dist = math.hypot(x - cx, y - cy)
    return max(0.0, min(1.0, r - dist + 0.5))


def build(size):
    pixels = []
    s = size
    for y in range(s):
        row = bytearray()
        for x in range(s):
            t = (x + y) / (2 * s)
            base = lerp((76, 141, 255), (122, 92, 255), t)
            a = rounded_alpha(x + 0.5, y + 0.5, s, s * 0.22)
            # Белая "q": кольцо + хвост вниз-вправо.
            ring = circle_alpha(x + 0.5, y + 0.5, s, s * 0.46, s * 0.44, s * 0.24)
            inner = circle_alpha(x + 0.5, y + 0.5, s, s * 0.46, s * 0.44, s * 0.13)
            glyph = max(0.0, ring - inner)
            tail_x = s * 0.60
            tail_y0, tail_y1 = s * 0.55, s * 0.78
            if tail_x - s * 0.055 <= x + 0.5 <= tail_x + s * 0.055 and tail_y0 <= y + 0.5 <= tail_y1:
                glyph = max(glyph, 1.0)
            r = round(base[0] * (1 - glyph) + 255 * glyph)
            g = round(base[1] * (1 - glyph) + 255 * glyph)
            b = round(base[2] * (1 - glyph) + 255 * glyph)
            row += bytes((r, g, b, round(a * 255)))
        pixels.append(bytes(row))
    return pixels


def write_png(path, size, rows):
    raw = b"".join(b"\x00" + row for row in rows)

    def chunk(tag, data):
        body = tag + data
        return struct.pack(">I", len(data)) + body + struct.pack(">I", zlib.crc32(body) & 0xFFFFFFFF)

    png = b"\x89PNG\r\n\x1a\n"
    png += chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0))
    png += chunk(b"IDAT", zlib.compress(raw, 9))
    png += chunk(b"IEND", b"")
    path.write_bytes(png)


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    for size in (16, 48, 128):
        rows = build(size)
        write_png(OUT / f"icon{size}.png", size, rows)
        print(f"icon{size}.png")


if __name__ == "__main__":
    main()
