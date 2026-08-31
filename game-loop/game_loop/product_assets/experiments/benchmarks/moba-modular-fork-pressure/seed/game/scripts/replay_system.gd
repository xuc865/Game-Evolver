class_name ReplaySystem
extends RefCounted

## Deterministic replay: parses a JSON input trace, groups events by frame, and
## dispatches them through the exact same command path used for live input. It
## records state changes and builds a coverage report proving which systems were
## exercised with observable state deltas.

var trace: Dictionary = {}
var current_frame := 0
var dispatched_events := 0
var state_changes := 0
var _by_frame: Dictionary = {}
var _covered_systems: Dictionary = {}
var _last_frame := -1


func load_trace(path: String) -> Dictionary:
	if not FileAccess.file_exists(path):
		return {"accepted": false, "reason": "file_missing", "path": path}
	var f := FileAccess.open(path, FileAccess.READ)
	if f == null:
		return {"accepted": false, "reason": "cannot_open"}
	var data = JSON.parse_string(f.get_as_text())
	if typeof(data) != TYPE_DICTIONARY:
		return {"accepted": false, "reason": "invalid_json"}
	if not data.has("scenario") or not data.has("duration_frames"):
		return {"accepted": false, "reason": "missing_fields"}
	trace = data
	current_frame = 0
	dispatched_events = 0
	state_changes = 0
	_covered_systems = {}
	_by_frame = {}
	for e in trace.get("events", []):
		var frame: int = int(e.get("frame", 0))
		if not _by_frame.has(frame):
			_by_frame[frame] = []
		_by_frame[frame].append(e)
	return {"accepted": true, "scenario": trace["scenario"], "duration_frames": int(trace["duration_frames"])}


func events_for_frame(frame: int) -> Array[Dictionary]:
	var out: Array[Dictionary] = []
	for e in _by_frame.get(frame, []):
		out.append(e)
		dispatched_events += 1
	return out


## Compare two snapshots and mark which subsystems changed. Called once per
## frame by the runner with the authoritative state before/after the frame.
func record_state_change(before: Dictionary, after: Dictionary) -> void:
	var b: Dictionary = before.get("snapshot", before)
	var a: Dictionary = after.get("snapshot", after)
	if b.is_empty() or a.is_empty():
		return
	var diff := false
	# Combat: unit hp / alive / projectiles / abilities changed.
	if b.get("hp") != a.get("hp") or b.get("alive") != a.get("alive") \
			or b.get("proj") != a.get("proj") or b.get("cd") != a.get("cd"):
		_covered_systems["combat"] = true
		diff = true
	if b.get("ai_state") != a.get("ai_state"):
		_covered_systems["ai"] = true
		diff = true
	if b.get("gold") != a.get("gold") or b.get("upgrades") != a.get("upgrades"):
		_covered_systems["economy"] = true
		diff = true
	if b.get("structures") != a.get("structures") or b.get("neutral") != a.get("neutral") \
			or b.get("match_phase") != a.get("match_phase"):
		_covered_systems["objectives"] = true
		diff = true
	if b.get("hud") != a.get("hud") or b.get("score") != a.get("score"):
		_covered_systems["hud"] = true
		diff = true
	if b.get("frame") != a.get("frame") or a.get("frame", -1) != _last_frame:
		_covered_systems["replay"] = true
	_last_frame = a.get("frame", -1)
	if diff or b.get("frame") != a.get("frame"):
		state_changes += 1


func coverage_report() -> Dictionary:
	var sys: Array = []
	for s in ["combat", "ai", "economy", "objectives", "hud", "replay"]:
		if _covered_systems.get(s, false):
			sys.append(s)
	return {
		"events": dispatched_events,
		"state_changes": state_changes,
		"systems": sys,
		"scenario": trace.get("scenario", ""),
		"frames": current_frame,
	}
