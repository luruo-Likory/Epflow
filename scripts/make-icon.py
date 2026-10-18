"""生成应用图标 build/icon.ico（无需外部设计资源）。"""

from PIL import Image, ImageDraw
import os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "build")
os.makedirs(OUT, exist_ok=True)

BASE = 1024
img = Image.new("RGBA", (BASE, BASE), (0, 0, 0, 0))
d = ImageDraw.Draw(img)

# 圆角底：青绿渐变（手工纵向插值）
radius = int(BASE * 0.22)
top = (13, 148, 136)
bottom = (15, 118, 110)
grad = Image.new("RGBA", (BASE, BASE), (0, 0, 0, 0))
gd = ImageDraw.Draw(grad)
for y in range(BASE):
    t = y / (BASE - 1)
    color = tuple(int(top[i] + (bottom[i] - top[i]) * t) for i in range(3)) + (255,)
    gd.line([(0, y), (BASE, y)], fill=color)
mask = Image.new("L", (BASE, BASE), 0)
md = ImageDraw.Draw(mask)
md.rounded_rectangle([0, 0, BASE - 1, BASE - 1], radius=radius, fill=255)
img.paste(grad, (0, 0), mask)

# 播放三角
cx, cy = BASE * 0.46, BASE * 0.40
size = BASE * 0.22
tri = [(cx - size * 0.75, cy - size), (cx - size * 0.75, cy + size), (cx + size, cy)]
d.polygon(tri, fill=(255, 255, 255, 255))

# 字幕条（两条横线）
bar_w = BASE * 0.46
bar_h = BASE * 0.078
x0 = (BASE - bar_w) / 2
y1 = BASE * 0.62
y2 = y1 + bar_h + BASE * 0.06
d.rounded_rectangle([x0, y1, x0 + bar_w, y1 + bar_h], radius=bar_h / 2, fill=(255, 255, 255, 210))
d.rounded_rectangle([x0, y2, x0 + bar_w * 0.66, y2 + bar_h], radius=bar_h / 2, fill=(255, 255, 255, 160))

sizes = [16, 24, 32, 48, 64, 128, 256]
img.save(os.path.join(OUT, "icon.png"))
img.save(os.path.join(OUT, "icon.ico"), format="ICO", sizes=[(s, s) for s in sizes])
print("icon written:", os.path.join(OUT, "icon.ico"))
