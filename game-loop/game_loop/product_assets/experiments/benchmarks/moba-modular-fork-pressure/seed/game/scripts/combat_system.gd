class_name CombatSystem
extends RefCounted

signal damage_applied(source_id: String, target_id: String, amount: float)
signal unit_died(unit_id: String, killer_id: String)

## Combat is fully data-driven on `state`. Units live in `state["units"]`,
## structures in `state["structures"]`, and in-flight projectiles in
## `state["projectiles"]`. This is the single authority for hit resolution,
## cooldowns, abilities, death and champion respawn. Replay and normal play both
## go through `issue_action` / `step`.


func reset(state: Dictionary) -> void:
	state["projectiles"] = []
	for id in state["units"]:
		var u: Dictionary = state["units"][id]
		u["cooldown"] = 0.0
		u["q_cd"] = 0.0
		u["e_cd"] = 0.0
		u["alive"] = true
		u["hp"] = u["max_hp"]
		u["respawn_t"] = 0.0
		u["target"] = ""
		u["move_to"] = Vector2.ZERO
		u["state"] = "push"


func _target_object(state: Dictionary, target_id: String) -> Dictionary:
	if state["units"].has(target_id):
		return state["units"][target_id]
	if state["structures"].has(target_id):
		return state["structures"][target_id]
	return {}


func step(state: Dictionary, delta: float) -> Array[Dictionary]:
	var events: Array[Dictionary] = []
	for id in state["units"]:
		var u: Dictionary = state["units"][id]
		u["cooldown"] = maxf(u["cooldown"] - delta, 0.0)
		u["q_cd"] = maxf(u["q_cd"] - delta, 0.0)
		u["e_cd"] = maxf(u["e_cd"] - delta, 0.0)
	for id in state["units"]:
		var u: Dictionary = state["units"][id]
		if not u["alive"] and u.get("is_champion", false):
			u["respawn_t"] -= delta
			if u["respawn_t"] <= 0.0:
				_respawn_unit(state, u)
				events.append({"type": "respawn", "unit": id})
	_update_projectiles(state, delta, events)
	return events


func _respawn_unit(state: Dictionary, u: Dictionary) -> void:
	var base: Vector2 = state["spawns"][u["team"]]
	u["alive"] = true
	u["hp"] = u["max_hp"]
	u["x"] = base.x
	u["y"] = base.y
	u["state"] = "push"
	u["wp"] = 0
	u["cooldown"] = 0.0
	u["q_cd"] = 0.0
	u["e_cd"] = 0.0
	u["target"] = ""
	u["move_to"] = Vector2.ZERO


func _update_projectiles(state: Dictionary, delta: float, events: Array) -> void:
	var remaining: Array = []
	for p in state["projectiles"]:
		var target: Dictionary = _target_object(state, p["target"])
		if target.is_empty() or not target.get("alive", false):
			continue
		var dx: float = target["x"] - p["x"]
		var dy: float = target["y"] - p["y"]
		var dist: float = sqrt(dx * dx + dy * dy)
		if dist <= 0.001:
			continue
		var step_dist: float = p["speed"] * delta
		if dist <= step_dist:
			_apply_damage(state, p["source"], p["target"], p["damage"], events, p["team"])
		else:
			p["x"] += dx / dist * step_dist
			p["y"] += dy / dist * step_dist
			remaining.append(p)
	state["projectiles"] = remaining


func _apply_damage(state: Dictionary, source_id: String, target_id: String, amount: float, events: Array, team: String) -> void:
	var target: Dictionary = _target_object(state, target_id)
	if target.is_empty() or not target.get("alive", false):
		return
	target["hp"] -= amount
	damage_applied.emit(source_id, target_id, amount)
	events.append({"type": "damage", "source": source_id, "target": target_id, "amount": amount, "team": team})
	if target["hp"] <= 0.0:
		target["hp"] = 0.0
		target["alive"] = false
		if target.get("is_structure", false):
			events.append({"type": "structure_destroyed", "structure": target_id, "team": team, "side": target["team"]})
		else:
			unit_died.emit(target_id, source_id)
			events.append({"type": "death", "unit": target_id, "killer": source_id, "team": target["team"], "killer_team": team})
			if target.get("is_champion", false):
				target["respawn_t"] = state["champion_respawn_time"]


