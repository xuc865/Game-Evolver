extends Node2D

const COMBAT_SYSTEM = preload("res://scripts/combat_system.gd")
const AI_SYSTEM = preload("res://scripts/ai_system.gd")
const ECONOMY_SYSTEM = preload("res://scripts/economy_system.gd")
const OBJECTIVE_SYSTEM = preload("res://scripts/objective_system.gd")
const HUD_SYSTEM = preload("res://scripts/hud_system.gd")
const REPLAY_SYSTEM = preload("res://scripts/replay_system.gd")

const REQUIRED_SYSTEMS := ["combat", "ai", "economy", "objectives", "hud", "replay"]
const FIXED_DELTA := 1.0 / 60.0
const WAVE_INTERVAL := 300
const VIEW_W := 1280.0
const VIEW_H := 720.0

var combat := COMBAT_SYSTEM.new()
var ai := AI_SYSTEM.new()
var economy := ECONOMY_SYSTEM.new()
var objective := OBJECTIVE_SYSTEM.new()
var replay := REPLAY_SYSTEM.new()
var hud: Control

var state: Dictionary = {}
var _input_dir := Vector2.ZERO
var _cursor := Vector2.ZERO
var _show_help := false
var _replay_done := false

var _fixed_delta := FIXED_DELTA
var _minion_counter := 0
var _global_coverage := {}

# ---------------------------------------------------------------------------
# Boot
# ---------------------------------------------------------------------------
func _ready() -> void:
	_build_state()
	hud = HUD_SYSTEM.new()
	hud.set_anchors_preset(Control.PRESET_FULL_RECT)
	add_child(hud)
	hud.command_requested.connect(_on_hud_command)
	_refresh_hud()
	print("[TRI-LANE] booted systems=", REQUIRED_SYSTEMS)
	var args := OS.get_cmdline_user_args()
	if "--run-replays" in args:
		_run_all_replays()


func _process(delta: float) -> void:
	if _replay_done:
		return
	state["time"] += delta
	state["frame"] += 1
	if state["phase"] == "title":
		_refresh_hud()
		queue_redraw()
		return
	if state["phase"] == "playing":
		_tick(_fixed_delta)
	_refresh_hud()
	queue_redraw()


# ---------------------------------------------------------------------------
# World state construction
# ---------------------------------------------------------------------------
func _build_state() -> void:
	state = {
		"phase": "title", "frame": 0, "time": 0.0,
		"units": {}, "structures": {}, "projectiles": [], "effect_fx": [],
		"teams": {"blue": {"gold": 0, "spent": 0}, "red": {"gold": 0, "spent": 0}},
		"upgrades": {}, "lanes": [], "spawns": {}, "log": [],
		"champion_respawn_time": 180.0, "match_phase": "setup", "winner": "",
		"wave_interval": WAVE_INTERVAL, "spawn_red_initial": true,
		"neutral": {"x": 640, "y": 360, "owner": "none", "progress": 0.0,
			"capture_time": 1.5, "buff_duration": 8.0, "buff_t": 0.0, "buff_team": ""},
		"score": {"blue": 0, "red": 0},
	}
	state["lanes"] = [
		[Vector2(90, 90), Vector2(360, 90), Vector2(640, 90), Vector2(920, 90), Vector2(1190, 90)],
		[Vector2(90, 360), Vector2(360, 360), Vector2(640, 360), Vector2(920, 360), Vector2(1190, 360)],
		[Vector2(90, 630), Vector2(360, 630), Vector2(640, 630), Vector2(920, 630), Vector2(1190, 630)],
	]
	state["spawns"] = {"blue": Vector2(100, 360), "red": Vector2(1180, 360)}
	_create_champions()
	_create_structures()
	combat.reset(state)
	ai.reset(state, 12345)
	economy.reset(state)
	objective.reset(state)


func _create_champions() -> void:
	_champion("player", "Warden", "blue", 100, 360, 1, 500.0, 40.0, true)
	_champion("ally", "Aegis", "blue", 150, 90, 0, 460.0, 35.0, false)
	_champion("enemy1", "Raze", "red", 1180, 360, 1, 460.0, 35.0, false)
	_champion("enemy2", "Vex", "red", 1130, 630, 2, 460.0, 35.0, false)


