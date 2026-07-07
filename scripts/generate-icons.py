from pathlib import Path
from PIL import Image, ImageChops, ImageFilter, ImageOps


ROOT = Path(__file__).resolve().parents[1]
ASSET_DIR = ROOT / "app" / "renderer" / "assets"
SOURCE = ASSET_DIR / "product-logo-ai-source.png"


def require_source():
    if not SOURCE.exists():
        raise FileNotFoundError(f"Missing AI logo source: {SOURCE}")
    return Image.open(SOURCE).convert("RGBA")


def remove_dark_background(image):
    pixels = image.load()
    width, height = image.size
    alpha = Image.new("L", image.size, 255)
    alpha_pixels = alpha.load()

    for y in range(height):
        for x in range(width):
            r, g, b, a = pixels[x, y]
            darkness = max(r, g, b)
            if darkness < 18:
                alpha_pixels[x, y] = 0
            elif darkness < 54:
                alpha_pixels[x, y] = int((darkness - 18) / 36 * 255)
            else:
                alpha_pixels[x, y] = a

    alpha = alpha.filter(ImageFilter.GaussianBlur(0.45))
    image.putalpha(alpha)
    return image


def crop_subject(image):
    alpha = image.getchannel("A")
    bbox = alpha.getbbox()
    if not bbox:
        return image
    pad = max(8, int(max(image.size) * 0.035))
    left = max(0, bbox[0] - pad)
    top = max(0, bbox[1] - pad)
    right = min(image.width, bbox[2] + pad)
    bottom = min(image.height, bbox[3] + pad)
    return image.crop((left, top, right, bottom))


def square_canvas(image, size=1024):
    image = crop_subject(image)
    canvas = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    scale = min(size * 0.91 / image.width, size * 0.91 / image.height)
    resized = image.resize((int(image.width * scale), int(image.height * scale)), Image.Resampling.LANCZOS)
    x = (size - resized.width) // 2
    y = (size - resized.height) // 2
    canvas.alpha_composite(resized, (x, y))
    return canvas


def make_template_icon(icon, size=64):
    resized = icon.resize((size, size), Image.Resampling.LANCZOS)
    alpha = resized.getchannel("A")
    luminance = ImageOps.grayscale(resized)
    alpha = ImageChops.multiply(alpha, luminance.point(lambda value: 255 if value > 12 else 0))
    template = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    template.putalpha(alpha)
    return template


def make_color_tray(icon, size=64):
    return icon.resize((size, size), Image.Resampling.LANCZOS)


def main():
    icon = square_canvas(remove_dark_background(require_source()))
    icon.save(ASSET_DIR / "icon.png")
    icon.save(
        ASSET_DIR / "icon.ico",
        sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)]
    )
    icon.save(
        ASSET_DIR / "icon.icns",
        sizes=[(16, 16), (32, 32), (64, 64), (128, 128), (256, 256), (512, 512), (1024, 1024)]
    )
    make_color_tray(icon).save(ASSET_DIR / "tray.png")
    make_template_icon(icon).save(ASSET_DIR / "trayTemplate.png")
    (ASSET_DIR / "product-logo.svg").write_text(
        '<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="0 0 256 256">'
        '<image href="icon.png" width="256" height="256" preserveAspectRatio="xMidYMid meet"/>'
        '</svg>\n',
        encoding="utf-8"
    )
    print("generated icon assets from AI logo source")


if __name__ == "__main__":
    main()
