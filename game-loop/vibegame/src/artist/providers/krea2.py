"""Krea2 image generation provider.

Krea2 is deliberately not treated as an OpenAI-compatible endpoint. Its single
JSON endpoint returns encoded image bytes directly in the HTTP response body.
"""

from __future__ import annotations

import io
import os
import tempfile
import time
from pathlib import Path

import requests
from PIL import Image

from . import TIMEOUT, GenResult


PROVIDER_NAME = "Krea2"
BASE_URL = "http://29.116.237.141:80/krea2"
SUPPORTED_MODELS = {"krea2"}
REQUIRES_API_KEY = False
MAX_ATTEMPTS = 3
MIN_EDGE = 64
MAX_EDGE = 4096


def _endpoint(base_url: str) -> str:
    value = (base_url or BASE_URL).rstrip("/")
    return value if value.endswith("/generate") else f"{value}/generate"


def _dimensions(size: str, aspect_ratio: str, resolution: str) -> tuple[int, int]:
    if size:
        try:
            width_text, height_text = size.lower().split("x", 1)
            width, height = int(width_text), int(height_text)
        except (TypeError, ValueError) as exc:
            raise ValueError(f"invalid Krea2 size {size!r}; expected WIDTHxHEIGHT") from exc
    else:
        long_edge = {"1K": 1024, "2K": 2048, "4K": 4096}.get(resolution, 1536)
        ratios = {
            "1:1": (1, 1), "4:3": (4, 3), "3:4": (3, 4),
            "16:9": (16, 9), "9:16": (9, 16), "3:2": (3, 2),
            "2:3": (2, 3), "21:9": (21, 9), "auto": (16, 9),
        }
        rw, rh = ratios.get(aspect_ratio, ratios["auto"])
        if rw >= rh:
            width, height = long_edge, round(long_edge * rh / rw)
        else:
            width, height = round(long_edge * rw / rh), long_edge
    if not (MIN_EDGE <= width <= MAX_EDGE and MIN_EDGE <= height <= MAX_EDGE):
        raise ValueError(
            f"Krea2 dimensions must be between {MIN_EDGE} and {MAX_EDGE}px; got {width}x{height}"
        )
    return width, height


def _validate_image(data: bytes, content_type: str) -> tuple[str, tuple[int, int]]:
    if not data:
        raise ValueError("Krea2 returned an empty body")
    if content_type and not content_type.lower().startswith("image/"):
        raise ValueError(f"Krea2 returned non-image content type {content_type!r}")
    try:
        with Image.open(io.BytesIO(data)) as image:
            image.verify()
        with Image.open(io.BytesIO(data)) as image:
            fmt = (image.format or "PNG").upper()
            dimensions = image.size
    except Exception as exc:
        raise ValueError("Krea2 response is not a valid image") from exc
    return fmt, dimensions


def _atomic_write(output: str, data: bytes) -> None:
    destination = Path(output)
    destination.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix=f".{destination.name}.", dir=destination.parent)
    try:
        with os.fdopen(fd, "wb") as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, destination)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def t2i(
    base_url,
    api_key,
    prompt,
    output,
    model,
    *,
    size="",
    aspect_ratio="auto",
    resolution="auto",
    quality="auto",
):
    del api_key, model, quality
    started = time.monotonic()
    try:
        width, height = _dimensions(size, aspect_ratio, resolution)
    except ValueError as exc:
        return GenResult(False, error=str(exc), elapsed=time.monotonic() - started)

    payload = {"prompt": prompt, "width": width, "height": height}
    last_error = "unknown Krea2 error"
    for attempt in range(1, MAX_ATTEMPTS + 1):
        try:
            response = requests.post(
                _endpoint(base_url),
                headers={"Content-Type": "application/json"},
                json=payload,
                timeout=TIMEOUT,
            )
            if response.status_code == 200:
                image_format, actual_size = _validate_image(
                    response.content, response.headers.get("Content-Type", "")
                )
                _atomic_write(output, response.content)
                if actual_size != (width, height):
                    print(
                        f"Krea2 returned {actual_size[0]}x{actual_size[1]} {image_format}; "
                        f"requested {width}x{height}"
                    )
                return GenResult(True, elapsed=time.monotonic() - started)
            body = response.text[:500]
            last_error = f"Krea2 HTTP {response.status_code}: {body}"
            if response.status_code not in {408, 409, 429} and response.status_code < 500:
                break
        except (requests.Timeout, requests.ConnectionError) as exc:
            last_error = f"Krea2 transport error: {exc}"
        except ValueError as exc:
            last_error = str(exc)
            break
        if attempt < MAX_ATTEMPTS:
            time.sleep(min(2 ** (attempt - 1), 4))
    return GenResult(False, error=last_error, elapsed=time.monotonic() - started)


def i2i(
    base_url,
    api_key,
    prompt,
    images,
    output,
    model,
    **kwargs,
):
    del base_url, api_key, prompt, images, output, model, kwargs
    return GenResult(False, error="Krea2 endpoint supports text-to-image only")
