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
  clearDamageDirection();
  // 重置瞄准反馈状态：上一局的准星张开量与命中脉冲不得带进新对局。
  crosshairBloom = 0;
  hitMarkerPulse = 0;
  hitMarkerStrong = false;
  crosshair.classList.remove("is-blooming");
  crosshair.style.setProperty("--bloom", "0px");
  hitMarker.classList.remove("pulse", "strong");
  hitMarker.style.removeProperty("--pulse");
  firing = false;
  weaponRecoil = 0;
  muzzleTimer = 0;
  muzzleFlash.visible = false;
  muzzleLight.intensity = 0;
  lastShotTime = -Infinity;
  lastEmptyAmmoNotice = -Infinity;
  setAiming(false);
  resetKillStreak(false);
  killStreakTimer = 0;
  recentDamage.length = 0;
  clearCombatLogNow();
  resetAllAmmo();
  setCurrentWeapon("机枪", false);
  // 重置濒死警告与威胁指针，避免上一局的横幅残留到新一局。
  setLowHealthActive(false);
  nearestThreatInfo = null;
  dangerScanTimer = 0;
  lowHealthPeakDamage = 0;
  dangerTarget.textContent = "最近威胁";
  dangerArrow.textContent = "▲";
  dangerArrow.style.transform = "rotate(0rad)";

  // 清空上一局残留的威胁方位指示与部位伤害统计。
  threatMarkers.length = 0;
  if (threatMarkersPanel) threatMarkersPanel.innerHTML = "";
  threatMarkerTimer = 0;
  // 威胁等级进度条随对局重置：等级从 1 重新观察，高亮立即熄灭。
  threatTierShown = 1;
  threatTierFlashTimer = 0;
  if (threatTrack) threatTrack.classList.remove("tier-up");
  // 敌情预告读数随对局重置：上一局的倒计时警示态不得带进新一局。
  intakeEscalating = false;
  if (intakeReadout) {
    intakeReadout.classList.remove("escalating");
    intakeReadout.classList.add("hidden");
  }
  // 补给抵达预告随对局重置：上一局的倒计时警示态不得带进新一局。
  supplyEscalating = false;
  if (supplyReadout) {
    supplyReadout.classList.remove("escalating");
    supplyReadout.classList.add("hidden");
  }
  hitZoneDamageDealt = 0;
  hitZoneHeadshotKills = 0;
  // 精度遥测随对局重置，上一局的命中率不得带进新一局。
  shotsFired = 0;
  shotsHit = 0;
  updateAccuracyUI();
  updateHeadshotUI();
  const zoneLabel = hitZoneLabel;
  if (zoneLabel) {
    zoneLabel.className = "";
    zoneLabel.textContent = "";
  }
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
  if (window.SFX) window.SFX.uiClick();
  selectedMode = mode;
  currentLevel = 1;
  // 最佳纪录追踪：记录本局起点的历史最佳，供追踪条与结算对照使用。
  runBestScoreAtStart = bestScore;
  runRecordBroken = false;
  recordTrackFlashTimer = 0;
  score = 0;
  totalKills = 0;
  resetSurvivalClock();
  levelKills = 0;
  levelSpawned = 0;
  highestKillStreak = 0;
  killStreakCount = 0;
  killStreakTimer = 0;
  gameState = "战斗";
  // 精度遥测随对局开始清零。
  shotsFired = 0;
  shotsHit = 0;
  updateAccuracyUI();

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
  highestKillStreak = 0;
  // 关卡模式不显示纪录追踪条；进入下一关前清掉上一关的结算对照状态。
  runBestScoreAtStart = 0;
  runRecordBroken = false;
  recordTrackFlashTimer = 0;

  clearEnemiesAndEffects();
  loadCurrentMap();
  resetPlayer();
  populateImmediately();

  resultScreen.classList.add("hidden");
  pauseScreen.classList.add("hidden");
  updateGameInfo();
  renderer.domElement.requestPointerLock();
}

// 结算界面共用的精度报告行；一发未射时显示 “--” 避免除以零。
function buildAccuracySummary() {
  const accuracy = getAccuracyPercent();
  const accuracyText = accuracy === null ? "--" : accuracy + "%";
  return "命中率 " + accuracyText + "（发射 " + shotsFired +
    " 发　命中 " + shotsHit + " 发）";
}

