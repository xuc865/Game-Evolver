extends SceneTree

const MODULES := {
	"combat": {"path": "res://scripts/combat_system.gd", "method": "contract_status_effects"},
	"ai": {"path": "res://scripts/ai_system.gd", "method": "contract_team_strategy"},
	"economy": {"path": "res://scripts/economy_system.gd", "method": "contract_build_recipes"},
	"objectives": {"path": "res://scripts/objective_system.gd", "method": "contract_map_objectives"},
	"hud": {"path": "res://scripts/hud_system.gd", "method": "contract_tactical_projection"},
	"replay": {"path": "res://scripts/replay_system.gd", "method": "contract_replay_integrity"},
}


func _initialize() -> void:
	var args := OS.get_cmdline_user_args()
	var index := args.find("--module")
	if index == -1 or index + 1 >= args.size():
		_fail("usage: --module <combat|ai|economy|objectives|hud|replay>")
		return
	var module_id := str(args[index + 1])
	if not MODULES.has(module_id):
		_fail("unknown module: " + module_id)
		return
	var contract: Dictionary = MODULES[module_id]
	var script := load(str(contract["path"]))
	if script == null:
		_fail("module does not parse: " + str(contract["path"]))
		return
	var instance: Object = script.new()
	var method := str(contract["method"])
	if not instance.has_method(method):
		_fail("missing contract method: " + method)
		return
	var payload: Variant = instance.call(method)
	if not payload is Dictionary:
		_fail("contract method must return Dictionary")
		return
	var result: Dictionary = payload
	if str(result.get("contract", "")) != module_id:
		_fail("contract id mismatch")
		return
	if int(result.get("version", 0)) != 2:
		_fail("contract version must be 2")
		return
	var capabilities: Variant = result.get("capabilities", [])
	if not capabilities is Array or capabilities.size() < 3:
		_fail("contract must disclose at least three capabilities")
		return
	var checks: Variant = result.get("local_checks", [])
	if not checks is Array or checks.is_empty():
		_fail("contract must disclose at least one local check")
		return
	print(JSON.stringify({"ok": true, "module": module_id, "contract": result}))
	quit(0)


func _fail(message: String) -> void:
	printerr(JSON.stringify({"ok": false, "error": message}))
	quit(2)