func _champion(id: String, name: String, team: String, x: float, y: float, lane: int, hp: float, dmg: float, is_player: bool) -> void:
	_add_unit({
		"id": id, "name": name, "team": team, "x": x, "y": y, "lane": lane,
		"is_champion": true, "is_player": is_player,
		"max_hp": hp, "hp": hp, "dmg": dmg, "range": 175.0, "attack_rate": 0.6,
		"speed": 220.0, "aggro": 430.0, "proj_speed": 620.0,
		"q_cd_max": 2.0, "e_cd_max": 6.0,
	})


func _create_structures() -> void:
	var towers := [
		{"id": "blue_tower_0", "x": 360, "y": 90, "team": "blue"},
		{"id": "blue_tower_1", "x": 360, "y": 360, "team": "blue"},
		{"id": "blue_tower_2", "x": 360, "y": 630, "team": "blue"},
		{"id": "red_tower_0", "x": 920, "y": 90, "team": "red"},
		{"id": "red_tower_1", "x": 920, "y": 360, "team": "red"},
		{"id": "red_tower_2", "x": 920, "y": 630, "team": "red"},
	]
	for t in towers:
		state["structures"][t["id"]] = {
			"id": t["id"], "team": t["team"], "x": t["x"], "y": t["y"],
			"is_structure": true, "is_core": false,
			"max_hp": 700.0, "hp": 700.0, "alive": true, "cooldown": 0.0,
			"dmg": 45.0, "range": 275.0, "attack_rate": 1.0, "proj_speed": 460.0,
		}
	state["structures"]["blue_core"] = {
		"id": "blue_core", "team": "blue", "x": 90, "y": 360,
		"is_structure": true, "is_core": true,
		"max_hp": 1600.0, "hp": 1600.0, "alive": true, "cooldown": 0.0,
		"dmg": 65.0, "range": 330.0, "attack_rate": 1.2, "proj_speed": 500.0,
	}
	state["structures"]["red_core"] = {
		"id": "red_core", "team": "red", "x": 1190, "y": 360,
		"is_structure": true, "is_core": true,
		"max_hp": 1600.0, "hp": 1600.0, "alive": true, "cooldown": 0.0,
		"dmg": 65.0, "range": 330.0, "attack_rate": 1.2, "proj_speed": 500.0,
	}


func _add_unit(u: Dictionary) -> void:
	u["alive"] = true
	u["cooldown"] = 0.0
	u["q_cd"] = 0.0
	u["e_cd"] = 0.0
	u["respawn_t"] = 0.0
	u["wp"] = 0
	u["target"] = ""
	u["move_to"] = Vector2.ZERO
	u["state"] = "push"
	u["buff"] = 1.0
	u["power_tier"] = 0
	u["intent"] = {"state": "push", "move": Vector2(u["x"], u["y"]), "target": "", "cast_ability": "none"}
	state["units"][u["id"]] = u
	if not state["upgrades"].has(u["id"]):
		state["upgrades"][u["id"]] = {}


func _minion(team: String, lane: int) -> void:
	_minion_counter += 1
	var id := "minion_%s_%d_%d" % [team, lane, _minion_counter]
	var x: float = 100.0 if team == "blue" else 1180.0
	var y: float = state["lanes"][lane][0].y
	if team == "red":
		y = state["lanes"][lane][state["lanes"][lane].size() - 1].y
	_add_unit({
		"id": id, "name": "Minion", "team": team, "x": x, "y": y, "lane": lane,
		"is_champion": false, "is_player": false,
		"max_hp": 120.0, "hp": 120.0, "dmg": 18.0, "range": 95.0, "attack_rate": 1.0,
		"speed": 140.0, "aggro": 300.0, "proj_speed": 420.0,
		"q_cd_max": 0.0, "e_cd_max": 0.0,
	})
	state["log"].append({"frame": state["frame"], "type": "spawn_minion", "lane": lane, "team": team})


func _spawn_initial_minions() -> void:
	for lane in range(3):
		_minion("blue", lane)
		if state["spawn_red_initial"]:
			_minion("red", lane)


func _spawn_waves() -> void:
	if state["frame"] % int(state["wave_interval"]) != 0:
		return
	for lane in range(3):
		_minion("blue", lane)
		if state["spawn_red_initial"]:
			_minion("red", lane)


# ---------------------------------------------------------------------------
# Match lifecycle
# ---------------------------------------------------------------------------
func _begin_match() -> void:
	state["phase"] = "playing"
	state["match_phase"] = "playing"
	state["frame"] = 0
	_spawn_initial_minions()
	state["log"].append({"frame": 0, "type": "match_start"})


