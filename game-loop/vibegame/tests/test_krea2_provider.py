from __future__ import annotations

import io
from pathlib import Path
from unittest.mock import Mock, patch

from PIL import Image

from artist.providers import krea2


def _png(width: int = 96, height: int = 64) -> bytes:
    buffer = io.BytesIO()
    Image.new("RGBA", (width, height), (20, 30, 40, 255)).save(buffer, "PNG")
    return buffer.getvalue()


def test_krea2_writes_binary_image_atomically(tmp_path: Path) -> None:
    response = Mock(status_code=200, content=_png(96, 64), headers={"Content-Type": "image/png"})
    with patch("artist.providers.krea2.requests.post", return_value=response) as post:
        output = tmp_path / "asset.png"
        result = krea2.t2i(
            "http://example/krea2", "", "a knight", str(output), "krea2", size="96x64"
        )
    assert result.ok
    assert output.read_bytes().startswith(b"\x89PNG")
    assert post.call_args.kwargs["json"] == {
        "prompt": "a knight", "width": 96, "height": 64
    }


def test_krea2_rejects_json_error_body(tmp_path: Path) -> None:
    response = Mock(
        status_code=200,
        content=b'{"error":"bad"}',
        headers={"Content-Type": "application/json"},
    )
    with patch("artist.providers.krea2.requests.post", return_value=response):
        result = krea2.t2i(
            "http://example/krea2", "", "a knight", str(tmp_path / "asset.png"), "krea2"
        )
    assert not result.ok
    assert "non-image" in result.error


def test_krea2_does_not_retry_client_errors(tmp_path: Path) -> None:
    response = Mock(status_code=400, text="invalid prompt", content=b"", headers={})
    with patch("artist.providers.krea2.requests.post", return_value=response) as post:
        result = krea2.t2i(
            "http://example/krea2", "", "bad", str(tmp_path / "asset.png"), "krea2"
        )
    assert not result.ok
    assert post.call_count == 1
