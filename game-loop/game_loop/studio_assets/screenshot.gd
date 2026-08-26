extends SceneTree

const DEFAULT_FRAMES := 100


func _initialize() -> void:
	var args := _parse_args(OS.get_cmdline_user_args())
	var out_path: String = args.get("out", "")
	var scene_path: String = ProjectSettings.get_setting("application/run/main_scene", "")
	if out_path.is_empty() or scene_path.is_empty():
		quit(2)
		return
	var packed: PackedScene = load(scene_path)
	if packed == null:
		quit(3)
		return
	root.add_child(packed.instantiate())
	for _frame in range(int(args.get("frames", DEFAULT_FRAMES))):
		await process_frame
	var image := root.get_viewport().get_texture().get_image()
	if image == null or image.save_png(out_path) != OK:
		quit(4)
		return
	quit(0)


func _parse_args(argv: PackedStringArray) -> Dictionary:
	var result := {}
	var index := 0
	while index < argv.size():
		var token: String = argv[index]
		if token.begins_with("--") and index + 1 < argv.size():
			result[token.substr(2)] = argv[index + 1]
			index += 2
		else:
			index += 1
	return result