// 结算界面的历史最佳对照行：破纪录时给出金色“新纪录”提示，否则显示差距。
function buildRecordSummary() {
  if (selectedMode !== "无尽") return null;
  if (runRecordBroken) {
    return "🏆 新纪录 " + score + " 分（此前最佳 " +
      runBestScoreAtStart + "）";
  }
  if (runBestScoreAtStart > 0) {
    const gap = Math.max(0, runBestScoreAtStart - score);
    return gap === 0
      ? "追平历史最佳 " + runBestScoreAtStart + " 分"
      : "距历史最佳还差 " + gap + " 分（最佳 " + runBestScoreAtStart + "）";
  }
  return "本局已建立历史最佳 " + bestScore + " 分";
}

function showResultRecordSummary() {
  if (!resultRecordSummary) return;
  const text = buildRecordSummary();
  if (text === null) {
    resultRecordSummary.classList.add("hidden");
    return;
  }
  resultRecordSummary.classList.remove("hidden");
  resultRecordSummary.textContent = text;
  resultRecordSummary.classList.toggle("record-new", runRecordBroken);
}

function completeCurrentLevel() {
  if (window.SFX) window.SFX.alarm(false);
  window.SFX && window.SFX.levelClear();
  gameState = currentLevel >= 5 ? "通关" : "过关";
  firing = false;
  setAiming(false);
  cancelReload();
  respawnTimers.length = 0;
  hideReloadPrompt();

  if (document.pointerLockElement === renderer.domElement) {
    document.exitPointerLock();
  }

  resultScreen.classList.remove("hidden");
  resultTitle.className = "title win";
  resultActionButton.classList.remove("hidden");
  resultStreakSummary.classList.remove("hidden");
  resultStreakSummary.textContent =
    "本关最高连杀：" + highestKillStreak + "　历史最佳分数：" + bestScore;
  commitBestScore();
  updateAccuracyUI();
  showResultRecordSummary();

  if (currentLevel >= 5) {
    resultTitle.textContent = "全部关卡完成";
    resultSummary.textContent =
      "五座战区已全部肃清　累计分数：" + score +
      "　存活时间 " + formatSurvivalTime(survivalSeconds);
    resultPrompt.textContent = "你已完成最终任务";
    resultActionButton.textContent = "重新挑战关卡模式";
  } else {
    resultTitle.textContent = "第 " + currentLevel + " 关胜利";
    resultSummary.textContent =
      "本关二十五名敌人已全部消灭　累计分数：" + score +
      "　存活时间 " + formatSurvivalTime(survivalSeconds);
    resultPrompt.textContent =
      "下一关威胁等级将提升至 " + (currentLevel + 1);
    resultActionButton.textContent = "进入下一关";
  }
}

function showGameOver() {
  gameState = "失败";
  if (window.SFX) window.SFX.alarm(false);
  window.SFX && window.SFX.gameOver();
  firing = false;
  setAiming(false);
  cancelReload();
  resetKillStreak(false);
  killStreakTimer = 0;
  respawnTimers.length = 0;
  commitBestScore();
  clearDamageDirection();
  hideReloadPrompt();

  if (document.pointerLockElement === renderer.domElement) {
    document.exitPointerLock();
  }

  resultScreen.classList.remove("hidden");
  resultTitle.className = "title fail";
  resultTitle.textContent = "任务失败";
  resultSummary.textContent =
    "累计分数：" + score + "　累计击杀：" + totalKills +
    "　存活时间 " + formatSurvivalTime(survivalSeconds) +
    "　" + buildAccuracySummary();
  resultStreakSummary.classList.remove("hidden");
  resultStreakSummary.classList.remove("hidden");
  resultStreakSummary.textContent =
    "本次最高连杀：" + highestKillStreak + "　爆头击杀：" + hitZoneHeadshotKills +
    "　历史最佳分数：" + bestScore;
  showResultRecordSummary();
  resultPrompt.textContent = "按 R 键重新开始当前模式　·　按 Esc 返回主菜单";
  resultActionButton.classList.add("hidden");
}

function restartSelectedMode() {
  if (!selectedMode) return;
  startGame(selectedMode);
}

