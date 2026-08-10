# awesome-gamedev-agent-skills

This is a pinned comparison baseline. Load only the relevant skill file from the configured skills root before applying its guidance.

## router
Routes any game-development request to the right specialized skill(s): it detects the engine (Godot, Unity, Unreal, Bevy, Phaser, PixiJS, three.js, LÖVE, pygame, Roblox) and the task, then reads the chosen skill before acting. Use to make a game or to decide which skill applies — for players, levels, enemies, shaders, art direction, sprites, tiles, textures, 3D assets, UI/UX, cameras, game feel, physics, input, audio, saving, multiplayer, AI, dialogue, procedural generation, or performance, for genres (platformer, roguelike, RPG, FPS, tower-defense, card game, visual novel, survival-crafting, puzzle), and for shipping (game jam, Steam, itch). Start here when unsure which gamedev skill to use.
path: router/SKILL.md

## audio-design
Implement game audio practice — bus/mixer architecture and gain in decibels, ducking (sidechain), adaptive/dynamic music via layering and re-sequencing, SFX variation, and beat synchronization. Engine-neutral. Use when the user mentions audio mixing, audio buses, adaptive/dynamic music, ducking, SFX variation, music layers, or syncing gameplay to the beat.
path: skills/disciplines/audio-design/SKILL.md

## camera-systems
Build game cameras that feel good — 2D follow with a deadzone, look-ahead, smoothing, and level-bounds clamping; 3D third-person orbit with collision and first-person look; plus multi-target framing and a shake hook. Engine-neutral techniques that pair with the engine's camera node and rigs like Unity Cinemachine or Godot Camera2D/PhantomCamera. Use when the user mentions camera follow, follow camera, deadzone, look-ahead, camera smoothing, camera bounds/ limits, third-person camera, orbit camera, first-person look, Cinemachine, or camera jitter.
path: skills/disciplines/camera-systems/SKILL.md

## create-game-assets
Plan, generate, source, normalize, and validate cohesive visual game assets. Use for art direction, style bibles, sprites, tilesets, backgrounds, UI art, icons, textures, concept art, or 3D asset briefs.
path: skills/disciplines/create-game-assets/SKILL.md

## dialogue-systems
Build branching dialogue and narrative — a node/choice graph with conditions, variables, and localization hooks — and choose between authoring tools Ink and Yarn Spinner or a custom data-driven runner. Engine-neutral. Use when the user mentions dialogue system, branching dialogue, conversation tree, choices, Ink (.ink), Yarn Spinner (.yarn), or NPC dialogue.
path: skills/disciplines/dialogue-systems/SKILL.md

## game-ai
Design NPC and enemy decision-making with finite state machines, behavior trees, steering behaviors, and A* pathfinding — engine-neutral algorithms that pair with the detected engine's navigation API. Use when building enemy AI, an FSM or behavior tree, steering/flocking, or pathfinding, or when the user mentions state machine, behavior tree, blackboard, A*, navmesh, seek, or patrol/chase.
path: skills/disciplines/game-ai/SKILL.md

## game-feel
Add "juice" and game feel that makes actions satisfying — screen shake, hit-stop/freeze frames, tweened/eased motion, squash & stretch, knockback, and layered audio-visual feedback — as engine-neutral techniques that pair with the detected engine's tween, particle, and camera APIs. Use when the user mentions game feel, juice, "make it feel good/punchy", screen shake, hit stop, screen freeze, easing, squash and stretch, impact frames, or feedback/polish on hits, jumps, pickups, and deaths.
path: skills/disciplines/game-feel/SKILL.md

## game-ui-ux
Design and build game UI/UX — HUDs, menus, and overlays — that survive every screen: anchor- based responsive layout, resolution/aspect scaling and safe areas, keyboard/gamepad focus navigation, a screen/menu state stack, and event-driven (not polled) HUD updates. Engine- neutral patterns that pair with the detected engine's UI skill. Use when the user mentions HUD, health bar, main menu, pause menu, settings screen, UI layout, anchors, UI scaling, aspect ratio, safe area, controller/keyboard menu navigation, or wiring UI to game state.
path: skills/disciplines/game-ui-ux/SKILL.md

