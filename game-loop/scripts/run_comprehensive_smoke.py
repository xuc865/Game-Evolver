#!/usr/bin/env python3
"""Comprehensive smoke gate for harness-game local integration."""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import tempfile
import unittest
from dataclasses import dataclass, field
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))
REPO_ROOT = ROOT.parent
SMOKE = ROOT / "experiments" / "smoke"
GCBENCH = REPO_ROOT / "gcbench"
GDBENCH = REPO_ROOT / "third_party" / "gamedevbench"
VGAME = ROOT / "third_party" / "SKYLENAGE-GameCodeGym"
VGAME_PYTHON = VGAME / ".venv" / "bin" / "python"
GGV = ROOT / "third_party" / "GameGen-Verifier"
OPENGAME_PROFILE = ROOT / "experiments" / "inner-agent" / "opengame-profile.local.json"
BACKBONES = ROOT / "experiments" / "inner-agent" / "backbones"
AWESOME_SKILLS_BASELINE = ROOT / "experiments" / "baselines" / "awesome-gamedev-agent-skills.runtime.json"


@dataclass
class PhaseResult:
    name: str
    ok: bool
    detail: str = ""
    skipped: bool = False


@dataclass
class SmokeReport:
    phases: list[PhaseResult] = field(default_factory=list)

    def add(self, phase: PhaseResult) -> None:
        self.phases.append(phase)

    @property
    def ok(self) -> bool:
        return all(phase.ok or phase.skipped for phase in self.phases)

    def to_dict(self) -> dict:
        return {
            "ok": self.ok,
            "phases": [
                {
                    "name": phase.name,
                    "ok": phase.ok,
                    "skipped": phase.skipped,
                    "detail": phase.detail,
                }
                for phase in self.phases
            ],
        }


def _run(command: list[str], *, cwd: Path | None = None, env: dict[str, str] | None = None) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        command,
        cwd=cwd or ROOT,
        env={**os.environ, **(env or {})},
        text=True,
        capture_output=True,
        check=False,
    )


def phase_unit_tests(report: SmokeReport) -> None:
    completed = _run([sys.executable, "-m", "unittest", "discover", "-s", "tests", "-q"])
    report.add(PhaseResult("unit_tests", completed.returncode == 0, completed.stderr[-500:]))


def phase_config_validation(report: SmokeReport) -> None:
    completed = _run([sys.executable, "experiments/generate_all_configs.py"])
    report.add(PhaseResult("config_validation", completed.returncode == 0, completed.stdout[-300:]))


def phase_provider_doctor(report: SmokeReport, *, require_credentials: bool) -> None:
    env = {}
    if os.environ.get("DEEPSEEK_API_KEY"):
        env["DEEPSEEK_API_KEY"] = os.environ["DEEPSEEK_API_KEY"]
    completed = _run(
        [sys.executable, "-m", "game_loop.inner_loop", "doctor-providers"],
        env=env,
    )
    ok = completed.returncode == 0
    if not ok and not require_credentials:
        try:
            payload = json.loads(completed.stdout)
            providers = payload.get("providers", [])
            ok = (
                completed.returncode == 1
                and any(
                    item.get("credential_required") and not item.get("credential_present")
                    for item in providers
                )
            )
        except json.JSONDecodeError:
            ok = False
    report.add(PhaseResult(
        "provider_doctor",
        ok,
        completed.stdout[-800:] + (
            "\ncredential-required providers may be unready in preflight; "
            "run with their secret environment for a real smoke."
            if ok and completed.returncode != 0 else ""
        ),
    ))


def phase_provider_smokes(report: SmokeReport, providers: list[str]) -> None:
    env = {}
    if token := os.environ.get("DEEPSEEK_API_KEY"):
        env["DEEPSEEK_API_KEY"] = token
    failures: list[str] = []
    skipped: list[str] = []
    for provider in providers:
        completed = _run(
            [sys.executable, "-m", "game_loop.inner_loop", "smoke-provider", "--provider", provider, "--timeout", "120"],
            env=env,
        )
        if completed.returncode != 0:
            detail = f"{completed.stdout[-400:]}{completed.stderr[-400:]}"
            if provider != "deepseek" and "RemoteDisconnected" in detail:
                skipped.append(provider)
                continue
            failures.append(f"{provider}: stdout={completed.stdout[-200:]} stderr={completed.stderr[-400:]}")
    report.add(PhaseResult(
        "provider_smokes",
        not failures,
        "\n".join(failures) if failures else f"skipped_unreachable={skipped}",
    ))


