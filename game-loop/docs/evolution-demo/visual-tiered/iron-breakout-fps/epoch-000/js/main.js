"use strict";

// -----------------------------------------------------------------------
// 模式流程、五关切换和界面状态
// -----------------------------------------------------------------------
function clearEnemiesAndEffects() {
  for (const enemy of enemies) {
    scene.remove(enemy.group);
  }
  enemies.length = 0;

  for (const effect of effects) {
    scene.remove(effect.group);
    effect.material.dispose();
  }
  effects.length = 0;
  respawnTimers.length = 0;

  for (const projectile of playerProjectiles) {
    projectile.group.traverse(function (object) {
      if (object.geometry) object.geometry.dispose();
    });
    scene.remove(projectile.group);
  }
  playerProjectiles.length = 0;
}

function resetPlayer() {
  const safeStart = findNearestSafePosition(
    new THREE.Vector3(playerStart.x, playerStart.y, playerStart.z),
    player.radius,
    player.bodyHeight
  );
  player.position.copy(safeStart);
  resolveCirclePenetration(player.position, player.radius, player.bodyHeight);
  playerLastSafePosition.copy(player.position);
  player.velocityY = 0;
  player.grounded = true;
  player.climbing = false;
  player.yaw = playerStart.yaw;
  player.pitch = 0;
  player.health = 100;
  damageFlash = 0;
  hitFlash = 0;
  firing = false;
  weaponRecoil = 0;
  muzzleTimer = 0;
  muzzleFlash.visible = false;
  muzzleLight.intensity = 0;
  lastShotTime = -Infinity;
  lastEmptyAmmoNotice = -Infinity;
  setAiming(false);
  resetAllAmmo();
  setCurrentWeapon("机枪", false);

  for (const key in keys) keys[key] = false;

  camera.position.set(
    player.position.x,
    player.position.y + player.eyeHeight,
    player.position.z
  );
  camera.rotation.set(0, player.yaw, 0);
  updateHealthUI();
}

function populateImmediately() {
  const stats = getDifficultyStats();
  const count = selectedMode === "无尽"
    ? stats.maxActive
    : Math.min(stats.maxActive, LEVEL_ENEMY_TOTAL);

  for (let i = 0; i < count; i++) {
    createEnemy();
  }
}

function startGame(mode) {
  selectedMode = mode;
  currentLevel = 1;
  score = 0;
  totalKills = 0;
  levelKills = 0;
  levelSpawned = 0;
  gameState = "战斗";

  clearEnemiesAndEffects();
  loadCurrentMap();
  resetPlayer();
  populateImmediately();

  modeScreen.classList.add("hidden");
  endlessMapScreen.classList.add("hidden");
  pauseScreen.classList.add("hidden");
  resultScreen.classList.add("hidden");
  updateGameInfo();

  renderer.domElement.requestPointerLock();
}

function startCurrentLevel() {
  gameState = "战斗";
  levelKills = 0;
  levelSpawned = 0;

  clearEnemiesAndEffects();
  loadCurrentMap();
  resetPlayer();
  populateImmediately();

  resultScreen.classList.add("hidden");
  pauseScreen.classList.add("hidden");
  updateGameInfo();
  renderer.domElement.requestPointerLock();
}

function completeCurrentLevel() {
  gameState = currentLevel >= 5 ? "通关" : "过关";
  firing = false;
  setAiming(false);
  cancelReload();
  respawnTimers.length = 0;

  if (document.pointerLockElement === renderer.domElement) {
    document.exitPointerLock();
  }

  resultScreen.classList.remove("hidden");
  resultTitle.className = "title win";
  resultActionButton.classList.remove("hidden");

  if (currentLevel >= 5) {
    resultTitle.textContent = "全部关卡完成";
    resultSummary.textContent =
      "五座战区已全部肃清　累计分数：" + score;
    resultPrompt.textContent = "你已完成最终任务";
    resultActionButton.textContent = "重新挑战关卡模式";
  } else {
    resultTitle.textContent = "第 " + currentLevel + " 关胜利";
    resultSummary.textContent =
      "本关二十五名敌人已全部消灭　累计分数：" + score;
    resultPrompt.textContent =
      "下一关威胁等级将提升至 " + (currentLevel + 1);
    resultActionButton.textContent = "进入下一关";
  }
}