## input-systems
Architect game input — action mapping (abstracting keys into named actions), rebinding with conflict detection and persistence, multi-device support (keyboard, gamepad, touch), analog deadzones, and feel features like input buffering and coyote time, plus accessibility. Engine-neutral. Use when the user mentions input mapping, rebind controls, gamepad support, deadzone, input buffering, coyote time, or accessible controls.
path: skills/disciplines/input-systems/SKILL.md

## level-design
Design and build playable levels — the blockout/whitebox-to-playable workflow, player metrics and grid layout, pacing and flow (tension/rest curve), gating and the critical path, and encounter design. Engine-neutral practice. Use when the user mentions level design, blockout/whitebox/greybox, level layout, level pacing, encounter design, or the critical path through a level.
path: skills/disciplines/level-design/SKILL.md

## performance-optimization
Find and fix game performance problems methodically — measure with the engine profiler first, reason about the frame-time budget, locate the CPU-vs-GPU bottleneck, then apply the right fix: object pooling, draw-call batching, fewer allocations/GC spikes, and asset budgets. Engine- neutral method that pairs with each engine's profiler. Use when the user mentions performance, optimize, low/dropping FPS, frame drops, stutter, lag, profiler, frame budget, draw calls, batching, garbage collection/GC spikes, object pooling, or "the game runs slow".
path: skills/disciplines/performance-optimization/SKILL.md

## physics-tuning
Tune game physics for stable, good-feeling motion — fixed vs variable timestep, render interpolation, mass/gravity/drag, continuous collision detection (CCD) to stop tunneling, fixing jitter, and collision layers/masks. Engine-neutral. Use when the user mentions physics feel, jitter, tunneling, fixed timestep, FixedUpdate, CCD, bouncing/unstable physics, or collision layers.
path: skills/disciplines/physics-tuning/SKILL.md

## procedural-gen
Generate game content procedurally — seeded deterministic RNG, value/Perlin/ Simplex noise for terrain and heightmaps, grid dungeon generation (rooms + corridors, BSP, random walk), and weighted loot/drop tables. Engine-neutral algorithms. Use when the user mentions procedural generation, perlin/simplex noise, random seed, dungeon generator, heightmap/terrain, or loot tables.
path: skills/disciplines/procedural-gen/SKILL.md

## save-systems
Design save/load for game state — choosing what to serialize, file formats, save slots, atomic crash-safe writes, schema versioning and migration, and autosave. Engine-neutral. Use when the user mentions save system, save/load, game state persistence, save slots, autosave, save file corruption, or migrating old saves to a new version.
path: skills/disciplines/save-systems/SKILL.md

## shader-programming
Write game shaders from cross-engine fundamentals — the vertex→fragment pipeline, coordinate spaces, UV math, and common 2D/3D effects (tint, UV scroll, dissolve, outline, fresnel rim, vignette) in GLSL with HLSL equivalents. Use when the user mentions shaders, fragment/pixel shader, vertex shader, UV, GLSL, HLSL, or effects like dissolve, outline, or rim light.
path: skills/disciplines/shader-programming/SKILL.md

## card-game
Build a card game: card data, deck/hand/discard zones, draw/shuffle/reshuffle, a turn structure, costs, and effect resolution. Use for a deckbuilder, TCG/CCG, or roguelike deckbuilder.
path: skills/genres/card-game/SKILL.md

## fps-shooter
Build a first-person shooter: move+mouse-look controller, hitscan or projectile shooting, weapons, health, and enemy AI. Use for an FPS, or tuning aim feel, time-to-kill, recoil, or spread.
path: skills/genres/fps-shooter/SKILL.md

## platformer
Build a 2D platformer: run/jump control with coyote time, jump buffering, and variable jump height, plus tiled levels and hazards. Use for a platformer or Mario/Celeste-like, or tuning jump feel.
path: skills/genres/platformer/SKILL.md

## puzzle
Build a puzzle game: grid/board state, move input, rule-based resolution (match-3 cascades, sokoban pushes, tile logic), scoring, and undo. Use for a match-3, sokoban, or grid-logic puzzle.
path: skills/genres/puzzle/SKILL.md

