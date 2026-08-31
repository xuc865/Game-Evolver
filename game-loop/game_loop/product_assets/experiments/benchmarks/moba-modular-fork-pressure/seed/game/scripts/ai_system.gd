class_name AISystem
extends RefCounted

## Autonomous behaviour for allied/enemy champions and minions. Each AI unit is
## annotated with an `intent` that normal play and replay consume identically.
## Three clearly distinguishable states are produced: "push" (advancing the
## lane toward enemy structures), "fight" (engaged with a target) and
## "retreat" (low-hp champion falling back to its base).


func reset(state: Dictionary, seed: int) -> void:
	state["rng"] = RandomNumberGenerator.new()
	state["rng"].seed = seed


func choose_intent(actor: Dictionary, snapshot: Dictionary) -> Dictionary:
	# Exposed for inspection; the full computation lives in step().
	return {"state": actor.get("state", "idle"), "action": "none", "move": Vector2(actor["x"], actor["y"])}


func step(state: Dictionary, _delta: float) -> Array[Dictionary]:
	var events: Array[Dictionary] = []
	for id in state["units"]:
		var u: Dictionary = state["units"][id]
		if not u["alive"]:
			continue
		if u.get("is_player", false):
			continue
		u["intent"] = _decide(state, u)
		if u["intent"]["state"] != u.get("state", ""):
			events.append({"type": "ai_state", "unit": id, "state": u["intent"]["state"]})
	return events


func _decide(state: Dictionary, u: Dictionary) -> Dictionary:
	var team: String = u["team"]
	# Retreat: champions below 25% hp fall back.
	if u.get("is_champion", false) and u["hp"] < u["max_hp"] * 0.25:
		u["state"] = "retreat"
		var base: Vector2 = state["spawns"][team]
		return {"state": "retreat", "action": "move", "move": base, "target": "", "cast_ability": "none"}

	var target: String = _find_nearest_target(state, u, team)
	var aggro: float = u.get("aggro", 300.0)
	var move: Vector2 = Vector2(u["x"], u["y"])

	if target != "":
		var t: Dictionary = _target_obj(state, target)
		var d: float = _dist(u["x"], u["y"], t["x"], t["y"])
		u["state"] = "fight"
		var cast: String = "none"
		if u.get("is_champion", false) and d <= u["range"] * 1.2 and u["q_cd"] <= 0.0:
			cast = "q"
		elif u.get("is_champion", false) and u["e_cd"] <= 0.0 and _nearby_enemies(state, u, team) >= 2:
			cast = "e"
		return {"state": "fight", "action": "attack", "move": Vector2(t["x"], t["y"]), "target": target, "cast_ability": cast}

	# No target in aggro: push the lane.
	u["state"] = "push"
	var lane: Array = state["lanes"][u["lane"]]
	var dir: int = 1 if team == "blue" else -1
	u["wp"] = clampi(u["wp"], 0, lane.size() - 1)
	var wp: Vector2 = lane[u["wp"]]
	if _dist(u["x"], u["y"], wp.x, wp.y) < 45.0:
		u["wp"] = clampi(u["wp"] + dir, 0, lane.size() - 1)
		wp = lane[u["wp"]]
	return {"state": "push", "action": "move", "move": wp, "target": "", "cast_ability": "none"}


func _target_obj(state: Dictionary, target_id: String) -> Dictionary:
	if state["units"].has(target_id):
		return state["units"][target_id]
	if state["structures"].has(target_id):
		return state["structures"][target_id]
	return {}


func _find_nearest_target(state: Dictionary, u: Dictionary, team: String) -> String:
	var aggro: float = u.get("aggro", 300.0)
	var best: String = ""
	var best_d: float = INF
	# Enemy units.
	for id in state["units"]:
		var other: Dictionary = state["units"][id]
		if not other["alive"] or other["team"] == team:
			continue
		var d: float = _dist(u["x"], u["y"], other["x"], other["y"])
		if d <= aggro and d < best_d:
			best = id
			best_d = d
	# Enemy structures.
	for sid in state["structures"]:
		var s: Dictionary = state["structures"][sid]
		if not s["alive"] or s["team"] == team:
			continue
		var d: float = _dist(u["x"], u["y"], s["x"], s["y"])
		if d <= aggro and d < best_d:
			best = sid
			best_d = d
	return best


func _nearby_enemies(state: Dictionary, u: Dictionary, team: String) -> int:
	var count: int = 0
	for id in state["units"]:
		var other: Dictionary = state["units"][id]
		if not other["alive"] or other["team"] == team:
			continue
		if _dist(u["x"], u["y"], other["x"], other["y"]) <= 230.0:
			count += 1
	return count


func _dist(x1: float, y1: float, x2: float, y2: float) -> float:
	var dx: float = x1 - x2
	var dy: float = y1 - y2
	return sqrt(dx * dx + dy * dy)
