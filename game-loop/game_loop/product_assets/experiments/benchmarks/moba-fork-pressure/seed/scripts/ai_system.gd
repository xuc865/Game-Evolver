class_name AISystem
extends RefCounted


func reset(_state: Dictionary, _seed: int) -> void:
	pass


func choose_intent(_actor: Dictionary, _snapshot: Dictionary) -> Dictionary:
	return {"state": "idle", "action": "none"}


func step(_state: Dictionary, _delta: float) -> Array[Dictionary]:
	return []
