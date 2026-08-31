class_name ReplaySystem
extends RefCounted

var trace: Dictionary = {}
var current_frame := 0
var dispatched_events := 0


func load_trace(_path: String) -> Dictionary:
	return {"accepted": false, "reason": "replay_not_implemented"}


func events_for_frame(_frame: int) -> Array[Dictionary]:
	return []


func record_state_change(_before: Dictionary, _after: Dictionary) -> void:
	pass


func coverage_report() -> Dictionary:
	return {"events": dispatched_events, "state_changes": 0, "systems": []}
