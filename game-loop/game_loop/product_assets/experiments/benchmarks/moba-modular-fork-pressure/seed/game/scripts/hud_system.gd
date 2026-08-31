class_name HUDSystem
extends Control

signal command_requested(command: Dictionary)

## The HUD projects the authoritative game state every frame and renders the
## full tactical picture: phase, score, health, gold, ability cooldowns,
## upgrade shop, structure health and neutral objective ownership. It also
## turns pointer clicks on the shop into upgrade commands.

var projected_state: Dictionary = {}
var _shop_buttons: Array = []


func project_authoritative_state(state: Dictionary) -> void:
	projected_state = state.duplicate(true)
	queue_redraw()


func handle_pointer(position: Vector2, pressed: bool) -> bool:
	if not pressed or not projected_state.has("phase"):
		return false
	for b in _shop_buttons:
		var rect := Rect2(b["rect"])
		if rect.has_point(position):
			var up: String = b["id"]
			var player: Dictionary = projected_state["units"].get("player", {})
			if player.is_empty():
				return true
			command_requested.emit({"type": "upgrade", "upgrade": up, "actor": "player"})
			return true
	return false


func _draw() -> void:
	var st: Dictionary = projected_state
	if st.is_empty():
		return
	var w: float = size.x
	var h: float = size.y
	_draw_top_bar(st, w)
	_draw_player_panel(st, w, h)
	_draw_objective(st, w)


func _draw_top_bar(st: Dictionary, w: float) -> void:
	var phase: String = st.get("phase", "title")
	# Backdrop band.
	draw_rect(Rect2(0, 0, w, 40), Color(0.05, 0.07, 0.12, 0.92))
	var title := "TRI-LANE CITADEL"
	draw_string(ThemeDB.fallback_font, Vector2(14, 26), title,
		HORIZONTAL_ALIGNMENT_LEFT, -1, 18, Color(0.9, 0.92, 1.0))
	var phase_txt := "MATCH: " + str(phase).to_upper()
	draw_string(ThemeDB.fallback_font, Vector2(260, 26), phase_txt,
		HORIZONTAL_ALIGNMENT_LEFT, -1, 15, Color(1.0, 0.85, 0.4))
	# Score.
	if st.has("score"):
		var s: Dictionary = st["score"]
		var score_txt := "%s  %d : %d  %s" % [tr("SCORE"), s.get("blue", 0), s.get("red", 0), tr("")]
		draw_string(ThemeDB.fallback_font, Vector2(w / 2 - 80, 26), str(s.get("blue", 0)),
			HORIZONTAL_ALIGNMENT_LEFT, -1, 18, Color(0.3, 0.6, 1.0))
		draw_string(ThemeDB.fallback_font, Vector2(w / 2, 26), ":", HORIZONTAL_ALIGNMENT_LEFT, -1, 18, Color(1, 1, 1))
		draw_string(ThemeDB.fallback_font, Vector2(w / 2 + 24, 26), str(s.get("red", 0)),
			HORIZONTAL_ALIGNMENT_LEFT, -1, 18, Color(1.0, 0.35, 0.25))
	# Help / pause hint.
	draw_string(ThemeDB.fallback_font, Vector2(w - 150, 26), "P:pause  H:help  Q/E:abil", HORIZONTAL_ALIGNMENT_LEFT, -1, 13, Color(0.6, 0.65, 0.75))


func _draw_objective(st: Dictionary, w: float) -> void:
	if not st.has("neutral"):
		return
	var n: Dictionary = st["neutral"]
	var owner: String = n.get("owner", "none")
	var txt := "NEXUS BEACON: %s" % owner.to_upper()
	if n.get("buff_team", "") != "":
		txt += "  BUFF→%s (%ds)" % [n["buff_team"].to_upper(), int(n.get("buff_t", 0.0))]
	draw_string(ThemeDB.fallback_font, Vector2(w - 300, 66), txt, HORIZONTAL_ALIGNMENT_LEFT, -1, 14,
		Color(1.0, 0.85, 0.5) if owner != "none" else Color(0.7, 0.7, 0.7))
	# Neutral capture progress bar.
	draw_rect(Rect2(w - 300, 72, 280, 6), Color(0.2, 0.2, 0.25))
	var prog: float = n.get("progress", 0.0) / maxf(n.get("capture_time", 1.0), 1.0)
	draw_rect(Rect2(w - 300, 72, 280 * clampf(prog, 0.0, 1.0), 6), Color(1.0, 0.8, 0.3))