def phase_opengame_doctor(report: SmokeReport) -> None:
    if not OPENGAME_PROFILE.is_file():
        report.add(PhaseResult("opengame_doctor", False, f"missing profile: {OPENGAME_PROFILE}"))
        return
    completed = _run(
        [sys.executable, "-m", "game_loop.inner_loop", "doctor", "--profile", str(OPENGAME_PROFILE)]
    )
    report.add(PhaseResult("opengame_doctor", completed.returncode == 0, completed.stdout[-500:]))


def phase_gcbench_environment(report: SmokeReport) -> None:
    script = ROOT / "scripts" / "gcbench_e2e" / "setup_local.sh"
    completed = _run(["bash", str(script)])
    report.add(PhaseResult(
        "gcbench_environment",
        completed.returncode == 0,
        (completed.stdout + completed.stderr)[-1200:],
    ))


def phase_gdbench_environment(report: SmokeReport) -> None:
    runner = GDBENCH / "gamedevbench" / "src" / "benchmark_runner.py"
    godot = os.environ.get("GODOT_EXEC_PATH", "")
    if not godot or not Path(godot).is_file():
        completed = _run(["bash", str(ROOT / "scripts" / "gdbench_e2e" / "setup.sh")])
        if completed.returncode == 0:
            for line in completed.stdout.splitlines():
                if line.startswith("GODOT_EXEC_PATH="):
                    godot = line.split("=", 1)[1]
                    os.environ["GODOT_EXEC_PATH"] = godot
        if not godot:
            completed = _run(["bash", str(ROOT / "scripts" / "setup_godot.sh")])
            if completed.returncode == 0 and completed.stdout.strip():
                godot = completed.stdout.strip()
                os.environ["GODOT_EXEC_PATH"] = godot
    ok = runner.is_file() and any((GDBENCH / "tasks").glob("task_*.zip")) and bool(godot)
    report.add(PhaseResult("gdbench_environment", ok, f"runner={runner} godot={godot or 'missing'}"))


def phase_vgamegym_dataset(report: SmokeReport, *, download: bool) -> None:
    dataset = VGAME / "gamegym_testset" / "pygame_seeds_2500_filtered.jsonl"
    if not dataset.is_file() and download:
        env = {}
        if token := os.environ.get("HF_TOKEN"):
            env["HF_TOKEN"] = token
        completed = _run(
            [sys.executable, "scripts/download_vgamegym_dataset.py"],
            env=env,
        )
        if completed.returncode != 0:
            report.add(PhaseResult("vgamegym_dataset", False, completed.stderr[-500:]))
            return
    report.add(PhaseResult("vgamegym_dataset", dataset.is_file(), str(dataset)))


def phase_gamegen_verifier(report: SmokeReport) -> None:
    ok = (GGV / "harness" / "run_normal_eval.py").is_file()
    report.add(PhaseResult("gamegen_verifier", ok, str(GGV)))


def phase_bridge_doctors(report: SmokeReport) -> None:
    from game_loop.benchmarks.gcbench_bridge import doctor as gcbench_doctor
    from game_loop.benchmarks.gdbench_bridge import doctor as gdbench_doctor

    if not os.environ.get("GODOT_EXEC_PATH"):
        completed = _run(["bash", str(ROOT / "scripts" / "gdbench_e2e" / "setup.sh")])
        if completed.returncode == 0:
            for line in completed.stdout.splitlines():
                if line.startswith("GODOT_EXEC_PATH="):
                    os.environ["GODOT_EXEC_PATH"] = line.split("=", 1)[1]
        if not os.environ.get("GODOT_EXEC_PATH"):
            completed = _run(["bash", str(ROOT / "scripts" / "setup_godot.sh")])
            if completed.returncode == 0 and completed.stdout.strip():
                os.environ["GODOT_EXEC_PATH"] = completed.stdout.strip()

    gcbench_fixture = SMOKE / "gcbench"
    gcbench_report = gcbench_doctor(
        workspace=gcbench_fixture / "workspace",
        instruction=gcbench_fixture / "instruction.md",
        evaluator_command=[sys.executable, str(ROOT / "scripts" / "gcbench_e2e" / "run_local_verifier.sh")],
    )
    gdbench_fixture = SMOKE / "gdbench"
    gdbench_report = gdbench_doctor(
        gdbench_root=GDBENCH,
        agent_workspace=gdbench_fixture / "public_task",
        private_task_source=gdbench_fixture / "private_task",
        instruction_file=gdbench_fixture / "instruction.txt",
    )
    ok = gcbench_report["ok"] and gdbench_report["ok"]
    report.add(
        PhaseResult(
            "bridge_doctors",
            ok,
            json.dumps({"gcbench": gcbench_report, "gdbench": gdbench_report}, ensure_ascii=False),
        )
    )


def phase_agentx_nested(report: SmokeReport) -> None:
    completed = _run([sys.executable, "-m", "unittest", "tests.test_agentx_nested", "-q"])
    report.add(PhaseResult("agentx_nested", completed.returncode == 0, completed.stderr[-300:]))