# ---------------------------------------------------------------------------
# Simulation tick
# ---------------------------------------------------------------------------
func _tick(delta: float) -> void:
	_spawn_waves()
	ai.step(state, delta)
	_move_units(delta)
	_fire_actions()
	var events: Array = []
	events.append_array(objective.step(state, delta))
	events.append_array(combat.step(state, delta))
	events.append_array(objective.check_resolution(state))
	_process_events(events)
	_decay_fx(delta)


func _decay_fx(delta: float) -> void:
	var keep: Array = []
	for fx in state["effect_fx"]:
		fx["t"] -= delta
		if fx["t"] > 0.0:
			keep.append(fx)
	state["effect_fx"] = keep


func _move_units(delta: float) -> void:
	for id in state["units"]:
		var u: Dictionary = state["units"][id]
		if not u["alive"]:
			continue
		if u.get("is_player", false):
			if _input_dir.length() > 0.01:
				var d := _input_dir.normalized()
				u["x"] += d.x * u["speed"] * delta
				u["y"] += d.y * u["speed"] * delta
				u["move_to"] = Vector2.ZERO
			elif u["move_to"] != Vector2.ZERO:
				_step_to(u, u["move_to"], delta)
		else:
			var it: Dictionary = u.get("intent", {})
			if it.has("move"):
				_step_to(u, it["move"], delta)
		u["x"] = clampf(u["x"], 40.0, 1240.0)
		u["y"] = clampf(u["y"], 40.0, 680.0)


func _step_to(u: Dictionary, target: Vector2, delta: float) -> void:
	var pos := Vector2(u["x"], u["y"])
	var off := target - pos
	var dist := off.length()
	if dist < 6.0:
		return
	pos += off / dist * u["speed"] * delta
	u["x"] = pos.x
	u["y"] = pos.y


func _fire_actions() -> void:
	# AI / allied champions & minions
	for id in state["units"]:
		var u: Dictionary = state["units"][id]
		if not u["alive"] or u.get("is_player", false):
			continue
		var it: Dictionary = u.get("intent", {})
		if it.get("state", "") != "fight":
			continue
		var target: String = it.get("target", "")
		if target == "":
			continue
		var t: Dictionary = _target_obj(target)
		if t.is_empty():
			continue
		var d: float = _dist(u["x"], u["y"], t["x"], t["y"])
		if d > u["range"]:
			continue
		var cast: String = it.get("cast_ability", "none")
		if u.get("is_champion", false) and cast in ["q", "e"]:
			combat.issue_action(state, id, {"type": "ability_" + cast, "target": target})
		else:
			combat.perform_attack(state, id, target)
	# Player: auto-attack nearest enemy in range, honoring forced target.
	var p: Dictionary = state["units"].get("player", {})
	if p.is_empty() or not p["alive"]:
		return
	var ptarget: String = p.get("target", "")
	if ptarget == "" or not _target_alive(ptarget) or _same_team(p["team"], ptarget):
		ptarget = _nearest_enemy_for_player(p)
	if ptarget != "" and _dist(p["x"], p["y"], _target_obj(ptarget)["x"], _target_obj(ptarget)["y"]) <= p["range"]:
		combat.perform_attack(state, "player", ptarget)


func _same_team(team: String, target_id: String) -> bool:
	if state["units"].has(target_id):
		return state["units"][target_id]["team"] == team
	if state["structures"].has(target_id):
		return state["structures"][target_id]["team"] == team
	return false


func _target_alive(target_id: String) -> bool:
	var t := _target_obj(target_id)
	return not t.is_empty() and t.get("alive", false)


func _target_obj(target_id: String) -> Dictionary:
	if state["units"].has(target_id):
		return state["units"][target_id]
	if state["structures"].has(target_id):
		return state["structures"][target_id]
	return {}


func _nearest_enemy_for_player(p: Dictionary) -> String:
	var best := ""
	var best_d: float = p["range"]
	for id in state["units"]:
		var u: Dictionary = state["units"][id]
		if not u["alive"] or u["team"] == p["team"]:
			continue
		var d: float = _dist(p["x"], p["y"], u["x"], u["y"])
		if d <= best_d:
			best = id
			best_d = d
	for sid in state["structures"]:
		var s: Dictionary = state["structures"][sid]
		if not s["alive"] or s["team"] == p["team"]:
			continue
		var d: float = _dist(p["x"], p["y"], s["x"], s["y"])
		if d <= best_d:
			best = sid
			best_d = d
	return best


