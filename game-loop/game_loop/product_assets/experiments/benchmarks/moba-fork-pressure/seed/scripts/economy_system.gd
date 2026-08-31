class_name EconomySystem
extends RefCounted

signal balance_changed(team: String, balance: int)
signal upgrade_applied(actor_id: String, upgrade_id: String)


func reset(_state: Dictionary) -> void:
	pass


func reward(_state: Dictionary, _team: String, _reason: String) -> int:
	return 0


func purchase(_state: Dictionary, _actor_id: String, _upgrade_id: String) -> Dictionary:
	return {"accepted": false, "reason": "economy_not_implemented"}