def _runtime_profile(provider: str, *, awesome_skills: bool = False) -> dict:
    from game_loop.runtime.profile import merge_runtime_profile
    from game_loop.utils import read_json

    return merge_runtime_profile(
        opengame_profile=read_json(OPENGAME_PROFILE),
        baseline_profile=(
            None if not awesome_skills else read_json(AWESOME_SKILLS_BASELINE)
        ),
        backbone_profile=read_json(BACKBONES / f"{provider}.json"),
    ).to_dict()


def phase_benchmark_e2e(
    report: SmokeReport, *, provider: str, quick: bool, awesome_skills: bool = False
) -> None:
    failures: list[str] = []
    passes: list[str] = []
    env = {}
    if token := os.environ.get("DEEPSEEK_API_KEY"):
        env["DEEPSEEK_API_KEY"] = token
    env.setdefault("GAMECRAFT_BENCH_JUDGE", "stub")
    runtime_json = json.dumps(_runtime_profile(provider, awesome_skills=awesome_skills))
    run_label = provider + ("-awesome-skills" if awesome_skills else "")
    out_root = ROOT / ".smoke" / "comprehensive-e2e" / run_label
    out_root.mkdir(parents=True, exist_ok=True)

    # gcbench
    gcbench_manifest = out_root / "gcbench_execution.json"
    gcbench_breakdown = out_root / "gcbench_verifier" / "breakdown.json"
    gcbench_cmd = [
        sys.executable,
        "-m",
        "game_loop.benchmarks.gcbench_bridge",
        "--workspace",
        str(SMOKE / "gcbench" / "workspace"),
        "--instruction-file",
        str(SMOKE / "gcbench" / "instruction.md"),
        "--output-manifest",
        str(gcbench_manifest),
        "--breakdown-path",
        str(gcbench_breakdown),
        "--runtime-config-json",
        runtime_json,
        "--evaluator-command-json",
        json.dumps([
            "bash",
            str(ROOT / "scripts" / "gcbench_e2e" / "run_local_verifier.sh"),
            "--task",
            "platformer-wall-dancer",
            "--artifact",
            "{artifact}",
            "--output",
            "{output_dir}",
        ]),
        "--timeout",
        "900" if quick else "3600",
    ]
    completed = _run(gcbench_cmd, env=env)
    if completed.returncode != 0:
        failures.append(f"gcbench: {completed.stdout[-500:]}{completed.stderr[-500:]}")
    else:
        passes.append("gcbench")

    # vgamegym
    vgame_manifest = out_root / "vgamegym_execution.json"
    vgame_cmd = [
        sys.executable,
        "-m",
        "game_loop.benchmarks.vgamegym_bridge",
        "--agent-workspace",
        str(SMOKE / "vgamegym" / "workspace"),
        "--instruction-file",
        str(SMOKE / "vgamegym" / "instruction.md"),
        "--task-root",
        str(SMOKE / "vgamegym" / "public_task"),
        "--output-manifest",
        str(vgame_manifest),
        "--runtime-config-json",
        runtime_json,
        "--evaluator-command-json",
        json.dumps([
            str(VGAME_PYTHON if VGAME_PYTHON.is_file() else sys.executable),
            str(ROOT / "scripts" / "run_vgamegym_smoke_evaluator.py"),
            "--official-root",
            str(VGAME),
            "--task-root",
            "{task_root}",
            "--artifact-dir",
            "{artifact_dir}",
            "--raw-output",
            "{raw_output}",
            "--record-duration",
            "8" if quick else "10",
        ]),
        "--timeout",
        "900" if quick else "3600",
    ]
    vgame_env = dict(env)
    vgame_env.setdefault("VGAMEGYM_VL_BASE_URL", os.environ.get("VGAMEGYM_VL_BASE_URL", "http://29.116.237.141:8080/v1"))
    vgame_env.setdefault("VGAMEGYM_TEXT_BASE_URL", os.environ.get("VGAMEGYM_TEXT_BASE_URL", "http://29.116.237.135:8080/v1"))
    vgame_env.setdefault("SDL_VIDEODRIVER", "dummy")
    vgame_env.setdefault("PYGAME_HIDE_SUPPORT_PROMPT", "1")
    completed = _run(vgame_cmd, env=vgame_env)
    if completed.returncode != 0:
        failures.append(f"vgamegym: {completed.stdout[-500:]}{completed.stderr[-500:]}")
    else:
        passes.append("vgamegym")

    # verigame
    verigame_manifest = out_root / "verigame_execution.json"
    verigame_cmd = [
        sys.executable,
        "-m",
        "game_loop.benchmarks.verigame_bridge",
        "--agent-workspace",
        str(SMOKE / "verigame" / "workspace"),
        "--instruction-file",
        str(SMOKE / "verigame" / "instruction.md"),
        "--task-root",
        str(SMOKE / "verigame" / "public_task"),
        "--output-manifest",
        str(verigame_manifest),
        "--runtime-config-json",
        runtime_json,
        "--worker-command-json",
        json.dumps([sys.executable, str(ROOT / "scripts" / "ggv_contract_worker.py")]),
        "--timeout",
        "900" if quick else "3600",
    ]
    completed = _run(verigame_cmd, env=env)
    if completed.returncode != 0:
        failures.append(f"verigame: {completed.stdout[-500:]}{completed.stderr[-500:]}")
    else:
        passes.append("verigame")

    # gdbench
    with tempfile.TemporaryDirectory(prefix="gdbench-smoke-") as td:
        prepared = _run(
            [
                sys.executable,
                str(ROOT / "scripts" / "gdbench_prepare_task.py"),
                "--gdbench-root",
                str(GDBENCH),
                "--output-dir",
                td,
            ]
        )
        if prepared.returncode != 0:
            failures.append(f"gdbench_prepare: {prepared.stderr[-300:]}")
        else:
            task_dir = Path(prepared.stdout.strip())
            task_name = task_dir.name
            gdbench_manifest = out_root / "gdbench_execution.json"
            gdbench_cmd = [
                sys.executable,
                "-m",
                "game_loop.benchmarks.gdbench_bridge",
                "--gdbench-root",
                str(GDBENCH),
                "--agent-workspace",
                str(SMOKE / "gdbench" / "public_task"),
                "--private-task-source",
                str(task_dir),
                "--task-name",
                task_name,
                "--instruction-file",
                str(SMOKE / "gdbench" / "instruction.txt"),
                "--output-manifest",
                str(gdbench_manifest),
                "--runtime-config-json",
                runtime_json,
                "--timeout",
                "900" if quick else "3600",
            ]
            gdbench_env = dict(env)
            if godot := os.environ.get("GODOT_EXEC_PATH"):
                gdbench_env["GODOT_EXEC_PATH"] = godot
            completed = _run(gdbench_cmd, env=gdbench_env)
            if completed.returncode != 0:
                failures.append(f"gdbench: {completed.stdout[-500:]}{completed.stderr[-500:]}")
            else:
                passes.append("gdbench")

    report.add(PhaseResult(
        "benchmark_e2e",
        not failures,
        f"passed={passes}\n" + "\n---\n".join(failures),
    ))