func _process_events(events: Array) -> void:
	for e in events:
		match e.get("type", ""):
			"death":
				var unit: Dictionary = state["units"].get(e["unit"], {})
				if unit.get("team", "") == "blue":
					state["score"]["red"] += 1
				else:
					state["score"]["blue"] += 1
				if e.get("killer_team", "") != "":
					var reason := "kill" if unit.get("is_champion", false) else "minion"
					economy.reward(state, e["killer_team"], reason)
			"structure_destroyed":
				var is_core: bool = state["structures"].get(e["structure"], {}).get("is_core", false)
				if e.get("team", "") != "":
					economy.reward(state, e["team"], "core" if is_core else "tower")
			"neutral_captured":
				economy.reward(state, e["owner"], "neutral")
			"match_resolved":
				state["phase"] = "victory" if e["winner"] == "blue" else "defeat"


# ---------------------------------------------------------------------------
# Command path (shared by live input and replay)
# ---------------------------------------------------------------------------
func _handle_command(command: Dictionary) -> void:
	match command.get("type", ""):
		"start":
			if state["phase"] == "title":
				_begin_match()
		"move":
			_input_dir = command.get("dir", Vector2.ZERO)
		"move_key":
			_set_move_key(command.get("key", ""), command.get("down", true))
		"click":
			_click_at(command.get("x", 0.0), command.get("y", 0.0))
		"ability_q":
			if state["phase"] == "playing":
				var p: Dictionary = state["units"].get("player", {})
				if not p.is_empty() and p["alive"]:
					combat.issue_action(state, "player", {"type": "ability_q", "target": p.get("target", "")})
		"ability_e":
			if state["phase"] == "playing":
				var p2: Dictionary = state["units"].get("player", {})
				if not p2.is_empty() and p2["alive"]:
					combat.issue_action(state, "player", {"type": "ability_e", "target": p2.get("target", "")})
		"upgrade":
			if state["phase"] == "playing":
				economy.purchase(state, command.get("actor", "player"), command.get("upgrade", ""))
		"pause":
			if state["phase"] == "playing":
				state["phase"] = "paused"
			elif state["phase"] == "paused":
				state["phase"] = "playing"
		"help":
			_show_help = not _show_help
		"resume_after_result":
			pass


func _on_hud_command(command: Dictionary) -> void:
	_handle_command(command)


func _set_move_key(key: String, down: bool) -> void:
	var val := 1.0 if down else 0.0
	match key:
		"W", "UP": _input_dir.y = -val
		"S", "DOWN": _input_dir.y = val
		"A", "LEFT": _input_dir.x = -val
		"D", "RIGHT": _input_dir.x = val


func _click_at(x: float, y: float) -> void:
	var p: Dictionary = state["units"].get("player", {})
	if p.is_empty():
		return
	# Select nearest unit/structure under cursor.
	var best := ""
	var best_d := 50.0
	for id in state["units"]:
		var u: Dictionary = state["units"][id]
		if not u["alive"]:
			continue
		var d: float = _dist(x, y, u["x"], u["y"])
		if d <= best_d:
			best = id
			best_d = d
	if best != "" and state["units"][best]["team"] != p["team"]:
		p["target"] = best
		p["move_to"] = Vector2.ZERO
	else:
		p["target"] = ""
		p["move_to"] = Vector2(x, y)


# ---------------------------------------------------------------------------
# Live input
# ---------------------------------------------------------------------------
func _unhandled_input(event: InputEvent) -> void:
	if event is InputEventKey:
		var e := event as InputEventKey
		var code := OS.get_keycode_string(e.keycode).to_upper()
		if e.pressed:
			_dispatch_key(code, true)
		else:
			_dispatch_key(code, false)
	elif event is InputEventMouseButton:
		var mb := event as InputEventMouseButton
		if mb.pressed and mb.button_index == MOUSE_BUTTON_LEFT:
			_handle_command({"type": "click", "x": mb.position.x, "y": mb.position.y})
	elif event is InputEventMouseMotion:
		_cursor = (event as InputEventMouseMotion).position


func _dispatch_key(code: String, down: bool) -> void:
	match code:
		"W", "UP", "S", "DOWN", "A", "LEFT", "D", "RIGHT":
			_handle_command({"type": "move_key", "key": code, "down": down})
		"Q":
			if down: _handle_command({"type": "ability_q"})
		"E":
			if down: _handle_command({"type": "ability_e"})
		"1":
			if down: _handle_command({"type": "upgrade", "upgrade": "power"})
		"2":
			if down: _handle_command({"type": "upgrade", "upgrade": "vitality"})
		"3":
			if down: _handle_command({"type": "upgrade", "upgrade": "haste"})
		"ENTER", "SPACE":
			if down: _handle_command({"type": "start"})
		"P", "ESCAPE":
			if down: _handle_command({"type": "pause"})
		"H":
			if down: _handle_command({"type": "help"})


