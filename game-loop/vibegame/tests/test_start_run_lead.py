from pathlib import Path
from unittest.mock import patch
import sys

import pytest

from cli.start import _run_lead


@pytest.mark.base
def test_run_lead_reuses_current_vibegame_interpreter(tmp_path: Path) -> None:
    with patch("cli.start.sp.run") as run:
        _run_lead(tmp_path, "close -f")

    command = run.call_args.args[0]
    environment = run.call_args.kwargs["env"]
    assert command[:4] == [sys.executable, "-m", "cli.main", "lead"]
    assert environment["PATH"].split(":", 1)[0] == str(Path(sys.executable).parent)
