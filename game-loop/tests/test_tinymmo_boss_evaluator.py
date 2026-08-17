from __future__ import annotations

import importlib.util
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location(
    "evaluate_tinymmo_boss", ROOT / "scripts/evaluate_tinymmo_boss.py"
)
assert SPEC is not None and SPEC.loader is not None
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


VALID_TIMELINE = r'''extends RefCounted
class_name BossAttackTimeline

var _token: int = 0
var _active: bool = false
var _center: Vector2
var _radius: float
var _deadline_ms: int
var _label: StringName

func begin_at(center: Vector2, radius: float, windup_ms: int, now_ms: int, label: StringName) -> int:
	_token += 1
	_active = true
	_center = center
	_radius = radius
	_deadline_ms = now_ms + windup_ms
	_label = label
	return _token

func is_due(now_ms: int, token: int) -> bool:
	return _active and token == _token and now_ms >= _deadline_ms

func contains(point: Vector2) -> bool:
	return _active and _center.distance_to(point) <= _radius

func cancel(token: int) -> void:
	if token == _token:
		_active = false

func snapshot() -> Dictionary:
	return {"center": _center, "radius": _radius, "deadline_ms": _deadline_ms, "label": _label}

func token_is_current(token: int) -> bool:
	return _active and token == _token
'''


VALID_RESOLVER = r'''class_name BossCastResolver
class CastSnapshot:
	var token: int
	var center: Vector2
	var radius: float
	var warning_start_ms: int
	var damage_deadline_ms: int
	var cancelled_token: int
	func _init(t: int, c: Vector2, r: float, start: int, deadline: int, cancelled: int = -1) -> void:
		token = t
		center = c
		radius = r
		warning_start_ms = start
		damage_deadline_ms = deadline
		cancelled_token = cancelled
static func state_at(s: CastSnapshot, now: int) -> Dictionary:
	var live := s.cancelled_token != s.token
	return {"is_warning": live and now >= s.warning_start_ms and now < s.damage_deadline_ms, "is_damage_due": live and now >= s.damage_deadline_ms}
static func should_hit(s: CastSnapshot, point: Vector2) -> bool:
	return s.cancelled_token != s.token and s.center.distance_to(point) <= s.radius
static func cancel(s: CastSnapshot) -> CastSnapshot:
	return CastSnapshot.new(s.token, s.center, s.radius, s.warning_start_ms, s.damage_deadline_ms, s.token)
'''


def test_boss_timeline_contract_accepts_correct_deterministic_behavior(tmp_path: Path) -> None:
    source = tmp_path / "boss_attack_timeline.gd"
    source.write_text(VALID_TIMELINE, encoding="utf-8")
    result = MODULE._run_timeline_contract(
        source,
        "/Applications/Godot.app/Contents/MacOS/Godot",
        30,
    )
    assert result["complete"] is True
    assert result["score"] == 1.0
    assert all(result["checks"].values())


def test_boss_contract_accepts_immutable_resolver_design(tmp_path: Path) -> None:
    source = tmp_path / "boss_cast_resolver.gd"
    source.write_text(VALID_RESOLVER, encoding="utf-8")
    result = MODULE._run_timeline_contract(
        source,
        "/Applications/Godot.app/Contents/MacOS/Godot",
        30,
    )
    assert result["complete"] is True
    assert result["score"] == 1.0
    assert all(result["checks"].values())