## roguelike
Build a roguelike: turn-based grid movement, procedural dungeons, permadeath, field-of-view, and loot tables. Use for a roguelike/roguelite or turn-based grid dungeon crawler with procedural levels.
path: skills/genres/roguelike/SKILL.md

## rpg
Build an RPG: stats and leveling, inventory and equipment, quests, branching dialogue, save/load, and combat. Use for an RPG/JRPG, or designing stat, inventory, quest, or combat systems.
path: skills/genres/rpg/SKILL.md

## survival-crafting
Build a survival-crafting game: resource gathering, inventory, crafting and a tech tree, needs (hunger/thirst/temperature), and base building. Use for a survival or crafting/base-building game.
path: skills/genres/survival-crafting/SKILL.md

## tower-defense
Build a tower defense: enemies pathing along lanes, wave spawning, towers that auto-target and fire, an economy, and lives. Use for a tower-defense/wave-defense game, or balancing waves and economy.
path: skills/genres/tower-defense/SKILL.md

## visual-novel
Build a visual novel: a branching script, character and background display, a text box with choices, save/load, backlog, and skip/auto. Use for a VN, dating sim, or branching story game.
path: skills/genres/visual-novel/SKILL.md

## godot-2d-movement
Implement 2D kinematic character movement in Godot 4.7 with CharacterBody2D and move_and_slide(): platformer run/jump with gravity, top-down 8-direction motion, slope handling, and reading collisions. Use when coding a 2D player or enemy controller, a platformer or top-down character, or fixing move_and_slide()/ is_on_floor() behavior in a .tscn with a CharacterBody2D.
path: skills/godot/godot-2d-movement/SKILL.md

## godot-3d-essentials
Set up a Godot 4.7 3D scene: Node3D transforms, Camera3D, lighting (DirectionalLight3D/OmniLight3D), WorldEnvironment for sky/ambient/tonemap/post, MeshInstance3D materials, and GridMap for tile-based 3D levels. Use when building a 3D scene in a Godot project, placing cameras/lights, configuring environment and post-processing, or working with Node3D/.tscn 3D content and GridMap.
path: skills/godot/godot-3d-essentials/SKILL.md

## godot-animation
Animate in Godot 4.7 three ways: AnimationPlayer for keyframed clips (incl. call and signal tracks), AnimationTree with state machines and blend spaces for character animation, and Tween for short procedural/UI tweens via create_tween(). Use when working with AnimationPlayer/AnimationTree nodes in a .tscn, blending character states, sprite-sheet animation, or code-driven Tweens.
path: skills/godot/godot-animation/SKILL.md

## godot-audio
Play and mix audio in Godot 4.7: AudioStreamPlayer (2D/3D variants), audio buses with volume/mute and effects, music vs SFX routing, db/linear volume, and precise sync-to-beat playback timing. Use when playing sounds or music in a Godot project, routing AudioStreamPlayer nodes to buses, adjusting bus volume via AudioServer, or syncing gameplay to the beat.
path: skills/godot/godot-audio/SKILL.md

## godot-csharp
Use C#/.NET in Godot 4.7: partial classes extending nodes, the PascalCase lifecycle (_Ready/_Process/_PhysicsProcess), [Export] fields, [Signal] delegates as C# events, type-safe node lookup, and calling between C# and GDScript. Use when writing Godot game code in C# (.cs files, .csproj), needing the Godot .NET build, converting GDScript patterns to C#, or wiring Godot signals as C# events.
path: skills/godot/godot-csharp/SKILL.md

## godot-export
Export and build a Godot 4.7 project for distribution: install export templates, define export presets (Windows/macOS/Linux/Web/Android), run headless command-line exports for CI, and handle web (HTML5) COOP/COEP and dedicated-server/headless builds. Use when exporting a Godot game, configuring export_presets.cfg, building for web/desktop/mobile, or automating builds from the command line.
path: skills/godot/godot-export/SKILL.md

## godot-gdscript
Write idiomatic GDScript for Godot 4.7: static typing, the node lifecycle (_ready/_process/_physics_process), @export/@onready/@tool annotations, signals, and await for asynchronous flow. Use when editing .gd scripts in a Godot project (project.godot), writing or debugging GDScript, or porting 3.x GDScript to 4.x (function signatures, yield to await, export to @export).
path: skills/godot/godot-gdscript/SKILL.md

