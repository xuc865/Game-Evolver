class_name HUDSystem
extends Control

signal command_requested(command: Dictionary)

var projected_state: Dictionary = {}


func project_authoritative_state(state: Dictionary) -> void:
	projected_state = state.duplicate(true)
	queue_redraw()


func handle_pointer(_position: Vector2, _pressed: bool) -> bool:
	return false


func _draw() -> void:
	pass