# ---------------------------------------------------------------------------
# Replay runner
# ---------------------------------------------------------------------------
func _run_all_replays() -> void:
	var dir := "res://demo_outputs/"
	var paths: Array = []
	var d := DirAccess.open(dir)
	if d != null:
		d.list_dir_begin()
		var fname := d.get_next()
		while fname != "":
			if fname.ends_with(".json"):
				paths.append(dir + fname)
			fname = d.get_next()
	paths.sort()
	print("[REPLAY] found traces: ", paths)
	var all_ok := true
	var covered_all: Dictionary = {}
	var any_change := false
	for path in paths:
		var result := _run_one_replay(path)
		if not result["ok"]:
			all_ok = false
		if result["state_changes"] > 0:
			any_change = true
		for s in result["covered"]:
			covered_all[s] = true
	var all_six := covered_all.size() >= 6
	print("[REPLAY] ALL_OK=", all_ok, " ANY_CHANGE=", any_change, " ALL_SIX=", all_six, " covered=", JSON.stringify(covered_all.keys()))
	_replay_done = true
	get_tree().quit(0 if (all_ok and any_change and all_six) else 1)


func _run_one_replay(path: String) -> Dictionary:
	var res := replay.load_trace(path)
	if not res["accepted"]:
		print("[REPLAY] load failed ", path, " -> ", res)
		return {"ok": false}
	_build_state()  # fresh authoritative state (starts at title)
	_apply_scenario(str(trace_scenario(res)))
	_refresh_hud()
	var duration: int = int(res["duration_frames"])
	duration = clampi(duration, 1, 600)
	var ok := true
	var scen := trace_scenario(res)
	for f in range(duration):
		state["frame"] = f
		var before := _snapshot()
		for e in replay.events_for_frame(f):
			_dispatch_trace_event(e)
		if state["phase"] in ["playing"]:
			_tick(FIXED_DELTA)
		elif state["phase"] in ["title", "paused"]:
			pass
		# victory/defeat: freeze
		var after := _snapshot()
		replay.record_state_change(before, after)
		replay.current_frame = f + 1
		_refresh_hud()
	var report := replay.coverage_report()
	var covered: Array = report["systems"]
	if report["state_changes"] <= 0:
		ok = false
	if scen in ["core", "neutral", "structures"]:
		var rt: Array = []
		for t in ["red_tower_0", "red_tower_1", "red_tower_2"]:
			rt.append(state["structures"][t]["alive"])
		print("[VERIFY] ", scen, " phase=", state["phase"], " neutral=", state["neutral"]["owner"],
			" buff=", state["neutral"]["buff_team"], " red_towers=", rt,
			" red_core_hp=", int(state["structures"]["red_core"]["hp"]))
	print("[REPLAY] trace=", path, " ", JSON.stringify(report))
	if report["state_changes"] <= 0:
		print("[REPLAY] WARNING: no state changes recorded")
	return {"ok": ok, "state_changes": report["state_changes"], "covered": covered}


func trace_scenario(res: Dictionary) -> String:
	return str(replay.trace.get("scenario", ""))


