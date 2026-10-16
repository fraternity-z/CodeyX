"""生成 CodeyX 桌面图标：python scripts/generate-app-icons.py（依赖 Pillow）。"""

from math import hypot
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter


ROOT = Path(__file__).resolve().parents[1]
ICON_DIR = ROOT / "backend" / "icons"
ICO_SIZES = (16, 20, 24, 32, 40, 48, 64, 96, 128, 256)
ICNS_SIZES = (16, 32, 64, 128, 256, 512, 1024)

# 开口 C 与提示符共用 45° 斜面，间隙在缩小后仍保持可辨。
C_OUTLINE = (
    (584, 252), (370, 252), (214, 408), (214, 616),
    (370, 772), (584, 772), (664, 692), (584, 612),
    (536, 660), (416, 660), (326, 570), (326, 454),
    (416, 364), (536, 364), (584, 412), (664, 332),
)
PROMPT_OUTLINE = (
    (680, 386), (806, 512), (680, 638),
    (616, 574), (678, 512), (616, 450),
)


def rounded_polygon(points, radius, scale):
    """在原始坐标中沿每条边留出相同的圆角距离。"""
    outline = []
    for index, corner in enumerate(points):
        previous = points[index - 1]
        following = points[(index + 1) % len(points)]
        incoming = hypot(previous[0] - corner[0], previous[1] - corner[1])
        outgoing = hypot(following[0] - corner[0], following[1] - corner[1])
        inset = min(radius, incoming / 3, outgoing / 3)
        start = tuple(
            corner[axis] + (previous[axis] - corner[axis]) * inset / incoming
            for axis in (0, 1)
        )
        end = tuple(
            corner[axis] + (following[axis] - corner[axis]) * inset / outgoing
            for axis in (0, 1)
        )
        for step in range(17):
            t = step / 16
            outline.append(tuple(
                ((1 - t) ** 2 * start[axis]
                 + 2 * (1 - t) * t * corner[axis]
                 + t ** 2 * end[axis]) * scale
                for axis in (0, 1)
            ))
    return outline


def gradient(size, top, bottom):
    image = Image.new("RGBA", (size, size))
    draw = ImageDraw.Draw(image)
    for y in range(size):
        fraction = y / (size - 1)
        color = tuple(round(a + (b - a) * fraction) for a, b in zip(top, bottom))
        draw.line((0, y, size, y), fill=(*color, 255))
    return image


def render_icon(size):
    # 小图标增大可用面积，省去边缘反光；在高分辨率下绘制后统一抗锯齿。
    small = size <= 32
    working_size = max(size * 4, 512)
    scale = working_size / 1024
    margin = 40 if small else 64
    image = Image.new("RGBA", (working_size, working_size))
    tile = Image.new("L", image.size)
    tile_draw = ImageDraw.Draw(tile)
    bounds = tuple(value * scale for value in (margin, margin, 1024 - margin, 1024 - margin))
    tile_draw.rounded_rectangle(bounds, radius=212 * scale, fill=255)
    background = gradient(working_size, (27, 45, 39), (11, 23, 21))
    image.paste(background, (0, 0), tile)

    if not small:
        edge = Image.new("RGBA", image.size)
        ImageDraw.Draw(edge).rounded_rectangle(
            bounds, radius=212 * scale, outline=(169, 211, 185, 36),
            width=max(1, round(2 * scale)),
        )
        image = Image.alpha_composite(image, edge)

    for points, top, bottom in (
        (C_OUTLINE, (243, 252, 246), (216, 234, 222)),
        (PROMPT_OUTLINE, (131, 244, 192), (63, 207, 155)),
    ):
        # 以整体轮廓为中心放大，避免小尺寸时笔画和内部留白相互挤压。
        expansion = 1.08 if small else 1.0
        adjusted = tuple(
            ((x - 510) * expansion + 512, (y - 512) * expansion + 512)
            for x, y in points
        )
        mask = Image.new("L", image.size)
        ImageDraw.Draw(mask).polygon(
            rounded_polygon(adjusted, 12, scale), fill=255,
        )
        if not small:
            shadow_mask = Image.new("L", image.size)
            shadow_mask.paste(mask, (0, round(7 * scale)))
            shadow_mask = shadow_mask.filter(ImageFilter.GaussianBlur(9 * scale))
            shadow = Image.new("RGBA", image.size, (0, 0, 0, 0))
            shadow.putalpha(shadow_mask.point(lambda alpha: alpha // 7))
            image = Image.alpha_composite(image, shadow)
        ink = gradient(working_size, top, bottom)
        image.paste(ink, (0, 0), mask)

    return image.resize((size, size), Image.Resampling.LANCZOS)


def main():
    sizes = sorted(set(ICO_SIZES + ICNS_SIZES))
    images = {size: render_icon(size) for size in sizes}
    images[1024].save(ICON_DIR / "Codey.png", optimize=True)
    images[256].save(
        ICON_DIR / "Codey.ico",
        sizes=[(size, size) for size in ICO_SIZES],
        append_images=[images[size] for size in ICO_SIZES if size != 256],
    )
    images[1024].save(
        ICON_DIR / "Codey.icns",
        append_images=[images[size] for size in ICNS_SIZES if size != 1024],
    )
    print(f"Generated Codey.png, Codey.ico and Codey.icns in {ICON_DIR}")


if __name__ == "__main__":
    main()