func _draw_player_panel(st: Dictionary, w: float, h: float) -> void:
	var player: Dictionary = st["units"].get("player", {})
	if player.is_empty():
		return
	var team: String = player["team"]
	# Bottom health / resource panel.
	var panel_h := 96.0
	draw_rect(Rect2(0, h - panel_h, w, panel_h), Color(0.04, 0.06, 0.1, 0.92))
	var hp_ratio: float = clampf(player["hp"] / player["max_hp"], 0.0, 1.0)
	var bar_w := 320.0
	draw_string(ThemeDB.fallback_font, Vector2(14, h - 78), "HEALTH", HORIZONTAL_ALIGNMENT_LEFT, -1, 13, Color(0.8, 0.8, 0.9))
	draw_rect(Rect2(14, h - 70, bar_w, 14), Color(0.15, 0.15, 0.2))
	draw_rect(Rect2(14, h - 70, bar_w * hp_ratio, 14), Color(0.3, 0.8, 0.35))
	draw_string(ThemeDB.fallback_font, Vector2(18, h - 58), "%d / %d" % [int(player["hp"]), int(player["max_hp"])], HORIZONTAL_ALIGNMENT_LEFT, -1, 12, Color(1, 1, 1))
	# Ability cooldowns.
	var q_ratio: float = clampf(1.0 - player.get("q_cd", 0.0) / maxf(player.get("q_cd_max", 1.0), 0.001), 0.0, 1.0)
	var e_ratio: float = clampf(1.0 - player.get("e_cd", 0.0) / maxf(player.get("e_cd_max", 1.0), 0.001), 0.0, 1.0)
	_draw_ability_box(Vector2(14, h - 48), "Q", "STRIKE", q_ratio)
	_draw_ability_box(Vector2(74, h - 48), "E", "NOVA", e_ratio)
	# Gold / resources.
	var gold: int = st["teams"][team]["gold"]
	draw_string(ThemeDB.fallback_font, Vector2(150, h - 70), "GOLD %d" % gold, HORIZONTAL_ALIGNMENT_LEFT, -1, 16, Color(1.0, 0.9, 0.3))
	# Shop buttons.
	_draw_shop(st, w, h, team, gold)


func _draw_ability_box(pos: Vector2, key: String, label: String, ready: float) -> void:
	draw_rect(Rect2(pos.x, pos.y, 52, 38), Color(0.1, 0.12, 0.2, 0.95))
	draw_rect(Rect2(pos.x, pos.y + 38 * (1.0 - ready), 52, 38 * ready), Color(0.3, 0.6, 1.0, 0.55))
	draw_string(ThemeDB.fallback_font, pos + Vector2(6, 24), key, HORIZONTAL_ALIGNMENT_LEFT, -1, 16, Color(1, 1, 1))
	draw_string(ThemeDB.fallback_font, pos + Vector2(20, 24), label.substr(0, 1), HORIZONTAL_ALIGNMENT_LEFT, -1, 12, Color(1, 1, 1))


func _draw_shop(st: Dictionary, w: float, h: float, team: String, gold: int) -> void:
	var labels := [
		{"id": "power", "key": "1", "label": "Power"},
		{"id": "vitality", "key": "2", "label": "Vital"},
		{"id": "haste", "key": "3", "label": "Haste"},
	]
	var costs := {"power": 100, "vitality": 100, "haste": 120}
	_shop_buttons = []
	var x0 := w - 360.0
	for i in range(labels.size()):
		var info: Dictionary = labels[i]
		var rect := Rect2(x0 + i * 118, h - 84, 110, 60)
		_shop_buttons.append({"id": info["id"], "rect": rect})
		var cost: int = costs[info["id"]]
		var afford: bool = gold >= cost
		draw_rect(rect, Color(0.12, 0.2, 0.3, 0.95))
		draw_rect(rect, Color(0.4, 0.8, 1.0) if afford else Color(0.35, 0.35, 0.4), false, 1.5)
		draw_string(ThemeDB.fallback_font, rect.position + Vector2(8, 20), "[%s] %s" % [info["key"], info["label"]], HORIZONTAL_ALIGNMENT_LEFT, -1, 13, Color(1, 1, 1))
		draw_string(ThemeDB.fallback_font, rect.position + Vector2(8, 40), "%d gold" % cost, HORIZONTAL_ALIGNMENT_LEFT, -1, 12,
			Color(1.0, 0.9, 0.3) if afford else Color(0.8, 0.3, 0.3))
		var owned: int = st["upgrades"].get("player", {}).get(info["id"], 0)
		if owned > 0:
			draw_string(ThemeDB.fallback_font, rect.position + Vector2(8, 56), "x%d" % owned, HORIZONTAL_ALIGNMENT_LEFT, -1, 11, Color(0.5, 1.0, 0.5))
