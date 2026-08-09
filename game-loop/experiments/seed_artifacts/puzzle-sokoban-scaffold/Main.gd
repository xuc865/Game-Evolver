extends Node2D

func _ready() -> void:
	var label := Label.new()
	label.text = "Sokoban Dungeon (scaffold)\nPress Enter or click to continue"
	label.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
	label.vertical_alignment = VERTICAL_ALIGNMENT_CENTER
	label.set_anchors_preset(Control.PRESET_FULL_RECT)
	label.add_theme_font_size_override("font_size", 28)
	add_child(label)

func _input(event: InputEvent) -> void:
	if event.is_action_pressed("ui_accept") or (
		event is InputEventMouseButton and event.pressed and event.button_index == MOUSE_BUTTON_LEFT
	):
		get_tree().quit()
