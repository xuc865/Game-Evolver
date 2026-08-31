class_name EconomySystem
extends RefCounted

signal balance_changed(team: String, balance: int)
signal upgrade_applied(actor_id: String, upgrade_id: String)

## Combat awards gold to the acting team; gold is spent on persistent match
## upgrades that change real combat stats (damage, max HP, attack speed). These
## upgrades are stored in `state["upgrades"]` and read back by combat/AI each
## frame, so the effect is observable mid-match.

const UPGRADES := {
	"power": {"cost": 100, "label": "Power", "desc": "+25% damage"},
	"vitality": {"cost": 100, "label": "Vitality", "desc": "+120 max HP"},
	"haste": {"cost": 120, "label": "Haste", "desc": "+25% attack speed"},
}
const REWARDS := {
	"kill": 60, "minion": 18, "tower": 120, "core": 400,
	"neutral": 150, "assist": 10,
}


func reset(state: Dictionary) -> void:
	for t in ["blue", "red"]:
		state["teams"][t]["gold"] = 0
		state["teams"][t]["spent"] = 0
	state["upgrades"] = {}
	for id in state["units"]:
		state["upgrades"][id] = {}


func reward(state: Dictionary, team: String, reason: String) -> int:
	var amount: int = REWARDS.get(reason, 10)
	state["teams"][team]["gold"] += amount
	balance_changed.emit(team, state["teams"][team]["gold"])
	state["log"].append({"frame": state["frame"], "type": "gold", "team": team, "amount": amount, "reason": reason})
	return amount


func purchase(state: Dictionary, actor_id: String, upgrade_id: String) -> Dictionary:
	if not UPGRADES.has(upgrade_id):
		return {"accepted": false, "reason": "unknown_upgrade"}
	var u: Dictionary = state["units"].get(actor_id, {})
	if u.is_empty():
		return {"accepted": false, "reason": "no_unit"}
	var team: String = u["team"]
	var cost: int = UPGRADES[upgrade_id]["cost"]
	if state["teams"][team]["gold"] < cost:
		return {"accepted": false, "reason": "insufficient_gold"}
	state["teams"][team]["gold"] -= cost
	state["teams"][team]["spent"] += cost
	if not state["upgrades"].has(actor_id):
		state["upgrades"][actor_id] = {}
	state["upgrades"][actor_id][upgrade_id] = state["upgrades"][actor_id].get(upgrade_id, 0) + 1
	_apply_upgrade(u, upgrade_id)
	upgrade_applied.emit(actor_id, upgrade_id)
	state["log"].append({"frame": state["frame"], "type": "upgrade", "unit": actor_id, "upgrade": upgrade_id})
	return {"accepted": true, "upgrade": upgrade_id, "cost": cost}


func _apply_upgrade(u: Dictionary, upgrade_id: String) -> void:
	match upgrade_id:
		"power":
			u["dmg"] = u["dmg"] * 1.25
			u["power_tier"] = u.get("power_tier", 0) + 1
		"vitality":
			u["max_hp"] += 120.0
			u["hp"] = minf(u["hp"] + 120.0, u["max_hp"])
		"haste":
			u["attack_rate"] = maxf(u["attack_rate"] * 0.75, 0.15)