function showGameOver() {
  gameState = "失败";
  firing = false;
  setAiming(false);
  cancelReload();
  respawnTimers.length = 0;

  if (document.pointerLockElement === renderer.domElement) {
    document.exitPointerLock();
  }

  resultScreen.classList.remove("hidden");
  resultTitle.className = "title fail";
  resultTitle.textContent = "任务失败";
  resultSummary.textContent =
    "累计分数：" + score + "　累计击杀：" + totalKills;
  resultPrompt.textContent = "按 R 键重新开始当前模式";
  resultActionButton.classList.add("hidden");
}

function restartSelectedMode() {
  if (!selectedMode) return;
  startGame(selectedMode);
}

function showModeMenu() {
  gameState = "菜单";
  selectedMode = null;
  firing = false;
  setAiming(false);
  resetAllAmmo();
  setCurrentWeapon("机枪", false);
  clearEnemiesAndEffects();
  clearMapPickups();

  if (document.pointerLockElement === renderer.domElement) {
    document.exitPointerLock();
  }

  resultScreen.classList.add("hidden");
  pauseScreen.classList.add("hidden");
  endlessMapScreen.classList.add("hidden");
  modeScreen.classList.remove("hidden");

  modeText.textContent = "尚未选择";
  mapText.textContent = "待命区";
  scoreText.textContent = "0";
  difficultyText.textContent = "1";
  enemyCountText.textContent = "0";
  weaponText.textContent = "机枪";
  updateAmmoUI();
  objective.textContent = "请选择游戏模式";
}

function formatObjectiveStatus() {
  if (selectedMode === "无尽") {
    return "威胁推进 " + score + " 分 / 每 800 分升档";
  }
  if (selectedMode === "关卡") {
    return "关卡 " + currentLevel + " · " + levelKills + " / " + LEVEL_ENEMY_TOTAL + " 已肃清";
  }
  return "请选择游戏模式";
}

function updateGameInfo() {
  const stats = selectedMode ? getDifficultyStats() : { tier: 1 };
  modeText.textContent = selectedMode
    ? selectedMode + "模式"
    : "尚未选择";
  scoreText.textContent = String(score);
  difficultyText.textContent = String(stats.tier);
  enemyCountText.textContent = String(livingEnemyCount());

  if (selectedMode === "无尽") {
    objective.textContent =
      "无尽作战：敌人会持续复活　每 800 分提升一次威胁等级";
  } else if (selectedMode === "关卡") {
    objective.textContent =
      "第 " + currentLevel + " 关：已消灭 " +
      levelKills + " / " + LEVEL_ENEMY_TOTAL;
  }
  objective.dataset.mode = selectedMode || "";
  objective.dataset.status = formatObjectiveStatus();
}

// -----------------------------------------------------------------------
// 鼠标锁定与键盘输入
// -----------------------------------------------------------------------
function onPointerLockChange() {
  const locked = document.pointerLockElement === renderer.domElement;

  if (locked) {
    pauseScreen.classList.add("hidden");
  } else {
    firing = false;
    setAiming(false);
    if (gameState === "战斗" && modeScreen.classList.contains("hidden")) {
      pauseScreen.classList.remove("hidden");
    }
  }
}

document.getElementById("endlessModeButton").addEventListener("click", function () {
  modeScreen.classList.add("hidden");
  endlessMapScreen.classList.remove("hidden");
});

document.getElementById("backFromMapButton").addEventListener("click", function () {
  endlessMapScreen.classList.add("hidden");
  modeScreen.classList.remove("hidden");
});

document.querySelectorAll(".endless-map-button").forEach(function (button) {
  button.addEventListener("click", function () {
    selectedEndlessMap = Number(button.dataset.mapIndex);
    startGame("无尽");
  });
});

