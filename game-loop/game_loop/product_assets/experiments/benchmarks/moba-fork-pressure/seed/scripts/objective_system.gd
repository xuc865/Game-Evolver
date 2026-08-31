class_name ObjectiveSystem
extends RefCounted

signal objective_changed(objective_id: String, owner: String)
signal match_resolved(winner: String)


func reset(_state: Dictionary) -> void:
	pass


func step(_state: Dictionary, _delta: float) -> Array[Dictionary]:
	return []


func snapshot(_state: Dictionary) -> Dictionary:
	return {"structures": [], "neutral_owner": "none", "match_phase": "setup"}
