from pathlib import Path
from PIL import Image, ImageChops, ImageDraw, ImageFilter, IcnsImagePlugin


ROOT = Path(__file__).resolve().parents[1]
ASSET_DIR = ROOT / "app" / "renderer" / "assets"
ASSET_DIR.mkdir(parents=True, exist_ok=True)


def lerp(a, b, t):
    return int(a + (b - a) * t)


def gradient(size, top, bottom):
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    pix = img.load()
    for y in range(size):
        t = y / max(1, size - 1)
        for x in range(size):
            side = abs(x - size / 2) / (size / 2)
            shade = 1 - side * 0.14
            pix[x, y] = (
                int(lerp(top[0], bottom[0], t) * shade),
                int(lerp(top[1], bottom[1], t) * shade),
                int(lerp(top[2], bottom[2], t) * shade),
                255,
            )
    return img


def rounded_mask(size, radius):
    mask = Image.new("L", (size, size), 0)
    draw = ImageDraw.Draw(mask)
    draw.rounded_rectangle((0, 0, size - 1, size - 1), radius=radius, fill=255)
    return mask


def draw_logo(size=1024):
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    bg = gradient(size, (255, 196, 54), (255, 104, 20))
    mask = rounded_mask(size, int(size * 0.22))
    img.alpha_composite(Image.composite(bg, Image.new("RGBA", (size, size), (0, 0, 0, 0)), mask))

    draw = ImageDraw.Draw(img)
    s = size / 1024

    glow = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    gdraw = ImageDraw.Draw(glow)
    gdraw.ellipse((95*s, 64*s, 862*s, 846*s), fill=(255, 232, 132, 92))
    glow = glow.filter(ImageFilter.GaussianBlur(int(34 * s)))
    img.alpha_composite(glow)

    for x in range(-80, 1050, 132):
        draw.line((x*s, 0, (x + 610)*s, 1024*s), fill=(255, 255, 255, 22), width=max(2, int(5*s)))

    shadow = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    sdraw = ImageDraw.Draw(shadow)
    bubble = (190*s, 215*s, 834*s, 746*s)
    sdraw.rounded_rectangle(bubble, radius=int(154*s), fill=(72, 34, 14, 80))
    sdraw.polygon([(322*s, 718*s), (262*s, 866*s), (458*s, 742*s)], fill=(72, 34, 14, 80))
    shadow = shadow.filter(ImageFilter.GaussianBlur(int(22*s)))
    img.alpha_composite(shadow)

    draw.rounded_rectangle(bubble, radius=int(154*s), fill=(255, 248, 224, 255))
    draw.polygon([(335*s, 704*s), (274*s, 850*s), (470*s, 730*s)], fill=(255, 248, 224, 255))
    draw.rounded_rectangle((218*s, 244*s, 806*s, 716*s), radius=int(132*s), outline=(255, 143, 26, 120), width=max(10, int(16*s)))

    draw.ellipse((342*s, 312*s, 688*s, 664*s), fill=(255, 150, 30, 255))
    draw.ellipse((391*s, 405*s, 639*s, 681*s), fill=(255, 219, 150, 255))
    draw.polygon([(362*s, 366*s), (285*s, 283*s), (419*s, 317*s)], fill=(255, 150, 30, 255))
    draw.polygon([(668*s, 366*s), (742*s, 284*s), (612*s, 317*s)], fill=(255, 150, 30, 255))
    draw.polygon([(363*s, 342*s), (323*s, 302*s), (396*s, 320*s)], fill=(88, 44, 22, 255))
    draw.polygon([(667*s, 342*s), (708*s, 303*s), (637*s, 320*s)], fill=(88, 44, 22, 255))

    dark = (83, 42, 21, 255)
    draw.rounded_rectangle((454*s, 336*s, 484*s, 455*s), radius=int(16*s), fill=dark)
    draw.rounded_rectangle((543*s, 336*s, 573*s, 455*s), radius=int(16*s), fill=dark)
    draw.polygon([(514*s, 410*s), (476*s, 464*s), (552*s, 464*s)], fill=dark)
    draw.arc((465*s, 442*s, 515*s, 507*s), 20, 155, fill=dark, width=max(5, int(9*s)))
    draw.arc((513*s, 442*s, 563*s, 507*s), 25, 160, fill=dark, width=max(5, int(9*s)))

    stripe = (113, 53, 20, 255)
    draw.line((430*s, 320*s, 392*s, 384*s), fill=stripe, width=max(10, int(19*s)))
    draw.line((598*s, 320*s, 637*s, 384*s), fill=stripe, width=max(10, int(19*s)))
    draw.line((510*s, 301*s, 510*s, 373*s), fill=stripe, width=max(10, int(18*s)))

    for y, w in [(525, 204), (586, 152), (648, 96)]:
        draw.rounded_rectangle((690*s, y*s, (690 + w)*s, (y + 28)*s), radius=int(14*s), fill=(74, 36, 19, 230))

    draw.ellipse((718*s, 238*s, 760*s, 280*s), fill=(255, 255, 255, 210))
    draw.ellipse((770*s, 285*s, 795*s, 310*s), fill=(255, 255, 255, 150))

    clipped_alpha = ImageChops.multiply(img.getchannel("A"), mask)
    img.putalpha(clipped_alpha)
    return img


