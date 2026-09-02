# Open-source game catalog

候选清单由 2026-09-02 的 GitHub 仓库检索建立。它服务于 Game Evolver 的接入，不代表已经完成构建验证。正式运行前固定 commit 并执行许可证、依赖和素材扫描。

## Recommended P0

| id | genre | engine | license | repository |
|---|---|---|---|---|
| godot-open-rpg | RPG | Godot 4 | MIT | https://github.com/gdquest-demos/godot-open-rpg |
| godot-tiny-mmo | MMO | Godot 4 | MIT | https://github.com/SlayHorizon/godot-tiny-mmo |
| godot-open-target-shooter | shooter | Godot 4 | MIT | https://github.com/teeeece/godot_open_target_shooter |
| tosios | shooter | Godot | MIT | https://github.com/halftheopposite/TOSIOS |
| visualnovelkit | visual-novel | Godot | MIT | https://github.com/rakugoteam/VisualNovelKit |
| renpy-template | visual-novel | Ren'Py | MIT | https://github.com/remarkablegames/renpy-template |
| biomes | MMO/web | TypeScript/WebGL/Node | MIT | https://github.com/ill-inc/biomes-game |
| kaetram-open | MMO/web | TypeScript/WebSocket | MPL-2.0 | https://github.com/Kaetram/Kaetram-Open |
| libre-trainsim | simulation | Godot | GPL-3.0 | https://github.com/Libre-TrainSim/Libre-TrainSim |

## Recommended P1

| id | genre | engine | license | repository |
|---|---|---|---|---|
| openra | RTS | C# custom engine | GPL-3.0 | https://github.com/OpenRA/OpenRA |
| veloren | sandbox MMO | Rust/wgpu | GPL-3.0 | https://github.com/veloren/veloren |
| mindustry | 4X/sandbox | Java | GPL-3.0 | https://github.com/Anuken/Mindustry |
| openttd | transport sim | C++/SDL | GPL-2.0 | https://github.com/OpenTTD/OpenTTD |
| openrct2 | theme-park sim | C++/SDL | GPL-3.0 | https://github.com/OpenRCT2/OpenRCT2 |
| widelands | city/logistics | C++/SDL | GPL-2.0 | https://github.com/widelands/widelands |
| luanti | survival/sandbox | C++/Lua | LGPL-2.1 | https://github.com/luanti-org/luanti |
| endless-sky | space sim | C++/SDL | GPL-3.0 | https://github.com/endless-sky/endless-sky |
| unciv | 4X strategy | Kotlin/LibGDX | MPL-2.0 | https://github.com/yairm210/Unciv |
| cataclysm-dda | survival/roguelike | C++/SDL | GPL-3.0 + CC BY-SA data | https://github.com/CleverRaven/Cataclysm-DDA |
| wesnoth | turn-based strategy | C++/SDL | GPL-2.0 | https://github.com/wesnoth/wesnoth |
| supertuxkart | racing | C++/SDL | GPL-3.0 | https://github.com/supertuxkart/stk-code |
| xonotic | FPS | DarkPlaces/OpenGL | GPL-2.0 | https://github.com/xonotic/xonotic |
| openmw | RPG | C++/OpenSceneGraph | GPL-3.0 | https://github.com/OpenMW/openmw |

## Adapter contract

An adapter should expose `discover`, `build`, `run_headless`, `capture`, `collect_trace`, and `apply_patch` operations. Store a lockfile with repository URL, commit SHA, engine version, build command, run command, asset-license report, and smoke-test result. Do not put a project into the evolution benchmark until `build` and `run_headless` are reproducible in a clean checkout.
