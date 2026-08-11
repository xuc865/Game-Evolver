from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from scripts.run_verigame_public_awesome import append_progress_notice


class VeriGameProgressNoticeTests(unittest.TestCase):
    def test_notice_is_concise_and_idempotent(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            attempt = root / "attempt-1"
            attempt.mkdir()
            progress = root / "progress.txt"
            item = {
                "attempt_root": str(attempt),
                "finished_at": "2026-08-11T20:00:00+0800",
                "task": "2048",
                "model": "Qwen3.6-27B",
                "status": "completed",
            }
            self.assertTrue(
                append_progress_notice(
                    item, attempted_count=4, completed_count=1, progress_path=progress
                )
            )
            self.assertFalse(
                append_progress_notice(
                    item, attempted_count=4, completed_count=1, progress_path=progress
                )
            )
            self.assertEqual(len(progress.read_text(encoding="utf-8").splitlines()), 1)
            notice = progress.read_text(encoding="utf-8")
            self.assertIn("bench=gamegen-verifier-public", notice)
            self.assertIn("task=2048 model=Qwen3.6-27B", notice)
            self.assertIn("cumulative_accuracy=1/4 (25.00%)", notice)


if __name__ == "__main__":
    unittest.main()