def run_smoke(
    *,
    provider: str = "kimi",
    providers: list[str] | None = None,
    quick: bool = True,
    skip_e2e: bool = False,
    skip_provider_smokes: bool = False,
    awesome_skills: bool = False,
    download_dataset: bool = True,
    require_credentials: bool = False,
    output: Path | None = None,
) -> SmokeReport:
    report = SmokeReport()
    phase_unit_tests(report)
    phase_config_validation(report)
    phase_provider_doctor(report, require_credentials=require_credentials)
    phase_opengame_doctor(report)
    phase_gcbench_environment(report)
    phase_gdbench_environment(report)
    phase_vgamegym_dataset(report, download=download_dataset)
    phase_gamegen_verifier(report)
    phase_bridge_doctors(report)
    phase_agentx_nested(report)
    if not skip_provider_smokes:
        phase_provider_smokes(report, providers or ["deepseek", "kimi", "glm", "qwen"])
    if not skip_e2e:
        phase_benchmark_e2e(
            report,
            provider=provider,
            quick=quick,
            awesome_skills=awesome_skills,
        )
    if output is not None:
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_text(json.dumps(report.to_dict(), ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return report


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--provider", default="deepseek", help="Backbone provider for benchmark E2E")
    parser.add_argument("--quick", action="store_true", default=True)
    parser.add_argument("--full", action="store_true")
    parser.add_argument("--skip-e2e", action="store_true")
    parser.add_argument("--skip-provider-smokes", action="store_true")
    parser.add_argument("--no-download", action="store_true")
    parser.add_argument("--require-credentials", action="store_true")
    parser.add_argument("--awesome-skills", action="store_true")
    parser.add_argument("--output", type=Path, default=ROOT / ".smoke" / "comprehensive-smoke-report.json")
    args = parser.parse_args(argv)
    report = run_smoke(
        provider=args.provider,
        quick=not args.full,
        skip_e2e=args.skip_e2e,
        skip_provider_smokes=args.skip_provider_smokes,
        download_dataset=not args.no_download,
        require_credentials=args.require_credentials,
        awesome_skills=args.awesome_skills,
        output=args.output,
    )
    print(json.dumps(report.to_dict(), ensure_ascii=False, indent=2))
    return 0 if report.ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
