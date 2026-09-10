from pathlib import Path
import sys


TEAM_PACKAGE = Path(__file__).resolve().parents[1] / "src" / ".vibegame"
sys.path.insert(0, str(TEAM_PACKAGE))

from team.state import init_state, register_agent  # noqa: E402


def test_forced_new_session_discards_stale_agent_panes(tmp_path):
    team_dir = tmp_path / ".vibegame" / "team"
    init_state("vibegame-old", str(team_dir))
    register_agent("artist", str(tmp_path), "codex", "%7", str(team_dir))

    state = init_state("vibegame-new", str(team_dir), reset_agents=True)

    assert state["session_name"] == "vibegame-new"
    assert state["agents"] == {}
