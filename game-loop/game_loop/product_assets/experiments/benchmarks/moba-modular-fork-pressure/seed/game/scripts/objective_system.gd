class_name ObjectiveSystem
extends RefCounted

signal objective_changed(objective_id: String, owner: String)
signal match_resolved(winner: String)

## Structures (towers and cores) are the map objectives that win/lose the game.
## The neutral "Nexus Beacon" is a contested objective in mid: whichever side
## controls it receives a team-wide damage buff that materially shifts fights.
## Towers auto-fire at nearby enemies; cores do too. Destroying the enemy core
## resolves the match.


func reset(state: Dictionary) -> void:
	for sid in state["structures"]:
		var s: Dictionary = state["structures"][sid]
		s["hp"] = s["max_hp"]
		s["alive"] = true
		s["cooldown"] = 0.0
	state["neutral"]["owner"] = "none"
	state["neutral"]["progress"] = 0.0
	state["neutral"]["buff_t"] = 0.0
	state["neutral"]["buff_team"] = ""
	state["match_phase"] = "playing"
	state["score"] = {"blue": 0, "red": 0}


func step(state: Dictionary, delta: float) -> Array[Dictionary]:
	var events: Array[Dictionary] = []
	_towers_fire(state, delta, events)
	_update_neutral(state, delta, events)
	_check_structures(state, events)
	return events


func _towers_fire(state: Dictionary, delta: float, events: Array) -> void:
	for sid in state["structures"]:
		var s: Dictionary = state["structures"][sid]
		if not s["alive"]:
			continue
		s["cooldown"] = maxf(s["cooldown"] - delta, 0.0)
		var target: String = _nearest_enemy_unit(state, s)
		if target != "" and s["cooldown"] <= 0.0:
			s["cooldown"] = s["attack_rate"]
			var u: Dictionary = state["units"][target]
			state["projectiles"].append({
				"x": s["x"], "y": s["y"], "target": target, "speed": s["proj_speed"],
				"damage": s["dmg"], "source": sid, "team": s["team"],
			})
			events.append({"type": "tower_fire", "tower": sid, "target": target})


func _nearest_enemy_unit(state: Dictionary, s: Dictionary) -> String:
	var best: String = ""
	var best_d: float = s["range"]
	for id in state["units"]:
		var u: Dictionary = state["units"][id]
		if not u["alive"] or u["team"] == s["team"]:
			continue
		var d: float = _dist(u["x"], u["y"], s["x"], s["y"])
		if d <= best_d:
			best = id
			best_d = d
	return best


func _update_neutral(state: Dictionary, delta: float, events: Array) -> void:
	var n: Dictionary = state["neutral"]
	# Active buff: tick it down; on expiry, drop the objective so it's contested again.
	if n["buff_t"] > 0.0:
		n["buff_t"] -= delta
		if n["buff_t"] <= 0.0:
			n["owner"] = "none"
			n["buff_team"] = ""
			objective_changed.emit("nexus", "none")
			events.append({"type": "neutral_lost", "loser": n["owner"]})
			print("[NEUTRAL] buff expired frame=", state["frame"])
		return
	if n["owner"] != "none":
		n["owner"] = "none"
	# Determine which team holds presence on the beacon (count units in radius).
	var counts := {"blue": 0, "red": 0}
	for id in state["units"]:
		var u: Dictionary = state["units"][id]
		if not u["alive"]:
			continue
		if _dist(u["x"], u["y"], n["x"], n["y"]) <= 100.0:
			counts[u["team"]] += 1
	var present: String = "none"
	if counts["blue"] > counts["red"]:
		present = "blue"
	elif counts["red"] > counts["blue"]:
		present = "red"
	if present != "none":
		n["progress"] += delta
		if n["progress"] >= n["capture_time"]:
			n["owner"] = present
			n["progress"] = 0.0
			n["buff_team"] = present
			n["buff_t"] = n["buff_duration"]
			_apply_buff(state, present)
			objective_changed.emit("nexus", present)
			events.append({"type": "neutral_captured", "owner": present})


func _apply_buff(state: Dictionary, team: String) -> void:
	for id in state["units"]:
		var u: Dictionary = state["units"][id]
		if u["team"] == team:
			u["buff"] = 1.5


func snapshot(state: Dictionary) -> Dictionary:
	var structs: Array = []
	for sid in state["structures"]:
		var s: Dictionary = state["structures"][sid]
		structs.append({"id": sid, "team": s["team"], "hp": int(s["hp"]), "alive": s["alive"]})
	return {
		"structures": structs,
		"neutral_owner": state["neutral"]["owner"],
		"neutral_buff_team": state["neutral"]["buff_team"],
		"match_phase": state["match_phase"],
		"winner": state.get("winner", ""),
	}


## Public post-combat resolution check so a core destroyed this frame is
## immediately detected (not one frame late).
func check_resolution(state: Dictionary) -> Array[Dictionary]:
	var events: Array[Dictionary] = []
	_check_structures(state, events)
	return events


func _check_structures(state: Dictionary, events: Array) -> void:
	if state["match_phase"] != "playing":
		return
	for sid in ["blue_core", "red_core"]:
		var s: Dictionary = state["structures"][sid]
		if s["hp"] > 0.0:
			continue
		s["alive"] = false
		state["match_phase"] = "resolved"
		state["winner"] = "red" if sid == "blue_core" else "blue"
		state["log"].append({"frame": state["frame"], "type": "match_end", "winner": state["winner"]})
		match_resolved.emit(state["winner"])
		events.append({"type": "match_resolved", "winner": state["winner"]})


func _dist(x1: float, y1: float, x2: float, y2: float) -> float:
	var dx: float = x1 - x2
	var dy: float = y1 - y2
	return sqrt(dx * dx + dy * dy)