## godot-multiplayer
Build networked games with Godot 4.7 high-level multiplayer: set up an ENetMultiplayerPeer server/client, define RPCs with the @rpc annotation (call via rpc()/rpc_id()), set per-node multiplayer authority, and replicate state with MultiplayerSpawner and MultiplayerSynchronizer. Use when adding multiplayer/networking to a Godot project, writing @rpc functions, or syncing player/world state across peers.
path: skills/godot/godot-multiplayer/SKILL.md

## godot-nodes-scenes
Structure a Godot 4.7 project with the scene tree and node composition: build reusable scenes, instance PackedScenes at runtime, navigate the tree safely, and register autoload singletons. Use when designing .tscn scenes, deciding how to split nodes, spawning instances with instantiate(), wiring autoloads, or fixing "node not found"/freed-node errors in a Godot project.
path: skills/godot/godot-nodes-scenes/SKILL.md

## godot-physics
Use Godot 4.7 physics bodies and detection in 2D and 3D: RigidBody, StaticBody, Area, and CharacterBody; collision layers vs masks; contact/overlap signals; and raycasts (RayCast nodes and direct space-state queries). Use when configuring collision layers/masks, detecting overlaps with Area2D/Area3D, applying forces to a RigidBody, or casting rays in a Godot project (.tscn with physics bodies).
path: skills/godot/godot-physics/SKILL.md

## godot-resources
Design data-driven Godot 4.7 games with custom Resource classes: define typed data with class_name + @export, save/load .tres/.res files, instance and duplicate resources, and load on demand with ResourceLoader (incl. threaded loading). Use when modeling items/stats/configs as data in a Godot project, creating .tres resources, or working with custom Resource subclasses and ResourceLoader/ResourceSaver.
path: skills/godot/godot-resources/SKILL.md

## godot-shaders
Write Godot 4.7 shaders in the Godot Shading Language: canvas_item shaders for 2D and spatial shaders for 3D, with vertex/fragment functions, uniforms (source_color, hint_range), TIME/UV animation, and screen-reading via hint_screen_texture. Use when authoring .gdshader files, writing fragment/vertex code, making 2D/3D visual effects, or porting 3.x shaders (SCREEN_TEXTURE, hint_color) to 4.x.
path: skills/godot/godot-shaders/SKILL.md

## godot-signals-groups
Build event-driven, decoupled Godot 4.7 gameplay with signals and node groups: declare and emit custom signals, connect with Callables (incl. bind/one-shot), and broadcast to many nodes via groups and call_group. Use when wiring node communication in a Godot project, replacing tight references with signals, emitting/connecting events, or porting 3.x connect("sig", self, "method") code.
path: skills/godot/godot-signals-groups/SKILL.md

## godot-tilemap
Build and edit tile-based 2D levels in Godot 4.7 with TileMapLayer and TileSet: paint layers, set up collision/navigation/custom-data on tiles, autotile with terrain sets, and read/write cells from code (set_cell, get_cell_tile_data, local_to_map). Use when working with TileMapLayer nodes, .tres TileSets, autotiling, or migrating a deprecated TileMap node to TileMapLayer.
path: skills/godot/godot-tilemap/SKILL.md

## godot-ui-control
Build Godot 4.7 user interfaces with Control nodes: anchors and offsets for responsive layout, Container nodes (VBox/HBox/Grid/Margin) for automatic arrangement, Theme resources for consistent styling, and keyboard/gamepad focus navigation. Use when laying out a HUD, menu, or UI in a Godot project, working with Control/Container nodes, anchors, themes, or focus in a .tscn.
path: skills/godot/godot-ui-control/SKILL.md

## bevy-ecs
Structure a Bevy app around its Entity Component System: build the App with plugins, define Component/Resource types, write systems with Query/Res/Commands, filter and order systems, and use the Time resource for frame-rate-independent motion. Use when building or debugging a Bevy game in Rust — when the user mentions Bevy, ECS, App::new, add_systems, Query, Commands, components/systems, or a Cargo.toml depending on bevy.
path: skills/other-engines/bevy-ecs/SKILL.md