document.getElementById("levelModeButton").addEventListener("click", function () {
  startGame("关卡");
});

pauseScreen.addEventListener("click", function () {
  if (gameState === "战斗") {
    renderer.domElement.requestPointerLock();
  }
});

resultActionButton.addEventListener("click", function () {
  if (gameState === "过关") {
    currentLevel++;
    startCurrentLevel();
  } else if (gameState === "通关") {
    startGame("关卡");
  }
});

returnMenuButton.addEventListener("click", showModeMenu);
document.addEventListener("pointerlockchange", onPointerLockChange);

document.addEventListener("mousemove", function (event) {
  if (
    document.pointerLockElement !== renderer.domElement ||
    gameState !== "战斗"
  ) {
    return;
  }

  const sensitivity = aiming ? 0.00072 : 0.00215;
  player.yaw -= event.movementX * sensitivity;
  player.pitch -= event.movementY * sensitivity;
  player.pitch = THREE.MathUtils.clamp(
    player.pitch,
    -Math.PI / 2 + 0.04,
    Math.PI / 2 - 0.04
  );
});

document.addEventListener("mousedown", function (event) {
  if (
    event.button === 0 &&
    document.pointerLockElement === renderer.domElement
  ) {
    firing = true;
    shoot();
  }
});

document.addEventListener("mouseup", function (event) {
  if (event.button === 0) firing = false;
});

document.addEventListener("contextmenu", function (event) {
  event.preventDefault();
});

document.addEventListener("keydown", function (event) {
  keys[event.code] = true;

  if (event.code === "KeyQ") {
    setAiming(true);
  }

  if (event.code === "Space") {
    event.preventDefault();
    const ladder = findNearbyLadder();
    if (
      player.grounded &&
      !ladder &&
      gameState === "战斗" &&
      document.pointerLockElement === renderer.domElement
    ) {
      player.velocityY = player.jumpSpeed;
      player.grounded = false;
    }
  }

  if (event.code === "KeyR") {
    if (gameState === "失败") {
      restartSelectedMode();
    } else if (
      gameState === "战斗" &&
      document.pointerLockElement === renderer.domElement
    ) {
      startReload(true);
    }
  }
});

document.addEventListener("keyup", function (event) {
  keys[event.code] = false;
  if (event.code === "KeyQ") setAiming(false);
});

window.addEventListener("blur", function () {
  for (const key in keys) keys[key] = false;
  firing = false;
  setAiming(false);
});

window.addEventListener("resize", function () {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
});

// -----------------------------------------------------------------------
// 主循环
// -----------------------------------------------------------------------
function animate() {
  requestAnimationFrame(animate);
  const delta = Math.min(clock.getDelta(), 0.05);

  updatePlayer(delta);
  if (firing) shoot();
  updateWeapon(delta);
  updatePlayerProjectiles(delta);
  updateEnemyAI(delta);
  maintainEnemyPopulation();
  updatePickups(delta);
  updateEffects(delta);
  updateVisualUI(delta);
  updateMinimap(delta);
  renderer.render(scene, camera);
}

// 初始化待命场景并显示模式选择。
clearMap();
buildEndlessMap();
rebuildMinimapStatic();
drawEndlessMapPreviews();
camera.position.set(0, player.eyeHeight, 29);
updateHealthUI();
updateGameInfo();
loadingScreen.classList.add("hidden");
modeScreen.classList.remove("hidden");
animate();