## Named scenarios may establish a deterministic starting state; the replayed
## input still drives the exact same production logic as normal play.
func _apply_scenario(scenario: String) -> void:
	match scenario:
		"core":
			for t in ["red_tower_0", "red_tower_1", "red_tower_2"]:
				state["structures"][t]["alive"] = false
				state["structures"][t]["hp"] = 0.0
			state["structures"]["red_core"]["hp"] = 100.0
			for id in state["units"]:
				var u: Dictionary = state["units"][id]
				if u["team"] == "blue":
					u["x"] = 1140
					u["y"] = 300
				else:
					u["x"] = 1220
					u["y"] = 430
			_spawn_initial_minions()
		"structures":
			for t in ["red_tower_0", "red_tower_1", "red_tower_2"]:
				state["structures"][t]["hp"] = 80.0
			# Move blue allies next to the red mid tower to take it down.
			state["units"]["ally"]["x"] = 900.0
			state["units"]["ally"]["y"] = 360.0
			# Pull enemy champions away so they don't contest the push.
			state["units"]["enemy1"]["x"] = 1180.0
			state["units"]["enemy1"]["y"] = 120.0
			state["units"]["enemy2"]["x"] = 1180.0
			state["units"]["enemy2"]["y"] = 640.0
			# Reinforce blue with several minions parked near the red towers.
			var before := _minion_counter
			for lane in range(3):
				for k in range(3):
					_minion("blue", lane)
			var after := _minion_counter
			var placed := 0
			for sid in state["units"]:
				var u: Dictionary = state["units"][sid]
				if not sid.begins_with("minion_blue"):
					continue
				if placed < after - before:
					var lane: int = u["lane"]
					u["x"] = 870.0 + lane * 60.0
					u["y"] = state["lanes"][lane][0].y
					placed += 1
		"neutral":
			state["spawn_red_initial"] = false
			state["wave_interval"] = 100000
			state["units"]["ally"]["x"] = 660.0
			state["units"]["ally"]["y"] = 360.0
			state["units"]["player"]["x"] = 620.0
			state["units"]["player"]["y"] = 360.0
			# Keep red champions at their base so blue can secure the beacon.
			state["units"]["enemy1"]["x"] = 1260.0
			state["units"]["enemy1"]["y"] = 200.0
			state["units"]["enemy2"]["x"] = 1260.0
			state["units"]["enemy2"]["y"] = 520.0
		"economy":
			state["teams"]["blue"]["gold"] = 420
		"combat", "ai", "hud", "title", "result":
			pass


func _dispatch_trace_event(e: Dictionary) -> void:
	var type: String = e.get("type", "")
	var key: String = str(e.get("keycode", "")).to_upper()
	match type:
		"wait":
			return
		"key_press", "key_down":
			_dispatch_key(key, true)
		"key_up":
			_dispatch_key(key, false)
		"mouse_click", "mouse_down":
			_handle_command({"type": "click", "x": e.get("x", 0.0), "y": e.get("y", 0.0)})
		"mouse_up":
			return
		"mouse_move":
			_cursor = Vector2(e.get("x", 0.0), e.get("y", 0.0))


func _snapshot() -> Dictionary:
	var alive := 0
	var fighting := 0
	var hp_sum := 0.0
	for id in state["units"]:
		var u: Dictionary = state["units"][id]
		if u["alive"]:
			alive += 1
			hp_sum += int(u["hp"])
		if u.get("state", "") == "fight":
			fighting += 1
	var struct_list: Array = []
	for sid in state["structures"]:
		var s: Dictionary = state["structures"][sid]
		struct_list.append(int(s["hp"]))
	var p: Dictionary = state["units"].get("player", {})
	var p_cd: float = 0.0
	if not p.is_empty():
		p_cd = roundf(p.get("q_cd", 0.0) * 100.0)
	var n: Dictionary = state["neutral"]
	return {
		"frame": state["frame"],
		"hp": int(hp_sum), "alive": alive,
		"proj": state["projectiles"].size(),
		"cd": int(p_cd),
		"ai_state": fighting,
		"gold": state["teams"]["blue"]["gold"],
		"upgrades": state["upgrades"].get("player", {}).size(),
		"structures": struct_list,
		"neutral": str(n["owner"]) + ":" + str(n["buff_team"]),
		"match_phase": state["phase"],
		"score": state["score"]["blue"] * 100 + state["score"]["red"],
		"hud": state["phase"] + ":" + str(state["frame"]),
	}


# ---------------------------------------------------------------------------
# HUD
# ---------------------------------------------------------------------------
func _refresh_hud() -> void:
	if hud != null:
		hud.project_authoritative_state(state)


func _dist(x1: float, y1: float, x2: float, y2: float) -> float:
	var dx := x1 - x2
	var dy := y1 - y2
	return sqrt(dx * dx + dy * dy)


# ---------------------------------------------------------------------------
# World drawing
# ---------------------------------------------------------------------------
func _draw() -> void:
	draw_rect(Rect2(0, 0, VIEW_W, VIEW_H), Color(0.08, 0.1, 0.14))
	if state.is_empty():
		return
	if state["phase"] == "title":
		_draw_title()
		return
	_draw_world()
	_draw_overlays()