## love2d-core
Structure and debug a LÖVE (Love2D) game in Lua: the love.load/update/draw loop, delta-time movement, input, and screen states. Use when building a LÖVE 11.x game (main.lua, conf.lua, .love).
path: skills/other-engines/love2d-core/SKILL.md

## pygame-core
Structure a pygame (pygame-ce) game in Python: the init/event/update/draw loop, delta-time movement, Surface/Rect blitting, keyboard/mouse input, and Sprite/Group management with collision. Use when building or debugging a pygame game — when the user mentions pygame, pygame-ce, the game loop, blit, Surface, Rect, sprite groups, or clock.tick. Targets pygame-ce.
path: skills/other-engines/pygame-core/SKILL.md

## roblox-datastores
Persist player data in Roblox with DataStoreService: GetDataStore, GetAsync/ SetAsync/UpdateAsync/IncrementAsync wrapped in pcall, load-on-join and save-on-leave plus BindToClose, retries, and OrderedDataStore leaderboards. Use when saving or loading persistent data in a Roblox experience — when the user mentions DataStore, DataStoreService, GetAsync, SetAsync, UpdateAsync, save player data, or leaderboards. For general Luau scripting use roblox-luau.
path: skills/other-engines/roblox-datastores/SKILL.md

## roblox-luau
Script a Roblox experience in Luau: get services, create and parent Instances, connect events, run server Scripts vs client LocalScripts, and communicate across the client/server boundary with RemoteEvents/RemoteFunctions (server-authoritative). Use when building or debugging Roblox Studio scripts — when the user mentions Roblox, Luau, services, RemoteEvent, Instance.new, PlayerAdded, or client vs server. For saving player data use roblox-datastores.
path: skills/other-engines/roblox-luau/SKILL.md

## unity-animation
Drive Unity 6.3 LTS character animation with Animator Controllers: states, transitions, parameters, blend trees, animation layers, and humanoid Avatar IK. Use when wiring an Animator, setting parameters from script (SetFloat/SetBool/SetTrigger), building blend trees, or when the user mentions Animator, Mecanim, state machine, blend tree, or .controller.
path: skills/unity/unity-animation/SKILL.md

## unity-build-pipeline
Build and ship Unity 6.3 LTS players: build settings and scenes, player/quality settings, the IL2CPP vs Mono scripting backend, managed code stripping, scripted BuildPipeline.BuildPlayer, and CI/headless builds. Use when configuring or automating a build, choosing a scripting backend, shrinking build size, or when the user mentions Unity build, player settings, IL2CPP, code stripping, or Addressables.
path: skills/unity/unity-build-pipeline/SKILL.md

## unity-csharp-scripting
Write Unity 6.3 LTS C# gameplay scripts: the MonoBehaviour lifecycle (Awake/OnEnable/Start/Update/FixedUpdate/LateUpdate), GameObject and component access, coroutines, and Inspector serialization. Use when creating or editing .cs scripts in a Unity project, or when the user mentions MonoBehaviour, Start/Update, GetComponent, SerializeField, coroutines, or "Unity script".
path: skills/unity/unity-csharp-scripting/SKILL.md

## unity-input-system
Wire player input in Unity 6.3 LTS with the Input System package: Input Actions, action maps, the PlayerInput component, and reading values via callbacks or polling. Use when the project has a .inputactions asset or com.unity.inputsystem, or when the user mentions the Unity Input System, InputAction, action maps, PlayerInput, control schemes, or rebinding.
path: skills/unity/unity-input-system/SKILL.md

## unity-navmesh
Add AI navigation in Unity 6.3 LTS: bake a NavMesh with the AI Navigation package (NavMeshSurface), move agents with NavMeshAgent.SetDestination, and handle dynamic obstacles. Use when setting up pathfinding, making an enemy chase the player, baking navigation, or when the user mentions NavMesh, NavMeshAgent, NavMeshSurface, NavMeshObstacle, or Unity pathfinding.
path: skills/unity/unity-navmesh/SKILL.md

## unity-physics
Set up 3D physics in Unity 6.3 LTS: Rigidbody movement and forces, colliders, triggers vs collisions, layer-based collision, raycasts, and joints. Use when adding a Rigidbody, handling OnCollisionEnter/OnTriggerEnter, tuning collision layers, casting rays, or when the user mentions Unity physics, AddForce, isKinematic, or linearVelocity.
path: skills/unity/unity-physics/SKILL.md