## Spawn a basic-attack projectile from actor toward target.
func perform_attack(state: Dictionary, actor_id: String, target_id: String) -> bool:
	var u: Dictionary = state["units"].get(actor_id, {})
	if u.is_empty() or not u["alive"]:
		return false
	if u["cooldown"] > 0.0:
		return false
	u["cooldown"] = u["attack_rate"]
	u["target"] = target_id
	u["state"] = "fight"
	var dmg: float = u["dmg"] * u.get("buff", 1.0)
	state["projectiles"].append({
		"x": u["x"], "y": u["y"], "target": target_id, "speed": u["proj_speed"],
		"damage": dmg, "source": actor_id, "team": u["team"],
	})
	return true


func issue_action(state: Dictionary, actor_id: String, action: Dictionary) -> Dictionary:
	var u: Dictionary = state["units"].get(actor_id, {})
	if u.is_empty() or not u["alive"]:
		return {"accepted": false, "reason": "not_alive"}
	match action.get("type", ""):
		"basic_attack":
			return {"accepted": perform_attack(state, actor_id, action.get("target", "")), "effect": "attack"}
		"ability_q":
			if u["q_cd"] > 0.0:
				return {"accepted": false, "reason": "q_cd"}
			u["q_cd"] = u["q_cd_max"]
			u["state"] = "fight"
			_cast_strike(state, u, action.get("target", ""))
			return {"accepted": true, "effect": "strike"}
		"ability_e":
			if u["e_cd"] > 0.0:
				return {"accepted": false, "reason": "e_cd"}
			u["e_cd"] = u["e_cd_max"]
			u["state"] = "fight"
			_cast_nova(state, u)
			return {"accepted": true, "effect": "nova"}
	return {"accepted": false, "reason": "unknown_action"}


func _cast_strike(state: Dictionary, u: Dictionary, target_id: String) -> void:
	var cx: float = u["x"]
	var cy: float = u["y"]
	var direct: String = target_id
	if state["units"].has(target_id):
		var t: Dictionary = state["units"][target_id]
		cx = t["x"]
		cy = t["y"]
	var events: Array = []
	var dmg: float = 110.0 * u.get("buff", 1.0)
	state["effect_fx"].append({"type": "strike", "x": cx, "y": cy, "t": 0.3})
	if state["units"].has(direct) and state["units"][direct]["alive"]:
		_apply_damage(state, u["id"], direct, dmg, events, u["team"])
	# Splash around strike point (units).
	var splash: float = 70.0 * u.get("buff", 1.0)
	for id in state["units"]:
		var other: Dictionary = state["units"][id]
		if not other["alive"] or other["team"] == u["team"] or id == direct:
			continue
		if _dist(other["x"], other["y"], cx, cy) <= 95.0:
			_apply_damage(state, u["id"], id, splash, events, u["team"])
	# Splash also damages enemy structures.
	for sid in state["structures"]:
		var s: Dictionary = state["structures"][sid]
		if not s["alive"] or s["team"] == u["team"]:
			continue
		if _dist(s["x"], s["y"], cx, cy) <= 95.0:
			_apply_damage(state, u["id"], sid, splash, events, u["team"])


func _cast_nova(state: Dictionary, u: Dictionary) -> void:
	var events: Array = []
	var dmg: float = 150.0 * u.get("buff", 1.0)
	state["effect_fx"].append({"type": "nova", "x": u["x"], "y": u["y"], "t": 0.4})
	for id in state["units"]:
		var other: Dictionary = state["units"][id]
		if not other["alive"] or other["team"] == u["team"]:
			continue
		if _dist(other["x"], other["y"], u["x"], u["y"]) <= 230.0:
			_apply_damage(state, u["id"], id, dmg, events, u["team"])
	for sid in state["structures"]:
		var s: Dictionary = state["structures"][sid]
		if not s["alive"] or s["team"] == u["team"]:
			continue
		if _dist(s["x"], s["y"], u["x"], u["y"]) <= 230.0:
			_apply_damage(state, u["id"], sid, dmg, events, u["team"])


func _dist(x1: float, y1: float, x2: float, y2: float) -> float:
	var dx: float = x1 - x2
	var dy: float = y1 - y2
	return sqrt(dx * dx + dy * dy)
