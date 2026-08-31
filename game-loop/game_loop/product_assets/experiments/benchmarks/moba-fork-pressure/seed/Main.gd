extends Node2D

const COMBAT_SYSTEM = preload("res://scripts/combat_system.gd")
const AI_SYSTEM = preload("res://scripts/ai_system.gd")
const ECONOMY_SYSTEM = preload("res://scripts/economy_system.gd")
const OBJECTIVE_SYSTEM = preload("res://scripts/objective_system.gd")
const HUD_SYSTEM = preload("res://scripts/hud_system.gd")
const REPLAY_SYSTEM = preload("res://scripts/replay_system.gd")

const REQUIRED_SYSTEMS := [
	"combat", "ai", "economy", "objectives", "hud", "replay",
]


func _ready() -> void:
	var label := Label.new()
	label.text = "Tri-Lane Citadel\nIntegrated systems scaffold\nImplement all six modules"
	label.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
	label.vertical_alignment = VERTICAL_ALIGNMENT_CENTER
	label.set_anchors_preset(Control.PRESET_FULL_RECT)
	label.add_theme_font_size_override("font_size", 32)
	add_child(label)
	print("[SCAFFOLD] required_systems=", REQUIRED_SYSTEMS)