## unity-scriptableobjects
Architect Unity 6.3 LTS data and decoupling with ScriptableObjects: config/data assets, shared runtime variables, event channels, and runtime sets/registries. Use when designing data-driven systems, replacing singletons/managers, creating .asset data with CreateAssetMenu, or when the user mentions ScriptableObject, SO architecture, or data assets.
path: skills/unity/unity-scriptableobjects/SKILL.md

## unity-tilemap-2d
Build and script 2D tilemaps in Unity 6.3 LTS: the Grid + Tilemap components, the Tile Palette, tilemap colliders, rule tiles, and runtime SetTile/GetTile painting. Use when painting tile levels, adding a TilemapCollider2D, using rule or animated tiles, generating tilemaps from code, or when the user mentions Unity tilemap, tile palette, rule tile, or Grid.
path: skills/unity/unity-tilemap-2d/SKILL.md

## unreal-behavior-trees
Build NPC AI in Unreal Engine 5 with Behavior Trees and Blackboards: composites (Selector/Sequence), tasks, decorators, services, and running the tree from an AIController. Use when creating enemy/NPC AI, BT_/BB_ assets, custom BTTask or BTService nodes, or when the user mentions Behavior Tree, Blackboard, AIController, BTTask, decorator, or service.
path: skills/unreal/unreal-behavior-trees/SKILL.md

## unreal-blueprints
Build Unreal Engine 5 gameplay with Blueprint visual scripting: Blueprint Classes, the Event Graph and Construction Script, variables/functions/macros, and Blueprint communication (Cast, Interfaces, Event Dispatchers). Use when working in Blueprints, wiring an event graph, deciding how Blueprints talk to each other, or when the user mentions Blueprint, BP, event graph, construction script, or a Blueprint .uasset.
path: skills/unreal/unreal-blueprints/SKILL.md

## unreal-cpp-gameplay
Write Unreal Engine 5 C++ gameplay code: the UCLASS/UPROPERTY/UFUNCTION reflection macros, the Gameplay Framework (GameMode, Pawn, Character, PlayerController, Actor components), and the module Build.cs. Use when writing or debugging UE C++, deriving from AActor/ACharacter/ AGameModeBase, exposing properties to the editor or Blueprints, or when the user mentions Unreal C++, UCLASS, GENERATED_BODY, GameMode, ACharacter, or .Build.cs.
path: skills/unreal/unreal-cpp-gameplay/SKILL.md

## unreal-enhanced-input
Set up player input in Unreal Engine 5 with Enhanced Input: Input Actions, Input Mapping Contexts, modifiers and triggers, adding the mapping context, and binding actions by ETriggerEvent. Use when wiring movement/look/jump input, creating IA_/IMC_ assets, binding in C++ or Blueprints, or when the user mentions Enhanced Input, Input Mapping Context, Input Action, IA_/IMC_, or ETriggerEvent.
path: skills/unreal/unreal-enhanced-input/SKILL.md

## unreal-niagara
Create and control VFX in Unreal Engine 5 with Niagara: systems and emitters, modules and the spawn/update stages, exposed User parameters, and spawning or driving effects from Blueprints or C++. Use when building particle effects, NS_/NE_ assets, spawning a Niagara system at runtime, setting User parameters, or when the user mentions Niagara, VFX, or a particle system in Unreal.
path: skills/unreal/unreal-niagara/SKILL.md

## unreal-packaging
Package and ship an Unreal Engine 5 project: the Platforms menu Package Project flow, build configurations (Development vs Shipping), cooking content, packaging settings and the Game Default Map, and command-line builds with RunUAT BuildCookRun. Use when packaging a build, making a shipping build, cooking content, configuring packaging settings, or when the user mentions package Unreal, cook content, shipping build, or BuildCookRun.
path: skills/unreal/unreal-packaging/SKILL.md

