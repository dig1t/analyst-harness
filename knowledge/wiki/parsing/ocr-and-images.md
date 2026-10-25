---
tags: [scraping, parsing, ocr, images, tesseract]
aliases: [OCR, Tesseract, pytesseract, image text extraction, optical character recognition]
---

# OCR and Image-Based Data

> Sources: Tesseract documentation (https://tesseract-ocr.github.io/tessdoc/); Tesseract, Improving the quality of the output (https://tesseract-ocr.github.io/tessdoc/ImproveQuality.html); Tesseract command-line usage (https://tesseract-ocr.github.io/tessdoc/Command-Line-Usage.html); pytesseract (https://github.com/madmaze/pytesseract); Pillow, ImageOps module (https://pillow.readthedocs.io/en/stable/reference/ImageOps.html); OCRmyPDF documentation (https://ocrmypdf.readthedocs.io/); Google Cloud Vision, Detect text in images (https://cloud.google.com/vision/docs/ocr); Amazon Textract Developer Guide (https://docs.aws.amazon.com/textract/latest/dg/what-is.html); Azure AI Document Intelligence documentation (https://learn.microsoft.com/en-us/azure/ai-services/document-intelligence/)
> Raw: none yet (seed article)
> Updated: 2026-10-24

## Overview

Optical character recognition turns pixels into text. Reach for it only when the data exists solely as an image (scanned PDFs, screenshots, infographics, images of tables), because it is slower, costlier and less accurate than reading text. Check first for a text source: alt text, a PDF text layer, embedded JSON, a CSV download or an API. When OCR is needed, start from the highest-resolution image you are allowed to fetch, preprocess it (flatten transparency, grayscale, upscale, binarize, deskew, crop), pick a page segmentation mode that matches the layout, restrict the character set for narrow fields, filter words by confidence, validate values against patterns or totals, and keep the image so results can be audited. Tesseract is the free local default; cloud OCR services handle forms, tables and handwriting better; vision LLMs understand layout but can invent plausible numbers. CAPTCHAs are never an OCR target.

## When OCR is (and is not) the answer

| Situation | Try first | OCR? |
|---|---|---|
| Scanned PDF report | Check for a text layer or a data download | Yes, with OCRmyPDF ([PDF Data Extraction](pdf-extraction.md)) |
| Chart or infographic | The source dataset, a CSV link, the JSON behind the chart | Last resort |
| Text inside product images | Alt text, JSON-LD, product feed | Rarely worth it |
| Canvas-rendered text | The data request behind the canvas ([Network Interception and Response Capture](../browser-automation/network-interception.md)) | Rarely |
| Emails or phone numbers rendered as images | Nothing: the owner chose to deter harvesting, and it is personal data | No |
| CAPTCHA | Contact the site, use an API or a licensed dataset ([CAPTCHAs and What They Mean for Your Project](../anti-bot/captchas.md)) | Never |

## Tesseract essentials

- Tesseract 4 and later use an LSTM neural engine (`--oem 1`); `--oem 3` picks what is available.
- Languages come from `.traineddata` files (`-l eng`, `-l eng+deu`); `tesseract --list-langs` shows what is installed. The project publishes standard, "fast" and "best" model sets that trade speed for accuracy.
- Page segmentation mode (`--psm`) tells Tesseract what layout to expect. Choosing it well matters more than most tuning:

| PSM | Meaning | Use for |
|---|---|---|
| 3 | Fully automatic segmentation (default) | Full pages |
| 4 | Single column of text of variable sizes | Receipts, lists |
| 6 | Single uniform block of text | Paragraph crops, table cells |
| 7 | Single text line | A price or label crop |
| 8 | Single word | Codes, ids |
| 11 | Sparse text, no particular order | Posters, labels scattered on an image |
| 12 | Sparse text with orientation detection | Rotated sparse text |
| 13 | Raw line, bypassing Tesseract-specific hacks | Lines that mode 7 mangles |

- Configuration variables go through `-c`, for example `-c tessedit_char_whitelist=0123456789.,` (honored by the LSTM engine in Tesseract 5).
- Outputs: plain text, TSV with word boxes and confidences (`image_to_data`), hOCR, ALTO XML and searchable PDF.

## Preprocessing and recognition

The Tesseract documentation recommends good resolution (scans of at least 300 DPI), clean binarization, deskewing, borders around text and no alpha channel. For screenshots, upscaling small text two to four times usually helps.

```python
import re
from PIL import Image, ImageOps
import pytesseract

def flatten(img: Image.Image) -> Image.Image:
    """Composite transparent images onto white; OCR engines dislike alpha channels."""
    if img.mode in ("RGBA", "LA") or (img.mode == "P" and "transparency" in img.info):
        rgba = img.convert("RGBA")
        return Image.alpha_composite(Image.new("RGBA", rgba.size, (255, 255, 255, 255)), rgba).convert("RGB")
    return img.convert("RGB")

def preprocess(img: Image.Image, scale: int = 3, threshold: int = 160) -> Image.Image:
    g = ImageOps.grayscale(flatten(img))
    g = g.resize((g.width * scale, g.height * scale), Image.Resampling.LANCZOS)
    g = ImageOps.autocontrast(g)
    return g.point(lambda p: 255 if p > threshold else 0)       # simple global threshold

img = preprocess(Image.open("price.png"))

text = pytesseract.image_to_string(img, lang="eng", config="--psm 7").strip()

# Word-level confidences (0-100; -1 marks non-word rows such as blocks and lines)
data = pytesseract.image_to_data(img, config="--psm 7", output_type=pytesseract.Output.DICT)
words = [(t, float(c)) for t, c in zip(data["text"], data["conf"]) if t.strip()]
low_confidence = [w for w in words if w[1] < 80]

# Narrow field: restrict characters, then validate the shape
amount = pytesseract.image_to_string(img, config="--psm 7 -c tessedit_char_whitelist=0123456789.,").strip()
if not re.fullmatch(r"\d{1,3}(?:,\d{3})*\.\d{2}", amount):
    amount = None                                                # send to review instead of guessing
```

On a rendered "Total: 1,299.00 EUR" label this pipeline returned the exact text with word confidences of 95 to 96, and the whitelist call returned `1,299.00`. For uneven lighting, replace the global threshold with adaptive thresholding (OpenCV) and add deskewing; for multi-column pages, crop columns first.

When the image comes from a responsive `<img>`, pick the largest `srcset` candidate rather than the thumbnail in `src`:

```python
def largest_srcset(srcset: str) -> str | None:
    best, best_w = None, -1
    for part in srcset.split(","):
        bits = part.strip().split()
        if bits:
            w = int(bits[1][:-1]) if len(bits) > 1 and bits[1].endswith("w") else 0
            if w > best_w:
                best, best_w = bits[0], w
    return best

print(largest_srcset("/img/k-320.jpg 320w, /img/k-1280.jpg 1280w"))   # /img/k-1280.jpg
```

## Engines compared

| Option | Strengths | Weaknesses |
|---|---|---|
| Tesseract | Free, local, private, scriptable, more than 100 languages | Needs preprocessing; weak on photos, complex layouts and handwriting |
| Other open-source engines (PaddleOCR, EasyOCR, docTR) | Deep-learning text detection; better on photos and scene text | Heavier dependencies; a GPU helps |
| Cloud OCR (Google Cloud Vision and Document AI, Amazon Textract, Azure AI Document Intelligence) | High accuracy; tables, forms, key-value pairs, handwriting | Per-page cost, quotas, data leaves your systems |
| Vision LLMs | Understand layout, tables and charts; can return JSON for a schema | Can hallucinate values, nondeterministic, cost per image |

Textract's `AnalyzeDocument` returns table and form structure; Google Vision distinguishes `TEXT_DETECTION` from `DOCUMENT_TEXT_DETECTION` for dense documents; Azure offers prebuilt read and layout models. Treat any model output as untrusted: cross-check totals, compare against a text layer when one exists and audit samples ([Validating LLM Extractions](../llm-scraping/validating-llm-output.md)).

## Measuring accuracy

Label 50 to 100 representative images and track character error rate (CER) and field-level exact match per source and engine:

```python
def cer(hyp: str, ref: str) -> float:
    """Levenshtein distance divided by reference length."""
    prev = list(range(len(ref) + 1))
    for i, h in enumerate(hyp, 1):
        cur = [i]
        for j, r in enumerate(ref, 1):
            cur.append(min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (h != r)))
        prev = cur
    return prev[-1] / max(len(ref), 1)

print(round(cer("Thingamajig longname", "Thingamajig long name"), 3))   # 0.048
```

A CER of 5% sounds small, but one wrong digit makes a price wrong; field exact match is the metric that matters for data.

## Pitfalls

- **Look-alike characters.** `0/O`, `1/l/I`, `5/S`, `8/B`, `rn/m`, and above all `,` versus `.` in numbers. Validate with patterns and ranges.
- **Table rules and spacing.** Ruling lines become `|` or `l` characters and words merge or split; crop cells or remove lines before OCR.
- **Thumbnails.** Low-resolution previews destroy accuracy; fetch the original only if you are permitted to.
- **Transparency.** Text on a transparent background can vanish after conversion; flatten onto white first.
- **Missing language data.** Recognizing German with `eng` drops umlauts silently.
- **Cost and latency.** OCR is CPU or API heavy: cache results keyed by the image's content hash ([Cost Control](../operations/cost-control.md)).
- **Images carry personal data and copyright.** Faces, names in screenshots and the images themselves have their own legal status.

## Checklist

- [ ] Confirmed there is no text, JSON or download source for the same data.
- [ ] Used the largest permitted image and a preprocessing step suited to it.
- [ ] Chose a PSM per layout, a language pack per source and whitelists for narrow fields.
- [ ] Filtered by word confidence and validated values; routed failures to review.
- [ ] Measured CER and field accuracy on a labeled sample; cached by image hash; stored the image.

## See Also

- [PDF Data Extraction](pdf-extraction.md)
- [LLM-Assisted Extraction](../llm-scraping/llm-assisted-extraction.md)
- [Validating LLM Extractions](../llm-scraping/validating-llm-output.md)
- [CAPTCHAs and What They Mean for Your Project](../anti-bot/captchas.md)
- [Text Cleaning and Unicode Normalization](text-cleaning-and-unicode.md)
- [Cost Control](../operations/cost-control.md)