SVG = """<svg width="256" height="256" viewBox="0 0 256 256" fill="none" xmlns="http://www.w3.org/2000/svg">
<rect x="10" y="10" width="236" height="236" rx="54" fill="url(#bg)"/>
<path d="M49 66C49 51.64 60.64 40 75 40H181C195.36 40 207 51.64 207 66V156C207 170.36 195.36 182 181 182H114L70 218L82 182H75C60.64 182 49 170.36 49 156V66Z" fill="#FFF5D8"/>
<path d="M60 69C60 58.51 68.51 50 79 50H177C187.49 50 196 58.51 196 69V151C196 161.49 187.49 170 177 170H111L83 193L91 170H79C68.51 170 60 161.49 60 151V69Z" stroke="#FF8B1E" stroke-width="8"/>
<path d="M91 87L70 63L106 73L91 87Z" fill="#5B2A13"/>
<path d="M164 87L186 64L150 73L164 87Z" fill="#5B2A13"/>
<circle cx="128" cy="118" r="43" fill="#FF941D"/>
<ellipse cx="128" cy="139" rx="30" ry="35" fill="#FFD99A"/>
<path d="M111 83L101 104M145 83L156 104M128 78V97" stroke="#6A2F12" stroke-width="7" stroke-linecap="round"/>
<rect x="114" y="105" width="9" height="27" rx="4.5" fill="#552814"/>
<rect x="134" y="105" width="9" height="27" rx="4.5" fill="#552814"/>
<path d="M128 127L119 140H137L128 127Z" fill="#552814"/>
<path d="M117 145C121 151 126 153 128 153C130 153 135 151 139 145" stroke="#552814" stroke-width="4" stroke-linecap="round"/>
<rect x="173" y="126" width="49" height="8" rx="4" fill="#5A2B17"/>
<rect x="173" y="143" width="37" height="8" rx="4" fill="#5A2B17"/>
<defs><linearGradient id="bg" x1="43" y1="22" x2="212" y2="236" gradientUnits="userSpaceOnUse"><stop stop-color="#FFC838"/><stop offset="1" stop-color="#FF6814"/></linearGradient></defs>
</svg>
"""


def make_tray(size=64, template=False):
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)
    s = size / 64
    c = (0, 0, 0, 255) if template else (255, 151, 29, 255)
    fill = (0, 0, 0, 0) if template else (38, 33, 28, 255)
    draw.rounded_rectangle((8*s, 9*s, 56*s, 45*s), radius=int(13*s), fill=fill, outline=c, width=max(2, int(4*s)))
    draw.polygon([(21*s, 44*s), (16*s, 58*s), (33*s, 45*s)], fill=fill, outline=c)
    draw.ellipse((22*s, 18*s, 42*s, 39*s), fill=c)
    draw.rounded_rectangle((28*s, 16*s, 31*s, 25*s), radius=int(2*s), fill=fill if template else (38, 33, 28, 255))
    draw.rounded_rectangle((35*s, 16*s, 38*s, 25*s), radius=int(2*s), fill=fill if template else (38, 33, 28, 255))
    return img


def main():
    icon = draw_logo()
    icon.save(ASSET_DIR / "icon.png")
    icon.save(ASSET_DIR / "icon.ico", sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
    icon.save(ASSET_DIR / "icon.icns", sizes=[(16, 16), (32, 32), (64, 64), (128, 128), (256, 256), (512, 512), (1024, 1024)])
    (ASSET_DIR / "product-logo.svg").write_text(SVG, encoding="utf-8")
    make_tray(template=False).save(ASSET_DIR / "tray.png")
    make_tray(template=True).save(ASSET_DIR / "trayTemplate.png")
    print("generated product icon assets")


if __name__ == "__main__":
    main()
