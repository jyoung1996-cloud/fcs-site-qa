"""Make a smaller viewing copy of a PDF: re-encode large raster images as JPEG at a capped size.
Text, linework and signatures drawn as vectors are untouched. Keeps the original if the copy isn't smaller.
Usage: python3 -I shrink_pdf.py IN.pdf OUT.pdf [max_px=1700] [quality=62]"""
import sys, io, zlib
import pikepdf
from pikepdf import PdfImage, Name
from PIL import Image

def shrink(src, dst, max_px=1700, quality=62):
    pdf = pikepdf.open(src)
    seen = set()
    for page in pdf.pages:
        try:
            imgs = page.images
        except Exception:
            continue
        for key in list(imgs.keys()):
            raw = imgs[key]
            og = raw.objgen
            if og in seen:
                continue
            seen.add(og)
            try:
                if raw.get("/ImageMask", False) or "/SMask" in raw or "/Mask" in raw:
                    continue  # keep transparency/masks exact (signatures, logos)
                w, h = int(raw.Width), int(raw.Height)
                bpc = int(raw.get("/BitsPerComponent", 8))
                if w * h < 400_000 or bpc == 1:
                    continue
                old_len = len(raw.read_raw_bytes())
                im = PdfImage(raw).as_pil_image()
                if im.mode not in ("RGB", "L"):
                    im = im.convert("RGB")
                scale = min(1.0, max_px / max(w, h))
                if scale < 1.0:
                    im = im.resize((max(1, int(w * scale)), max(1, int(h * scale))), Image.LANCZOS)
                buf = io.BytesIO()
                im.save(buf, "JPEG", quality=quality, optimize=True)
                data = buf.getvalue()
                if len(data) >= old_len * 0.9:
                    continue
                raw.write(data, filter=Name.DCTDecode)
                raw.Width, raw.Height = im.size
                raw.ColorSpace = Name.DeviceGray if im.mode == "L" else Name.DeviceRGB
                raw.BitsPerComponent = 8
                for k in ("/DecodeParms", "/Decode"):
                    if k in raw:
                        del raw[k]
            except Exception:
                continue
    pdf.remove_unreferenced_resources()
    pdf.save(dst, compress_streams=True, object_stream_mode=pikepdf.ObjectStreamMode.generate)
    return dst

if __name__ == "__main__":
    a = sys.argv[1:]
    shrink(a[0], a[1], int(a[2]) if len(a) > 2 else 1700, int(a[3]) if len(a) > 3 else 62)