func _draw_title() -> void:
	draw_rect(Rect2(0, 0, VIEW_W, VIEW_H), Color(0.06, 0.08, 0.13))
	var cx := VIEW_W / 2.0
	draw_string(ThemeDB.fallback_font, Vector2(cx - 240, 220), "TRI-LANE CITADEL",
		HORIZONTAL_ALIGNMENT_LEFT, -1, 52, Color(0.9, 0.92, 1.0))
	draw_string(ThemeDB.fallback_font, Vector2(cx - 200, 280), "A top-down micro-MOBA",
		HORIZONTAL_ALIGNMENT_LEFT, -1, 24, Color(0.6, 0.7, 0.9))
	draw_string(ThemeDB.fallback_font, Vector2(cx - 260, 420), "Press ENTER / SPACE to start the match",
		HORIZONTAL_ALIGNMENT_LEFT, -1, 22, Color(1.0, 0.85, 0.4))
	draw_string(ThemeDB.fallback_font, Vector2(cx - 300, 470),
		"WASD move   Click enemy to attack   Q Strike   E Nova   1/2/3 upgrades   P pause",
		HORIZONTAL_ALIGNMENT_LEFT, -1, 16, Color(0.8, 0.8, 0.85))


func _draw_world() -> void:
	# Grid.
	for gx in range(0, 1280, 80):
		draw_line(Vector2(gx, 0), Vector2(gx, VIEW_H), Color(0.11, 0.13, 0.18), 1.0)
	for gy in range(0, 720, 80):
		draw_line(Vector2(0, gy), Vector2(1280, gy), Color(0.11, 0.13, 0.18), 1.0)
	# Lanes.
	for lane in state["lanes"]:
		for i in range(lane.size() - 1):
			draw_line(lane[i], lane[i + 1], Color(0.25, 0.27, 0.32), 3.0)
	# Neutral objective.
	var n: Dictionary = state["neutral"]
	var ncolor := Color(1.0, 0.8, 0.3) if n["owner"] != "none" else Color(0.7, 0.55, 0.2)
	draw_circle(Vector2(n["x"], n["y"]), 26.0, Color(0.9, 0.75, 0.2, 0.35))
	draw_circle(Vector2(n["x"], n["y"]), 22.0, ncolor)
	if n["buff_team"] != "":
		var bt: String = n["buff_team"]
		draw_circle(Vector2(n["x"], n["y"]), 30.0, Color(1, 0.9, 0.3, 0.5) if bt == "blue" else Color(1, 0.4, 0.3, 0.5))
	draw_string(ThemeDB.fallback_font, Vector2(n["x"] - 40, n["y"] + 44), "NEXUS", HORIZONTAL_ALIGNMENT_LEFT, -1, 12, Color(0.9, 0.8, 0.4))
	# Structures.
	for sid in state["structures"]:
		var s: Dictionary = state["structures"][sid]
		if not s["alive"]:
			draw_circle(Vector2(s["x"], s["y"]), 16.0, Color(0.25, 0.25, 0.28))
			continue
		var col := Color(0.3, 0.6, 1.0) if s["team"] == "blue" else Color(1.0, 0.35, 0.25)
		var sz: float = 22.0 if s["is_core"] else 15.0
		var rect := Rect2(s["x"] - sz, s["y"] - sz, sz * 2, sz * 2)
		draw_rect(rect, col)
		draw_rect(rect, Color(0.05, 0.05, 0.08), false, 2.0)
		_draw_mini_bar(s["x"] - 16, s["y"] - sz - 8, 32.0, s["hp"] / s["max_hp"], col)
	# Units.
	for id in state["units"]:
		var u: Dictionary = state["units"][id]
		if not u["alive"]:
			continue
		var col := Color(0.3, 0.6, 1.0) if u["team"] == "blue" else Color(1.0, 0.35, 0.25)
		var r: float = 13.0 if u["is_champion"] else 9.0
		if u.get("is_player", false):
			col = Color(0.4, 0.8, 1.0)
			draw_circle(Vector2(u["x"], u["y"]), r + 5.0, Color(0.4, 0.8, 1.0, 0.3))
		elif u.get("is_champion", false):
			col = Color(0.5, 0.85, 1.0) if u["team"] == "blue" else Color(1.0, 0.55, 0.45)
		draw_circle(Vector2(u["x"], u["y"]), r, col)
		draw_circle(Vector2(u["x"], u["y"]), r, Color(0.05, 0.05, 0.08), false, 1.5)
		_draw_mini_bar(u["x"] - 12, u["y"] - r - 8, 24.0, u["hp"] / u["max_hp"], Color(0.4, 1.0, 0.4))
		# State label.
		var stl := "PUSH"
		if u["state"] == "fight":
			stl = "FIGHT"
		elif u["state"] == "retreat":
			stl = "RET"
		if u.get("is_champion", false):
			draw_string(ThemeDB.fallback_font, Vector2(u["x"] - 16, u["y"] - r - 12), stl, HORIZONTAL_ALIGNMENT_LEFT, -1, 9, Color(1, 1, 1))
		# Selected target ring.
		if state["units"].get("player", {}).get("target", "") == id:
			draw_arc(Vector2(u["x"], u["y"]), r + 6.0, 0, TAU, 24, Color(1.0, 1.0, 0.4), 2.0)
	# Projectiles.
	for p in state["projectiles"]:
		var pcol := Color(0.6, 0.9, 1.0) if p["team"] == "blue" else Color(1.0, 0.5, 0.4)
		draw_circle(Vector2(p["x"], p["y"]), 3.0, pcol)
	# Ability effects.
	for fx in state["effect_fx"]:
		if fx["type"] == "strike":
			draw_arc(Vector2(fx["x"], fx["y"]), 95.0 * clampf(fx["t"] / 0.3, 0.2, 1.0), 0, TAU, 40, Color(1.0, 0.9, 0.3, 0.8), 3.0)
		elif fx["type"] == "nova":
			draw_arc(Vector2(fx["x"], fx["y"]), 230.0 * clampf(fx["t"] / 0.4, 0.2, 1.0), 0, TAU, 64, Color(0.6, 0.4, 1.0, 0.7), 4.0)