## phaser-arcade-physics
Use Phaser 4 Arcade Physics: enable the world, give sprites bodies, set velocity/acceleration/gravity, and resolve collisions with colliders, overlaps, groups, and world bounds. Use when a Phaser game needs movement or collisions — when the user mentions Arcade Physics, this.physics, setVelocity, collider, overlap, gravity, onFloor, or a platformer/top-down controller. For game config, scenes, and the loader use phaser-core.
path: skills/web-engines/phaser-arcade-physics/SKILL.md

## phaser-core
Set up and debug a Phaser 4 game: the Game config, the Scene lifecycle (init/preload/create/update), the asset loader, cameras, and cross-scene communication. Use when building or debugging a Phaser game — when the user mentions Phaser, Phaser.Game, Phaser.Scene, preload/create/update, this.load, this.add, or scene transitions. For Arcade Physics movement/collisions use phaser-arcade-physics.
path: skills/web-engines/phaser-core/SKILL.md

## pixijs-rendering
Build a PixiJS v8 render layer: create the async Application, load textures with Assets, compose the scene graph with Container and Sprite, drive the ticker loop, wire pointer events, and group draws with render groups. Use when building or debugging PixiJS v8 — when the user mentions PixiJS, Pixi, Application, app.stage, Container, Sprite, Assets.load, app.ticker, or eventMode. Pins the v8 async init() API.
path: skills/web-engines/pixijs-rendering/SKILL.md

## threejs-gltf-loading
Load glTF/GLB models in three.js with GLTFLoader and play their skinned animations with AnimationMixer, including DRACO/Meshopt-compressed meshes and KTX2 textures. Use when importing 3D models into three.js — when the user mentions glTF, GLB, GLTFLoader, AnimationMixer, animation clips, DRACOLoader, or "load a 3D model". For scene/camera/renderer setup use threejs-scene-setup; for materials and lights use threejs-materials-lighting.
path: skills/web-engines/threejs-gltf-loading/SKILL.md

## threejs-materials-lighting
Light and shade a three.js scene: choose materials (MeshStandardMaterial PBR vs unlit MeshBasicMaterial), add ambient/hemisphere/directional/point/spot lights, turn on shadow maps, and use an environment map (IBL) for realistic reflections. Use when a three.js model looks black, flat, or wrong — when the user mentions three.js materials, MeshStandardMaterial, lights, shadows, envMap, or PBR. For renderer/loop setup use threejs-scene-setup; for loading models use threejs-gltf-loading.
path: skills/web-engines/threejs-materials-lighting/SKILL.md

## threejs-scene-setup
Stand up a three.js scene: import maps and the three/addons path, the Scene/PerspectiveCamera/WebGLRenderer trio, the setAnimationLoop render loop, responsive resize, and OrbitControls. Use when starting or debugging a three.js app — when the user mentions three.js, THREE.Scene, WebGLRenderer, PerspectiveCamera, the render loop, resizing, or OrbitControls. For models use threejs-gltf-loading; for materials/lights use threejs-materials-lighting.
path: skills/web-engines/threejs-scene-setup/SKILL.md

## game-jam
Plan and ship a game under a jam deadline: lock scope to the clock, schedule the hours, cut features, and submit on time. Use for a game jam (Ludum Dare, GMTK Jam, Global Game Jam), a 48-hour or weekend build, or scoping and submitting a jam entry.
path: skills/workflows/game-jam/SKILL.md

## itch-publish
Publish and update a game on itch.io: create the project page and upload builds with the butler CLI (butler push) to named channels. Use for itch.io publishing, butler push, channel naming for Windows/macOS/Linux/HTML5, versioning uploads, or shipping a jam or release build to itch.io.
path: skills/workflows/itch-publish/SKILL.md

## prototype-fast
Build a playable prototype in about an hour to answer one question — is it fun? — with greybox primitives, a hard timebox, and explicit keep/kill criteria. Use when prototyping a mechanic, making a vertical slice or MVP, greyboxing/blockout, or judging throwaway vs keep.
path: skills/workflows/prototype-fast/SKILL.md

## steam-publish
Publish or update a game on Steam with Steamworks and SteamPipe: configure depots and packages, upload builds with steamcmd, set a build live on a branch, and run the release checklists. Use for Steam publishing, app_build.vdf/steamcmd uploads, depots, beta branches, or a store page release.
path: skills/workflows/steam-publish/SKILL.md
