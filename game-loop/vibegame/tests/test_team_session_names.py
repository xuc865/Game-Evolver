from pathlib import Path
import sys


TEAM_PACKAGE = Path(__file__).resolve().parents[1] / "src" / ".vibegame"
sys.path.insert(0, str(TEAM_PACKAGE))

from team import paths  # noqa: E402


def test_session_name_is_unique_for_same_named_projects(tmp_path):
    first = tmp_path / "a" / "baseline" / ".vibegame" / "team"
    second = tmp_path / "b" / "baseline" / ".vibegame" / "team"

    assert paths.default_session_name(str(first)) != paths.default_session_name(str(second))
    assert paths.default_session_name(str(first)).startswith("vibegame-baseline-")