function showModeMenu() {
  if (window.SFX) window.SFX.alarm(false);
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
  updateBestScoreUI();
  setKillStreak(0);
  hitZoneHeadshotKills = 0;
  hitZoneDamageDealt = 0;
  updateHeadshotUI();
  objectiveText.textContent = "请选择游戏模式";
  setLowHealthActive(false);
  nearestThreatInfo = null;
  dangerScanTimer = 0;
  lowHealthPeakDamage = 0;
  // 威胁等级进度条复位：上一局的等级高亮与播报状态不得带进新对局。
  threatTierShown = 1;
  threatTierFlashTimer = 0;
  if (threatTrack) threatTrack.classList.remove("tier-up");
  // 存活时间复位：返回菜单后不得残留上一局的计时读数。
  resetSurvivalClock();
  // 敌情预告读数复位：返回菜单后不再残留上一局的倒计时与警示态。
  intakeEscalating = false;
  // 最佳纪录追踪复位：上一局的破纪录高亮与领先形态不得带进新对局。
  resetRecordTrackState();
  if (intakeReadout) {
    intakeReadout.classList.remove("escalating");
    intakeReadout.classList.add("hidden");
  }
  // 补给抵达预告复位：返回菜单后不再残留上一局的倒计时与警示态。
  supplyEscalating = false;
  if (supplyReadout) {
    supplyReadout.classList.remove("escalating");
    supplyReadout.classList.add("hidden");
  }
  updateMissionProgressBar();
  clearDamageNumbers();
  // 受击方向指示复位：返回菜单后不得残留上一局的弧线。
  clearDamageDirection();
}

function clearCombatLogNow() {
  combatLogEntries.length = 0;
  combatLog.innerHTML = "";
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
    objectiveText.textContent =
      "无尽作战：敌人会持续复活　每 800 分提升一次威胁等级";
  } else if (selectedMode === "关卡") {
    objectiveText.textContent =
      "第 " + currentLevel + " 关：已消灭 " +
      levelKills + " / " + LEVEL_ENEMY_TOTAL;
  }
  updateMissionProgressBar();
}

// -----------------------------------------------------------------------
// 鼠标锁定与键盘输入
// -----------------------------------------------------------------------
// 真·暂停锚点：暂停瞬间的挂钟时间。暂停状态不改变 gameState（仍为“战斗”），
// 各更新函数自带的 gameState 判断都识别不了暂停，必须由主循环统一冻结；
// 挂钟型敌人重生计时器则在恢复时按暂停时长整体前移，保证增援仍按
// “有效战斗时间”的约定时刻抵达（不损失、也不在恢复瞬间集中爆发）。
let pauseAnchorTime = 0;

function isGamePaused() {
  return gameState === "战斗" &&
    !pauseScreen.classList.contains("hidden");
}

function shiftRespawnTimersBy(pausedSeconds) {
  if (pausedSeconds <= 0) return;
  for (let i = 0; i < respawnTimers.length; i++) {
    respawnTimers[i] += pausedSeconds;
  }
}

