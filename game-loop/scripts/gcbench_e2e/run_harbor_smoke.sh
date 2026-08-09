#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
IMAGE="${GAMECRAFT_IMAGE:-harness-game/gamecraft-bench-e2e:21028df}"
TASK="${GAMECRAFT_SMOKE_TASK:-platformer-wall-dancer}"
OUTPUT_ROOT="${1:-$PROJECT_ROOT/.game-loop-ui-runs/gcbench-official-smoke}"
RUN_ID="$(date -u +%Y%m%dT%H%M%SZ)"
RUN_DIR="$OUTPUT_ROOT/$RUN_ID"
mkdir -p "$RUN_DIR"
RUN_DIR="$(cd "$RUN_DIR" && pwd)"

bash "$SCRIPT_DIR/doctor.sh"

docker run --rm --platform linux/amd64 --privileged \
  -e GAMECRAFT_BENCH_JUDGE=stub \
  -e GAMECRAFT_BENCH_JUDGE_MODEL=1.0 \
  -e GAMECRAFT_BENCH_GODOT_BIN=/usr/local/bin/godot \
  -e GAMECRAFT_BENCH_JOBS_ROOT=/outputs/jobs \
  -v "$RUN_DIR:/outputs" \
  "$IMAGE" bash -lc \
  "cd /opt/gamecraft-bench && ./scripts/run.sh -p tasks/$TASK --agent oracle --delete"

BREAKDOWN="$(find "$RUN_DIR/jobs" -path '*/verifier/breakdown.json' -type f | head -1)"
test -n "$BREAKDOWN"
VERIFIER_DIR="$(dirname "$BREAKDOWN")"
test -s "$VERIFIER_DIR/reward.txt"
find "$VERIFIER_DIR/demos" -name '*.mp4' -type f -size +0c | grep -q .

python3 - "$RUN_DIR" "$TASK" "$BREAKDOWN" <<'PY'
import json, sys
from pathlib import Path
run_dir, task, breakdown = Path(sys.argv[1]), sys.argv[2], Path(sys.argv[3])
data = json.loads(breakdown.read_text())
evidence = {
    "schema_version": "gamecraft-bench.official-smoke.v1",
    "task": task,
    "gamecraft_bench_commit": "21028dfa726b10e340f102961aba21ca8016499b",
    "godot_version": "4.6.2.stable.official.71f334935",
    "judge": "stub:1.0",
    "harbor_orchestrated": True,
    "build_ok": data.get("build_ok"),
    "reward": data.get("reward"),
    "breakdown": str(breakdown),
    "replay_videos": [str(p) for p in sorted((breakdown.parent / "demos").rglob("*.mp4"))],
}
(run_dir / "evidence.json").write_text(json.dumps(evidence, indent=2) + "\n")
print(json.dumps(evidence, indent=2))
PY

echo "Official Harbor smoke evidence: $RUN_DIR/evidence.json"

