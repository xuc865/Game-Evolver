from __future__ import annotations

import re
import unittest

from game_loop.cache_keys import build_cache_key_headers


class CacheKeyHeadersTest(unittest.TestCase):
    def test_static_cache_key_remains_supported(self) -> None:
        headers = build_cache_key_headers(
            env={
                "CODEX_CACHE_KEY_HEADER": "X-Test-Cache-Key",
                "CODEX_CACHE_KEY": "fixed-value",
            }
        )

        self.assertEqual(headers, {"X-Test-Cache-Key": "fixed-value"})

    def test_random_cache_key_matches_required_format_and_changes(self) -> None:
        values = {
            "CODEX_CACHE_KEY_HEADER": "X-Cache-Key",
            "CODEX_CACHE_KEY_MODE": "random",
        }

        keys = {build_cache_key_headers(env=values)["X-Cache-Key"] for _ in range(24)}

        self.assertGreater(len(keys), 1)
        for key in keys:
            self.assertRegex(
                key,
                re.compile(
                    r"^(scene|ui|coding|player|reviewer|master)-harness:[A-Za-z0-9]{8}$"
                ),
            )


if __name__ == "__main__":
    unittest.main()