function onPointerLockChange() {
  const locked = document.pointerLockElement === renderer.domElement;

  if (locked) {
    if (pauseAnchorTime > 0) {
      shiftRespawnTimersBy(performance.now() / 1000 - pauseAnchorTime);
      pauseAnchorTime = 0;
    }
    pauseScreen.classList.add("hidden");
  } else {
    firing = false;
    setAiming(false);
    if (gameState === "战斗" && modeScreen.classList.contains("hidden")) {
      pauseAnchorTime = performance.now() / 1000;
      // 敌情/补给读数随暂停熄灭（代码约定暂停时隐藏），恢复后由主循环
      // 依据计时器数据源重新同步，读数不会带着暂停期间流逝的时间返回。
      if (intakeReadout) intakeReadout.classList.add("hidden");
      if (supplyReadout) supplyReadout.classList.add("hidden");
      pauseScreen.classList.remove("hidden");
    } else {
      pauseAnchorTime = 0;
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

// -----------------------------------------------------------------------
// 音效系统：懒初始化（首个手势解锁 AudioContext）、静音开关（M / HUD 按钮）
// -----------------------------------------------------------------------
let sfxReady = false;
let sfxStatsTimer = 0;

function initAudio() {
  if (!window.SFX || sfxReady) return;
  window.SFX.init();
  window.SFX.resume();
  sfxReady = true;
  refreshAudioToggle();
}

function toggleAudio() {
  if (!window.SFX) return;
  if (!sfxReady) {
    initAudio();
    return;
  }
  window.SFX.setMuted(!window.SFX.isMuted());
  refreshAudioToggle();
  window.SFX.uiClick();
}

function refreshAudioToggle() {
  if (!window.SFX) return;
  const muted = window.SFX.isMuted();
  audioToggle.classList.toggle("muted", muted);
  audioToggle.classList.toggle("playing", !muted);
  audioToggle.setAttribute(
    "aria-pressed", muted ? "true" : "false");
  audioToggleLabel.textContent = muted ? "音效 关" : "音效 开";
  updateSfxCountUI();
}

function updateSfxCountUI() {
  if (!window.SFX) return;
  const stats = window.SFX.getStats();
  sfxCountText.textContent = String(stats.events);
  if (gameState === "战斗" || gameState === "菜单") {
    audioToggle.classList.toggle("playing",
      !stats.muted && stats.contextState === "running");
  }
}

const audioUnlockEvents = ["pointerdown", "mousedown", "keydown", "touchstart"];
audioUnlockEvents.forEach(function (type) {
  document.addEventListener(type, initAudio, { once: false, passive: true });
});

audioToggle.addEventListener("click", function (event) {
  event.stopPropagation();
  initAudio();
  toggleAudio();
});

document.getElementById("endlessModeButton")
  .addEventListener("click", initAudio);
document.getElementById("levelModeButton").addEventListener("click", initAudio);

document.addEventListener("keydown", function (event) {
  if (event.code === "KeyM") {
    initAudio();
    toggleAudio();
  }
});

document.addEventListener("keydown", function (event) {
  if (event.code === "Escape") {
    if (gameState === "失败" || gameState === "通关") {
      showModeMenu();
    }
  }
});

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

const weaponHotkeyOrder = ["机枪", "手枪", "狙击枪", "匕首", "火箭弹"];

function selectWeaponByHotkey(index) {
  if (gameState !== "战斗") return;
  const name = weaponHotkeyOrder[index];
  if (!name || name === currentWeapon) return;
  setCurrentWeapon(name, false);
}

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

  const weaponHotkeyIndex = [
    "Digit1", "Digit2", "Digit3", "Digit4", "Digit5"
  ].indexOf(event.code);
  if (weaponHotkeyIndex >= 0) {
    event.preventDefault();
    selectWeaponByHotkey(weaponHotkeyIndex);
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

  if (event.code === "KeyE") {
    if (
      gameState === "战斗" &&
      document.pointerLockElement === renderer.domElement
    ) {
      const profile = weaponProfiles[currentWeapon];
      const ammo = profile.usesAmmo ? getWeaponAmmo(currentWeapon) : null;
      if (profile.usesAmmo && ammo.magazine === 0) {
        if (!startReload(true) && ammo.reserve <= 0) {
          showPickupNotice("备弹已耗尽：寻找蓝色弹药包");
        }
      } else {
        showPickupNotice("弹匣未空，无需紧急换弹");
      }
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

  // 真·暂停：暂停屏显示期间冻结全部模拟（玩家、弹道、敌人 AI 与重生、
  // 补给刷新、换弹、连杀计时与两条倒计时读数），只重绘当前静态帧；
  // 挂钟型重生计时器在恢复时经 shiftRespawnTimersBy 补偿暂停时长。
  if (isGamePaused()) {
    renderer.render(scene, camera);
    return;
  }

  // 存活时间：只按有效战斗帧累加（真·暂停已在上方整帧冻结；结算 / 菜单
  // 状态不计入）；关卡模式跨关累计，与累计分数口径一致。
  if (gameState === "战斗") survivalSeconds += delta;

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
  updateDamageNumbers(delta);
  sfxStatsTimer -= delta;
  if (sfxStatsTimer <= 0) {
    sfxStatsTimer = 0.25;
    updateSfxCountUI();
  }
  renderer.render(scene, camera);
}

// 初始化待命场景并显示模式选择。
clearMap();
buildEndlessMap();
rebuildMinimapStatic();
drawEndlessMapPreviews();
camera.position.set(0, player.eyeHeight, 29);
loadBestScore();
updateBestScoreUI();
setKillStreak(0);
updateHealthUI();
updateGameInfo();
loadingScreen.classList.add("hidden");
modeScreen.classList.remove("hidden");
animate();


// Manual FPS presentation dressing. This file belongs only to visual-tiered demos.
(function () {
  const tier = 1;
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

