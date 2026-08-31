class_name CombatSystem
extends RefCounted

signal damage_applied(source_id: String, target_id: String, amount: float)
signal unit_died(unit_id: String, killer_id: String)


func reset(_state: Dictionary) -> void:
	pass


func step(_state: Dictionary, _delta: float) -> Array[Dictionary]:
	return []


func issue_action(_state: Dictionary, _actor_id: String, _action: Dictionary) -> Dictionary:
	return {"accepted": false, "reason": "combat_not_implemented"}