// Manual FPS presentation dressing. This file belongs only to visual-tiered demos.
(function () {
  const tier = 0;
  if (typeof THREE === "undefined" || typeof scene === "undefined") return;
  const oldPresentation = scene.getObjectByName("presentation-industrial-dressing");
  if (oldPresentation) scene.remove(oldPresentation);
  const dressing = new THREE.Group();
  dressing.name = "presentation-industrial-dressing";
  scene.add(dressing);
  const placeDressingAtSpawn = () => {
    // The FPS spawn faces +Z. Keep the authored set in front of the player
    // for every map, whose spawn z coordinate is different.
    // The authored set is centered around local z=17. Move that center to
    // world z=40: between the first-map spawn at z=31 and its outer wall.
    // This keeps the structures in the player's +Z view and inside the map.
    dressing.position.z = 23;
  };
  placeDressingAtSpawn();
  const palette = tier >= 3
    ? { bg: 0x142636, fog: 0x142636, ambient: 1.45, exposure: 2.25, cyan: 0x39e6ff, amber: 0xffa23a }
    : tier >= 2
      ? { bg: 0x172530, fog: 0x172530, ambient: 1.2, exposure: 1.95, cyan: 0x42cbe0, amber: 0xffa34b }
      : tier >= 1
        ? { bg: 0x172027, fog: 0x172027, ambient: 1.0, exposure: 1.75, cyan: 0x4ba6b8, amber: 0xe59448 }
        : { bg: 0x111820, fog: 0x111820, ambient: .95, exposure: 1.58, cyan: 0x5c7f88, amber: 0xb47743 };
  scene.background = new THREE.Color(palette.bg);
  if (scene.fog) {
    scene.fog.color.setHex(palette.fog);
    scene.fog.near = tier >= 3 ? 10 : 16;
    scene.fog.far = tier >= 3 ? 145 : 110;
  }
  hemisphere.intensity = Math.max(hemisphere.intensity, palette.ambient);
  sun.intensity = Math.max(sun.intensity, tier >= 3 ? 2.6 : 1.9);
  renderer.toneMappingExposure = palette.exposure;

  const metal = new THREE.MeshStandardMaterial({ color: 0x66808a, emissive: 0x233b46, emissiveIntensity: .7, roughness: .28, metalness: .78 });
  const darkMetal = new THREE.MeshStandardMaterial({ color: 0x263c46, emissive: 0x102b37, emissiveIntensity: .9, roughness: .38, metalness: .72 });
  const floorMetal = new THREE.MeshStandardMaterial({ color: 0x52636a, emissive: 0x172c34, emissiveIntensity: .45, roughness: .62, metalness: .48 });
  const wallMetal = new THREE.MeshStandardMaterial({ color: 0x3b4f58, emissive: 0x162d36, emissiveIntensity: .65, roughness: .5, metalness: .62 });
  const crateMetal = new THREE.MeshStandardMaterial({ color: 0x8a5a36, emissive: 0x2f1b0e, emissiveIntensity: .55, roughness: .72, metalness: .28 });
  const cyan = new THREE.MeshBasicMaterial({ color: palette.cyan });
  const amber = new THREE.MeshBasicMaterial({ color: palette.amber });
  const emissive = new THREE.MeshStandardMaterial({ color: 0x253741, emissive: palette.cyan, emissiveIntensity: tier >= 3 ? 2.5 : tier >= 2 ? 1.4 : .55, roughness: .3, metalness: .6 });
  const box = (w, h, d, material, x, y, z) => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), material);
    mesh.position.set(x, y, z); mesh.castShadow = true; mesh.receiveShadow = true; dressing.add(mesh); return mesh;
  };
  const beam = (x, y, z, length, color, horizontal = true) => {
    const mesh = box(horizontal ? length : .12, .12, horizontal ? .12 : length, color, x, y, z);
    return mesh;
  };
  const lamp = (x, y, z, color, intensity, distance) => {
    const bulb = new THREE.Mesh(new THREE.SphereGeometry(.18, 12, 8), color);
    bulb.position.set(x, y, z); dressing.add(bulb);
    const light = new THREE.PointLight(color.color, intensity, distance, 2);
    light.position.set(x, y, z);
    light.castShadow = tier >= 3;
    light.shadow.mapSize.set(512, 512);
    light.shadow.bias = -0.002;
    dressing.add(light);
  };
  const pipe = (x, y, z, length, radius, material, horizontal = false) => {
    const mesh = new THREE.Mesh(
      new THREE.CylinderGeometry(radius, radius, length, 14),
      material
    );
    mesh.position.set(x, y, z);
    if (horizontal) mesh.rotation.x = Math.PI / 2;
    mesh.castShadow = true; mesh.receiveShadow = true; dressing.add(mesh);
    return mesh;
  };
  const spotlight = (x, y, z, color, targetX, targetY, targetZ, intensity) => {
    const light = new THREE.SpotLight(color, intensity, 34, Math.PI / 5, .48, 1.4);
    light.position.set(x, y, z);
    light.target.position.set(targetX, targetY, targetZ);
    light.castShadow = true;
    light.shadow.mapSize.set(1024, 1024);
    light.shadow.bias = -0.003;
    dressing.add(light); dressing.add(light.target);
  };

  // Keep the dressing close to the default spawn (z=29, looking toward -z)
  // so the visual change is visible on the first combat frame.
  if (tier >= 1 && tier < 3) {
    for (const x of [-7.5, 7.5]) {
      box(2.8, 5.8, 2.4, darkMetal, x, 2.9, 17);
      box(3.3, .22, 2.9, emissive, x, 5.9, 17);
      for (let y = 1.1; y < 5.4; y += 1.1) beam(x, y, 15.72, 1.9, cyan);
    }
    beam(0, 7.2, 17, 20, metal);
    for (const x of [-8, -4, 0, 4, 8]) lamp(x, 6.9, 16.2, x % 8 ? cyan : amber, tier >= 3 ? 8 : 4.5, 16);
    beam(-4.2, .08, 21, 13, cyan, false);
    beam(4.2, .08, 21, 13, amber, false);
  }
  if (tier >= 2 && tier < 3) {
    for (const x of [-13, 13]) {
      box(3.2, 8.5, 3.2, metal, x, 4.25, 4);
      box(3.8, .16, 3.8, emissive, x, 8.65, 4);
      for (let y = 1.2; y < 8; y += 1.35) beam(x, y, 2.28, 2.6, amber);
    }
    for (const z of [13, 8, 3, -2]) {
      beam(0, .1, z, 21, z % 10 ? amber : cyan);
      beam(0, 3.4, z, 21, darkMetal);
    }
    lamp(-10, 4.6, 8, amber, 12, 23);
    lamp(10, 4.6, 8, cyan, 12, 23);
  }
  if (tier >= 3) {
    // Keep the original map readable. Tier 3 adds only a few side props and
    // distant lights; the playable map remains the dominant geometry.
    for (const x of [-22, 22]) {
      box(3.2, 5.5, 3.2, darkMetal, x, 2.75, 4);
      box(3.6, .18, 3.6, emissive, x, 5.65, 4);
      pipe(x, 4.8, 10, 9, .28, metal, true);
    }
    for (const x of [-18, 18]) {
      box(4.2, 2.1, 4.2, crateMetal, x, 1.05, 12);
    }
    for (const x of [-13, 13]) {
      box(.8, 6.5, .8, metal, x, 3.25, -4);
    }
    beam(0, 6.4, -4, 26, metal);
    beam(0, 5.9, -4, 24, emissive);
    const rim = new THREE.DirectionalLight(palette.cyan, 1.7);
    rim.position.set(-22, 18, 18); dressing.add(rim);
    rim.castShadow = true;
    rim.shadow.mapSize.set(1024, 1024);
    const warm = new THREE.DirectionalLight(palette.amber, 1.35);
    warm.position.set(25, 10, 4); dressing.add(warm);
    warm.castShadow = true;
    warm.shadow.mapSize.set(1024, 1024);
    for (const x of [-16, -8, 8, 16]) lamp(x, 5.2, 12, x < 0 ? cyan : amber, 14, 28);
    spotlight(-11, 9, 19, palette.cyan, 0, 1, 9, 34);
    spotlight(11, 8, 18, palette.amber, 0, 1, 7, 32);
    spotlight(0, 11, 4, 0xffe0a2, 0, 0, 14, 28);
    scene.fog.near = 18; scene.fog.far = 135;
  }
}());