func _draw_mini_bar(x: float, y: float, w: float, ratio: float, col: Color) -> void:
	draw_rect(Rect2(x, y, w, 5), Color(0.1, 0.1, 0.12))
	draw_rect(Rect2(x, y, w * clampf(ratio, 0.0, 1.0), 5), col)


func _draw_overlays() -> void:
	if _show_help:
		draw_rect(Rect2(0, 0, VIEW_W, VIEW_H), Color(0, 0, 0, 0.6))
		draw_string(ThemeDB.fallback_font, Vector2(120, 160), "HELP", HORIZONTAL_ALIGNMENT_LEFT, -1, 34, Color(1, 1, 1))
		draw_string(ThemeDB.fallback_font, Vector2(120, 210), "WASD/arrows move   Click enemy = attack target   Click ground = move", HORIZONTAL_ALIGNMENT_LEFT, -1, 16, Color(0.9, 0.9, 0.95))
		draw_string(ThemeDB.fallback_font, Vector2(120, 240), "Q = Strike (target nuke + splash)   E = Nova (large AoE)", HORIZONTAL_ALIGNMENT_LEFT, -1, 16, Color(0.9, 0.9, 0.95))
		draw_string(ThemeDB.fallback_font, Vector2(120, 270), "1/2/3 = buy Power / Vitality / Haste upgrades with gold", HORIZONTAL_ALIGNMENT_LEFT, -1, 16, Color(0.9, 0.9, 0.95))
		draw_string(ThemeDB.fallback_font, Vector2(120, 300), "Capture the Nexus Beacon in mid for a team damage buff.", HORIZONTAL_ALIGNMENT_LEFT, -1, 16, Color(0.9, 0.9, 0.95))
		draw_string(ThemeDB.fallback_font, Vector2(120, 330), "Destroy the enemy CORE to win. Protect your own.", HORIZONTAL_ALIGNMENT_LEFT, -1, 16, Color(0.9, 0.9, 0.95))
	if state["phase"] == "paused":
		draw_rect(Rect2(0, 0, VIEW_W, VIEW_H), Color(0, 0, 0, 0.55))
		draw_string(ThemeDB.fallback_font, Vector2(560, 360), "PAUSED", HORIZONTAL_ALIGNMENT_LEFT, -1, 40, Color(1, 1, 1))
		draw_string(ThemeDB.fallback_font, Vector2(520, 400), "Press P to resume", HORIZONTAL_ALIGNMENT_LEFT, -1, 18, Color(0.8, 0.8, 0.9))
	elif state["phase"] in ["victory", "defeat"]:
		draw_rect(Rect2(0, 0, VIEW_W, VIEW_H), Color(0, 0, 0, 0.6))
		var txt := "VICTORY" if state["phase"] == "victory" else "DEFEAT"
		var col := Color(0.4, 1.0, 0.5) if state["phase"] == "victory" else Color(1.0, 0.4, 0.35)
		draw_string(ThemeDB.fallback_font, Vector2(540, 360), txt, HORIZONTAL_ALIGNMENT_LEFT, -1, 44, col)
		draw_string(ThemeDB.fallback_font, Vector2(470, 410), "The CORE has been destroyed.", HORIZONTAL_ALIGNMENT_LEFT, -1, 18, Color(0.9, 0.9, 0.95))
