"use strict";

// -----------------------------------------------------------------------
// 射击、命中特效和击杀结算
// -----------------------------------------------------------------------
const sparkGeometry = new THREE.SphereGeometry(0.035, 6, 4);

function spawnImpact(position, normal, hitEnemy) {
  const color = hitEnemy ? 0xff4a24 : 0xffc24a;
  const group = new THREE.Group();
  group.position.copy(position).addScaledVector(normal, 0.025);
  scene.add(group);

  const material = new THREE.MeshBasicMaterial({
    color: color,
    transparent: true,
    opacity: 1,
    blending: THREE.AdditiveBlending,
    depthWrite: false
  });

  const particles = [];
  for (let i = 0; i < 8; i++) {
    const spark = new THREE.Mesh(sparkGeometry, material);
    const direction = new THREE.Vector3(
      THREE.MathUtils.randFloatSpread(1),
      Math.random() * 0.85,
      THREE.MathUtils.randFloatSpread(1)
    ).normalize();
    direction.addScaledVector(normal, 1.4).normalize();
    spark.userData.velocity = direction.multiplyScalar(
      THREE.MathUtils.randFloat(1.8, 5)
    );
    group.add(spark);
    particles.push(spark);
  }

  const light = new THREE.PointLight(color, 6, 3.5, 2);
  group.add(light);

  effects.push({
    group: group,
    material: material,
    particles: particles,
    light: light,
    age: 0,
    lifetime: 0.34
  });
}

function updateEffects(delta) {
  for (let i = effects.length - 1; i >= 0; i--) {
    const effect = effects[i];
    effect.age += delta;
    const life = 1 - effect.age / effect.lifetime;

    for (const particle of effect.particles) {
      particle.position.addScaledVector(particle.userData.velocity, delta);
      particle.userData.velocity.y -= 8 * delta;
      particle.scale.setScalar(Math.max(0.01, life));
    }

    effect.material.opacity = Math.max(0, life);
    effect.light.intensity = Math.max(0, life * 6);

    if (effect.age >= effect.lifetime) {
      scene.remove(effect.group);
      effect.material.dispose();
      effects.splice(i, 1);
    }
  }
}

// -----------------------------------------------------------------------
// 敌人枪口曳光：敌人每次开火（命中或偏射）从枪口到弹着点画一条快速衰减
// 的细光束，让"哪一枪从哪个方向来、打在哪"一眼可读——与空间化枪声、受击
// 方向弧线互补。纯反馈层：不参与命中判定、伤害、计分与重生；由主循环
// updateEnemyTracers 驱动，真·暂停随帧冻结；死亡当帧、重开、过关与返回
// 菜单经 clearEnemyTracers() 统一清除，无残留。圆柱几何全池共享（不随
// 单枚释放），材质逐枚克隆以独立控制不透明度。
// -----------------------------------------------------------------------
const ENEMY_TRACER_LIFETIME = 0.13;   // 全生命周期（秒）：亮起 + 淡出
const ENEMY_TRACER_FADE = 0.05;       // 尾部淡出时长
const ENEMY_TRACER_BASE_OPACITY = 0.78;
const ENEMY_TRACER_POOL_MAX = 14;     // 在场上限：多敌同射也不无限追加
const enemyTracerGeometry = new THREE.CylinderGeometry(
  0.024, 0.024, 1, 5, 1, true);
const enemyTracerUpAxis = new THREE.Vector3(0, 1, 0);
let enemyTracers = [];

function spawnEnemyTracer(from, to) {
  const direction = new THREE.Vector3().subVectors(to, from);
  const length = direction.length();
  if (length < 0.05) return;
  direction.multiplyScalar(1 / length);

  // 上限保护：满池时替换最老的一枚（连射场景下保证新弹道可见）。
  if (enemyTracers.length >= ENEMY_TRACER_POOL_MAX) {
    let oldestIndex = 0;
    for (let i = 1; i < enemyTracers.length; i++) {
      if (enemyTracers[i].age > enemyTracers[oldestIndex].age) {
        oldestIndex = i;
      }
    }
    const oldest = enemyTracers[oldestIndex];
    scene.remove(oldest.mesh);
    oldest.material.dispose();
    enemyTracers.splice(oldestIndex, 1);
  }

  const material = new THREE.MeshBasicMaterial({
    color: 0xffa94d,
    transparent: true,
    opacity: ENEMY_TRACER_BASE_OPACITY,
    blending: THREE.AdditiveBlending,
    depthWrite: false
  });
  const mesh = new THREE.Mesh(enemyTracerGeometry, material);
  mesh.position.copy(from).addScaledVector(direction, length / 2);
  mesh.scale.set(1, length, 1);
  mesh.quaternion.setFromUnitVectors(enemyTracerUpAxis, direction);
  scene.add(mesh);
  enemyTracers.push({
    mesh: mesh,
    material: material,
    age: 0,
    from: from.clone(),
    to: to.clone()
  });
}

function updateEnemyTracers(delta) {
  for (let i = enemyTracers.length - 1; i >= 0; i--) {
    const tracer = enemyTracers[i];
    tracer.age += delta;
    const remaining = ENEMY_TRACER_LIFETIME - tracer.age;
    // 前段保持满亮，最后 ENEMY_TRACER_FADE 秒线性淡出。
    tracer.material.opacity = remaining > ENEMY_TRACER_FADE
      ? ENEMY_TRACER_BASE_OPACITY
      : Math.max(0, remaining / ENEMY_TRACER_FADE) *
        ENEMY_TRACER_BASE_OPACITY;
    if (tracer.age >= ENEMY_TRACER_LIFETIME) {
      scene.remove(tracer.mesh);
      tracer.material.dispose();
      enemyTracers.splice(i, 1);
    }
  }
}

function clearEnemyTracers() {
  for (const tracer of enemyTracers) {
    scene.remove(tracer.mesh);
    tracer.material.dispose();
  }
  enemyTracers.length = 0;
}

function findEnemyFromObject(object) {
  let current = object;
  while (current) {
    if (current.userData && current.userData.enemy) {
      return current.userData.enemy;
    }
    current = current.parent;
  }
  return null;
}

const projectileRaycaster = new THREE.Raycaster();
const projectileDirection = new THREE.Vector3();
const projectileStep = new THREE.Vector3();
const projectileMetalMaterial = new THREE.MeshStandardMaterial({
  color: 0xc9d3d8, roughness: 0.28, metalness: 0.82
});
const rocketBodyMaterial = new THREE.MeshStandardMaterial({
  color: 0x4c6550, roughness: 0.58, metalness: 0.38
});

// -----------------------------------------------------------------------
// 连杀反馈与战斗信息流
// -----------------------------------------------------------------------
function registerCombatLog(message, kind) {
  if (!combatLog) return;

  const entry = document.createElement("div");
  entry.className = "combat-log-entry" + (kind ? " " + kind : "");
  entry.textContent = message;
  combatLog.appendChild(entry);

  requestAnimationFrame(function () {
    entry.classList.add("visible");
  });

  combatLogEntries.push({
    element: entry,
    remaining: COMBAT_LOG_TTL
  });

  while (combatLogEntries.length > MAX_COMBAT_LOG_ENTRIES) {
    const oldest = combatLogEntries.shift();
    if (oldest.element && oldest.element.parentNode === combatLog) {
      combatLog.removeChild(oldest.element);
    }
  }
}

function setKillStreak(count) {
  killStreakCount = count;
  if (count > highestKillStreak) highestKillStreak = count;

  const multiplier = (1 + Math.min(count, 10) * 0.1).toFixed(1);
  streakText.textContent = "x" + multiplier + "（" + count + " 连杀）";
  streakText.classList.toggle("streak-hot", count >= 3 && count < 5);
  streakText.classList.toggle("streak-blazing", count >= 5);
  // 窗口倒计时条：无连杀隐藏；层级配色与 streakText 同步。
  streakTrack.classList.toggle("hidden", count === 0);
  streakTrack.classList.toggle("streak-hot", count >= 3 && count < 5);
  streakTrack.classList.toggle("streak-blazing", count >= 5);
  if (count === 0) streakTrack.classList.remove("streak-critical");

  if (count >= 2) {
    registerCombatLog("连杀 x" + count + "　伤害加成 +" +
      Math.round((Math.min(count, 10) * 10)) + "%", "streak");
  }
  if (window.SFX) window.SFX.streakFeedback(Boolean(count >= 3), Boolean(count >= 5));
}

function registerKillStreak() {
  killStreakTimer = STREAK_WINDOW;
  setKillStreak(killStreakCount + 1);
}

function updateStreakTrack() {
  if (!streakTrack) return;
  if (killStreakCount <= 0 || killStreakTimer <= 0) {
    streakTrack.classList.add("hidden");
    streakTrack.classList.remove("streak-critical");
    return;
  }
  const fraction = Math.max(0, Math.min(1, killStreakTimer / STREAK_WINDOW));
  streakTrackFill.style.width = (fraction * 100).toFixed(1) + "%";
  streakTrackLabel.textContent = killStreakTimer.toFixed(1) + "s";
  streakTrack.classList.toggle("streak-critical", killStreakTimer <= 1);
}

function resetKillStreak(showNotice) {
  if (killStreakCount === 0) return;

  const finalStreak = killStreakCount;
  killStreakCount = 0;
  killStreakTimer = 0;
  setKillStreak(0);

  if (showNotice && finalStreak >= 2) {
    const bonus = Math.max(STREAK_RESET_SCORE, Math.round(score * 0.06));
    score += bonus;
    registerCombatLog("连杀结束（" + finalStreak + " 连杀）　加成 +" + bonus, "streak");
  }
}

function clearCombatLog() {
  for (const item of combatLogEntries) {
    if (item.element && item.element.parentNode === combatLog) {
      combatLog.removeChild(item.element);
    }
  }
  combatLogEntries.length = 0;
  combatLog.innerHTML = "";
}

// -----------------------------------------------------------------------
// 击杀播报（kill feed）：左上角逐次播报“击杀武器 + 得分 + 爆头徽章”。
// 得分与 killEnemy 写入 HUD 的累计分数完全同源（100 × 当前威胁等级）；
// 武器取致死一击的来源（hitscan / 近战取 currentWeapon，火箭弹等延迟
// 命中的弹道在发射时记录武器名，落点结算不随玩家切枪漂移）。纯视觉层：
// 不进入命中判定与计分逻辑；真·暂停期间 updateVisualUI 不执行，条目
// 倒计时随之冻结；死亡重开与返回菜单经 clearKillFeed() 整列清除，
// 不残留进下一局。
// -----------------------------------------------------------------------
const KILL_FEED_TTL = 4.2;
const KILL_FEED_FADE = 0.6;
const KILL_FEED_MAX = 5;
let killFeedEntries = [];

function registerKillFeed(weaponName, scoreGained, headshot) {
  if (!killFeed) return;

  const entry = document.createElement("div");
  entry.className = "kill-feed-entry" + (headshot ? " headshot" : "");

  const weaponSpan = document.createElement("span");
  weaponSpan.className = "kill-feed-weapon";
  weaponSpan.textContent = weaponName || "未知武器";

  const badge = document.createElement("span");
  badge.className = "kill-feed-badge";
  badge.textContent = "爆头";
  badge.style.display = headshot ? "" : "none";

  const scoreSpan = document.createElement("span");
  scoreSpan.className = "kill-feed-score";
  scoreSpan.textContent = "+" + scoreGained;

  entry.appendChild(weaponSpan);
  entry.appendChild(badge);
  entry.appendChild(scoreSpan);

  // 最新一条置顶：新条目插到列首，旧条目依次下移。
  killFeed.insertBefore(entry, killFeed.firstChild);

  requestAnimationFrame(function () {
    entry.classList.add("visible");
  });

  killFeedEntries.push({ element: entry, remaining: KILL_FEED_TTL, fading: false });

  while (killFeedEntries.length > KILL_FEED_MAX) {
    const oldest = killFeedEntries.shift();
    if (oldest.element && oldest.element.parentNode === killFeed) {
      killFeed.removeChild(oldest.element);
    }
  }
}

function updateKillFeed(delta) {
  for (let i = killFeedEntries.length - 1; i >= 0; i--) {
    const entry = killFeedEntries[i];
    entry.remaining -= delta;
    if (entry.remaining <= 0) {
      if (entry.element.parentNode === killFeed) killFeed.removeChild(entry.element);
      killFeedEntries.splice(i, 1);
    } else if (entry.remaining <= KILL_FEED_FADE && !entry.fading) {
      entry.fading = true;
      entry.element.classList.add("leaving");
    }
  }
}

function clearKillFeed() {
  for (const entry of killFeedEntries) {
    if (entry.element && entry.element.parentNode === killFeed) {
      killFeed.removeChild(entry.element);
    }
  }
  killFeedEntries.length = 0;
}

function recordDamageTaken(amount) {
  const now = performance.now() / 1000;
  recentDamage.push({ amount: amount, at: now });
}

// -----------------------------------------------------------------------
// 命中反馈升级：部位伤害标签（爆头 / 躯干 / 四肢）与威胁方位指示
// -----------------------------------------------------------------------
// 命中部位判定：由敌人部件自带的 userData.hitZone 标记决定，
// 未标记的部件（枪械、背包等）按躯干结算，不改变既有伤害。
function classifyHitZone(hit) {
  if (!hit || !hit.object || !hit.object.userData) return "torso";
  return hit.object.userData.hitZone || "torso";
}

// 瞄准反馈参数：准星最大张开量与“弹道不可靠”变色阈值（px）。
const CROSSHAIR_BLOOM_MAX = 9;
const CROSSHAIR_BLOOM_WARN = 5.5;
const HIT_MARKER_TTL = 0.24;

// 准星目标距离读数：十字线射线命中活体敌人时，在准星下方显示到命中点
// 的实际距离，并按距离带分色（近程绿 / 中程金 / 远程红），让玩家开火前
// 就能读出提前量与命中难度。12.5 Hz 游戏时基时钟驱动射线，成本与一发
// 命中扫描同量级；真·暂停整帧冻结随之冻结，暂停瞬间 / 死亡 / 重开 /
// 返回菜单由 clearTargetRange() 立即熄灭，不让旧距离残留。
const TARGET_RANGE_TICK = 0.08;
const TARGET_RANGE_FAR = 160;
const TARGET_RANGE_MID = 20;
const TARGET_RANGE_FAR_BAND = 45;
const targetRangeRaycaster = new THREE.Raycaster();
const targetRangeScreenCenter = new THREE.Vector2(0, 0);
let targetRangeTick = TARGET_RANGE_TICK;

function updateTargetRange(delta) {
  if (!targetRangeLabel) return;
  // 仅真实战斗且指针锁定时刷新；结算 / 菜单 / 过关状态由 clear 路径熄灭，
  // 真·暂停的整帧冻结由主循环统一处理，这里不再重复判断。
  if (gameState !== "战斗" ||
      document.pointerLockElement !== renderer.domElement) return;

  targetRangeTick -= delta;
  if (targetRangeTick > 0) return;
  targetRangeTick = TARGET_RANGE_TICK;

  targetRangeRaycaster.setFromCamera(targetRangeScreenCenter, camera);
  targetRangeRaycaster.far = TARGET_RANGE_FAR;
  const targets = raycastWorld.slice();
  for (const enemy of enemies) {
    if (enemy.alive) targets.push.apply(targets, enemy.hitMeshes);
  }
  const hits = targetRangeRaycaster.intersectObjects(targets, false);
  const enemy = hits.length ? findEnemyFromObject(hits[0].object) : null;
  if (hits.length && enemy && enemy.alive) {
    const distance = camera.position.distanceTo(hits[0].point);
    targetRangeLabel.textContent = distance.toFixed(1) + " m";
    targetRangeLabel.className = distance > TARGET_RANGE_FAR_BAND
      ? "range-far"
      : distance > TARGET_RANGE_MID ? "range-mid" : "";
    targetRangeLabel.style.opacity = "1";
  } else if (targetRangeLabel.style.opacity !== "0") {
    targetRangeLabel.style.opacity = "0";
  }
}

function clearTargetRange() {
  targetRangeTick = TARGET_RANGE_TICK;
  if (!targetRangeLabel) return;
  targetRangeLabel.style.opacity = "0";
  targetRangeLabel.textContent = "";
  targetRangeLabel.className = "";
}

function registerHitFeedback(hit, enemy) {
  if (window.SFX) window.SFX.hit(hit && hit.zone);
  const zone = classifyHitZone(hit);
  const label = hitZoneLabel;
  if (label) {
    label.className = zone === "head"
      ? "zone-head"
      : zone === "limb" ? "zone-limb" : "";
    label.textContent = zone === "head"
      ? "爆头 ×" + HIT_ZONE_MULTIPLIERS.head.toFixed(2).replace(/0$/, "")
      : zone === "limb" ? "四肢命中" : "";
    hitZoneLabelTimer = zone === "torso" ? 0 : HIT_ZONE_LABEL_TTL;
  }
  hitFlash = 0.12;
}

// 爆头击杀：结算日志与 HUD 计数。
function registerHeadshotKill() {
  hitZoneHeadshotKills++;
  updateHeadshotUI();
  registerCombatLog("爆头击杀 ×" + hitZoneHeadshotKills, "streak");
}

// -----------------------------------------------------------------------
// 命中伤害数字：世界坐标 -> 屏幕坐标的漂浮数值反馈
// -----------------------------------------------------------------------
function createDamageNumberElement() {
  const element = document.createElement("div");
  element.className = "damage-number";
  damageNumbersHost.appendChild(element);
  return element;
}

function acquireDamageNumber() {
  // 优先复用已到期的节点，避免长时间交火时无限追加 DOM。
  for (const entry of damageNumbers) {
    if (entry.life <= 0) return entry;
  }
  if (damageNumbers.length < DAMAGE_NUMBER_POOL_MAX) {
    const entry = {
      element: createDamageNumberElement(),
      position: new THREE.Vector3(),
      offset: 0,
      life: 0,
      ttl: DAMAGE_NUMBER_TTL
    };
    damageNumbers.push(entry);
    return entry;
  }
  // 池已满：抢占生命周期最短的节点。
  let victim = damageNumbers[0];
  for (const entry of damageNumbers) {
    if (entry.life < victim.life) victim = entry;
  }
  return victim;
}

function spawnDamageNumber(position, amount, zone, lethal) {
  if (!damageNumbersHost) return;
  const entry = acquireDamageNumber();
  entry.position.copy(position);
  entry.position.y += 1.35 + Math.random() * 0.25;
  entry.offset = Math.random() * Math.PI * 2;
  entry.ttl = lethal ? 1.15 : DAMAGE_NUMBER_TTL;
  entry.life = entry.ttl;
  entry.element.className =
    "damage-number visible" +
    (zone === "head" ? " zone-head" : "") +
    (zone === "limb" ? " zone-limb" : "") +
    (lethal ? " zone-kill" : "");
  entry.element.textContent = lethal
    ? "-" + Math.round(amount) + " 击杀"
    : "-" + Math.round(amount);
}

// 每帧把仍存活的伤害数字投影到屏幕上，并做上浮与淡出。
function updateDamageNumbers(delta) {
  if (!damageNumbersHost || damageNumbers.length === 0) return;
  const width = damageNumbersHost.clientWidth || window.innerWidth;
  const height = damageNumbersHost.clientHeight || window.innerHeight;

  for (const entry of damageNumbers) {
    if (entry.life <= 0) {
      if (entry.element.style.opacity !== "0") {
        entry.element.style.opacity = "0";
      }
      continue;
    }

    entry.life -= delta;
    const progress = 1 - Math.max(0, entry.life) / entry.ttl;
    tempVector.copy(entry.position);
    tempVector.y += progress * 0.95;
    tempVector.project(camera);

    const behindCamera = tempVector.z > 1;
    if (behindCamera || tempVector.x < -1.25 || tempVector.x > 1.25 ||
        tempVector.y < -1.25 || tempVector.y > 1.25) {
      entry.element.style.opacity = "0";
      continue;
    }

    const sway = Math.sin((entry.offset + progress * 2.4)) * 16 * progress;
    const x = (tempVector.x * 0.5 + 0.5) * width + sway;
    const y = (-tempVector.y * 0.5 + 0.5) * height;

    entry.element.style.transform =
      "translate(-50%, -50%) translate(" + x.toFixed(1) + "px, " +
      y.toFixed(1) + "px)";
    entry.element.style.opacity =
      progress < 0.55 ? "1" : String(Math.max(0, 1 - (progress - 0.55) / 0.45));
    if (entry.life <= 0) entry.element.style.opacity = "0";
  }
}

function clearDamageNumbers() {
  for (const entry of damageNumbers) {
    entry.life = 0;
    if (entry.element) entry.element.style.opacity = "0";
  }
}

// -----------------------------------------------------------------------
// 击杀得分漂浮：击杀点世界坐标 -> 屏幕“+得分”漂浮数值。数值与本帧写入
// 累计分数的 killScore 完全同源（100 × 当前威胁等级），爆头击杀加金色
// 徽章，与击杀播报的爆头徽章同色。纯反馈层：不参与命中判定、伤害、计分
// 与连杀结算；由主循环逐帧驱动，真·暂停随帧冻结，返回菜单统一熄灭，
// 其余状态（结算 / 重开）按 TTL 自然淡出，无跨局残留。
// -----------------------------------------------------------------------
const scoreNumberWorld = new THREE.Vector3();

function createScoreNumberElement() {
  const element = document.createElement("div");
  element.className = "score-number";
  scoreNumbersHost.appendChild(element);
  return element;
}

function acquireScoreNumber() {
  // 优先复用已到期的节点，避免长时间交火时无限追加 DOM。
  for (const entry of scoreNumbers) {
    if (entry.life <= 0) return entry;
  }
  if (scoreNumbers.length < SCORE_NUMBER_POOL_MAX) {
    const entry = {
      element: createScoreNumberElement(),
      position: new THREE.Vector3(),
      offset: 0,
      life: 0,
      ttl: SCORE_NUMBER_TTL
    };
    scoreNumbers.push(entry);
    return entry;
  }
  // 池已满：抢占生命周期最短的节点。
  let victim = scoreNumbers[0];
  for (const entry of scoreNumbers) {
    if (entry.life < victim.life) victim = entry;
  }
  return victim;
}

function spawnScoreNumber(position, amount, headshot) {
  if (!scoreNumbersHost) return;
  const entry = acquireScoreNumber();
  entry.position.copy(position);
  entry.position.y += 0.55 + Math.random() * 0.2;
  entry.offset = THREE.MathUtils.randFloatSpread(20);
  entry.ttl = SCORE_NUMBER_TTL;
  entry.life = entry.ttl;
  entry.element.className =
    "score-number visible" + (headshot ? " score-head" : "");
  entry.element.textContent =
    "+" + Math.round(amount) + (headshot ? " 爆头" : "");
}

// 每帧把仍存活的得分数值投影到屏幕上，并做上浮与淡出。
function updateScoreNumbers(delta) {
  if (!scoreNumbersHost || scoreNumbers.length === 0) return;
  const width = scoreNumbersHost.clientWidth || window.innerWidth;
  const height = scoreNumbersHost.clientHeight || window.innerHeight;

  for (const entry of scoreNumbers) {
    if (entry.life <= 0) {
      if (entry.element.style.opacity !== "0") {
        entry.element.style.opacity = "0";
      }
      continue;
    }

    entry.life -= delta;
    const progress = 1 - Math.max(0, entry.life) / entry.ttl;
    scoreNumberWorld.copy(entry.position);
    scoreNumberWorld.y += progress * 0.85;
    scoreNumberWorld.project(camera);

    const behindCamera = scoreNumberWorld.z > 1;
    if (behindCamera || scoreNumberWorld.x < -1.25 || scoreNumberWorld.x > 1.25 ||
        scoreNumberWorld.y < -1.25 || scoreNumberWorld.y > 1.25) {
      entry.element.style.opacity = "0";
      continue;
    }

    const x = (scoreNumberWorld.x * 0.5 + 0.5) * width + entry.offset;
    const y = (-scoreNumberWorld.y * 0.5 + 0.5) * height;

    entry.element.style.transform =
      "translate(-50%, -50%) translate(" + x.toFixed(1) + "px, " +
      y.toFixed(1) + "px)";
    entry.element.style.opacity =
      progress < 0.5 ? "1" : String(Math.max(0, 1 - (progress - 0.5) / 0.5));
    if (entry.life <= 0) entry.element.style.opacity = "0";
  }
}

function clearScoreNumbers() {
  for (const entry of scoreNumbers) {
    entry.life = 0;
    if (entry.element) entry.element.style.opacity = "0";
  }
}

// -----------------------------------------------------------------------
// 受击伤害数值：被敌人枪弹或近战命中时，屏幕中下方（准星下方安全区）浮现
// 一枚红色数值，显示本聚合窗口内实际受到的伤害（如 -8），让玩家不看右侧
// 读数也能立刻判断这一击的代价、是否该撤退找血包。
// 与伤害数字（锚定敌人世界坐标）不同，受击数值锚定屏幕本身：盲区方向
// 受到的伤害同样可见，且不会飘到屏幕外。
// 近战是逐帧连续 tick（damagePlayer(damage * delta)），若逐帧生成会刷屏，
// 因此按 DAMAGE_TAKEN_WINDOW 秒窗口聚合：窗口累计 ≥ 1 才生成一枚数值，
// 数值为窗口内真实伤害之和（四舍五入），每窗口至多一枚。
// 纯反馈层：不参与命中判定、伤害、计分与连杀结算；由主循环每帧驱动
// （updateDamageTakenNumbers），真·暂停时整帧冻结（不推进也不淡出）。
// -----------------------------------------------------------------------
function createDamageTakenNumberElement() {
  const element = document.createElement("div");
  element.className = "damage-taken-number";
  damageTakenNumbersHost.appendChild(element);
  return element;
}

function acquireDamageTakenNumber() {
  // 优先复用已到期的节点，避免长时间受击时无限追加 DOM。
  for (const entry of damageTakenNumbers) {
    if (entry.life <= 0) return entry;
  }
  if (damageTakenNumbers.length < DAMAGE_TAKEN_NUMBER_POOL_MAX) {
    const entry = {
      element: createDamageTakenNumberElement(),
      xOffset: 0,
      life: 0,
      ttl: DAMAGE_TAKEN_NUMBER_TTL
    };
    damageTakenNumbers.push(entry);
    return entry;
  }
  // 池已满：抢占生命周期最短的节点。
  let victim = damageTakenNumbers[0];
  for (const entry of damageTakenNumbers) {
    if (entry.life < victim.life) victim = entry;
  }
  return victim;
}

function spawnDamageTakenNumber(amount) {
  if (!damageTakenNumbersHost) return;
  const entry = acquireDamageTakenNumber();
  entry.ttl = DAMAGE_TAKEN_NUMBER_TTL;
  entry.life = entry.ttl;
  // 水平散布 ±90px（准星下方安全区），避免多枚数值完全重叠。
  entry.xOffset = (Math.random() * 2 - 1) * 90;
  entry.element.className = "damage-taken-number";
  entry.element.textContent = "-" + Math.round(amount);
}

// 每帧推进聚合窗口与在场数值（上浮 + 淡出）；真·暂停时本函数不被调用，
// 窗口时钟与在场数值随之整帧冻结。
function updateDamageTakenNumbers(delta) {
  if (!damageTakenNumbersHost) return;
  if (gameState !== "战斗") return;

  if (damageTakenWindowTimer > 0) {
    damageTakenWindowTimer = Math.max(0, damageTakenWindowTimer - delta);
  }
  if (damageTakenPending >= 1 && damageTakenWindowTimer <= 0) {
    spawnDamageTakenNumber(damageTakenPending);
    damageTakenPending = 0;
    damageTakenWindowTimer = DAMAGE_TAKEN_WINDOW;
  }

  if (damageTakenNumbers.length === 0) return;
  const width = damageTakenNumbersHost.clientWidth || window.innerWidth;
  const height = damageTakenNumbersHost.clientHeight || window.innerHeight;

  for (const entry of damageTakenNumbers) {
    if (entry.life <= 0) {
      if (entry.element.style.opacity !== "0") {
        entry.element.style.opacity = "0";
      }
      continue;
    }

    entry.life -= delta;
    const progress = 1 - Math.max(0, entry.life) / entry.ttl;
    const x = width * 0.5 + entry.xOffset;
    const y = height * 0.635 - progress * 46;
    entry.element.style.transform =
      "translate(-50%, -50%) translate(" + x.toFixed(1) + "px, " +
      y.toFixed(1) + "px)";
    entry.element.style.opacity =
      progress < 0.5 ? "1" : String(Math.max(0, 1 - (progress - 0.5) / 0.5));
    if (entry.life <= 0) entry.element.style.opacity = "0";
  }
}

// 死亡当帧 / 重开 / 返回菜单 / 过关结算统一调用：清空在场数值与窗口累计，
// 保证结算界面与新一局不受旧数值干扰。
function clearDamageTakenNumbers() {
  damageTakenPending = 0;
  damageTakenWindowTimer = 0;
  for (const entry of damageTakenNumbers) {
    entry.life = 0;
    if (entry.element) entry.element.style.opacity = "0";
  }
}

// -----------------------------------------------------------------------
// 威胁等级进度条：无尽模式实时显示“距离下一次威胁等级”的百分比进度。
// 之前威胁等级只以一个裸数字出现，玩家无法判断下一级还有多远；
// 这里用与任务进度条相同的视觉语言把等级推进做成可见反馈，
// 并在等级提升瞬间闪烁高亮、在信息流中播报一次新等级的实际参数。
// -----------------------------------------------------------------------
function updateThreatTierBar() {
  if (!threatTrack || !threatTrackFill || !threatTrackLabel) return;

  if (selectedMode !== "无尽") {
    threatTrack.classList.add("hidden");
    threatTierShown = 1;
    threatTierFlashTimer = 0;
    threatTrack.classList.remove("tier-up");
    return;
  }

  const stats = getDifficultyStats();
  const tier = stats.tier;
  const scoreIntoTier = score % SCORE_MILESTONE;

  if (tier > threatTierShown) {
    // 等级跃迁：点亮高亮并在战斗信息流中播报一次（同一等级只播报一次）。
    threatTierFlashTimer = THREAT_TIER_FLASH_TTL;
    threatTrack.classList.add("tier-up");
    if (window.SFX) window.SFX.streak(tier);
    registerCombatLog(
      "威胁等级 " + tier + "：敌兵生命 " + stats.health + " · 伤害 " +
      stats.damage.toFixed(1) + " · 同屏 " + stats.maxActive + " 人",
      "streak"
    );
  }
  threatTierShown = tier;

  threatTrack.classList.remove("hidden");
  threatTrackFill.style.width =
    ((scoreIntoTier / SCORE_MILESTONE) * 100).toFixed(1) + "%";
  threatTrackLabel.textContent =
    "威胁等级 " + tier + "　距离下一级 " + (SCORE_MILESTONE - scoreIntoTier) + " 分";
}

// -----------------------------------------------------------------------
// 最佳纪录追踪：无尽模式实时显示“本局分数 → 历史最佳”的推进与结果。
// 玩家第一次得分时快照历史最佳，跨过快照的那一刻播放一次“破纪录”庆祝，
// 之后追踪条切换为领先形态，结算界面给出本次对局与历史最佳的对照。
// -----------------------------------------------------------------------
function updateRecordTrack() {
  if (!recordTrack || !recordTrackFill || !recordTrackLabel) return;

  if (selectedMode !== "无尽") {
    recordTrack.classList.add("hidden");
    return;
  }

  const hasRecord = runBestScoreAtStart > 0;
  if (!hasRecord) {
    // 没有历史纪录可追：本局任何分数都是新纪录，追踪条直接显示领先形态。
    recordTrack.classList.remove("hidden");
    recordTrack.classList.add("record-broken");
    recordTrackFill.style.width = "100%";
    recordTrackLabel.textContent = "首局作战　领先纪录 " + score + " 分";
    return;
  }

  const target = Math.max(1, runBestScoreAtStart);
  const fraction = Math.min(1, score / target);
  const remaining = Math.max(0, runBestScoreAtStart - score);

  if (!runRecordBroken && score > runBestScoreAtStart) {
    // 跨过历史最佳：一次性庆祝（高亮 + 信息流播报 + 提示音）。
    runRecordBroken = true;
    recordTrackFlashTimer = RECORD_TRACK_FLASH_TTL;
    recordTrack.classList.add("record-broken", "record-flash");
    if (window.SFX) window.SFX.levelClear();
    registerCombatLog("🏆 刷新历史最佳！超越 " + runBestScoreAtStart +
      " 分　保持火力！", "streak");
  }

  recordTrack.classList.remove("hidden");
  recordTrackFill.style.width = (fraction * 100).toFixed(1) + "%";
  recordTrackLabel.textContent = runRecordBroken
    ? "已破纪录　领先 " + (score - runBestScoreAtStart) + " 分"
    : "距最佳纪录还差 " + remaining + " 分　当前 " + score;
}

function resetRecordTrackState() {
  runRecordBroken = false;
  runBestScoreAtStart = 0;
  recordTrackFlashTimer = 0;
  if (recordTrack) {
    recordTrack.classList.add("hidden");
    recordTrack.classList.remove("record-broken", "record-flash");
  }
  if (recordTrackFill) recordTrackFill.style.width = "0%";
  if (recordTrackLabel) recordTrackLabel.textContent = "最佳纪录";
}

// -----------------------------------------------------------------------
// 存活时间读数：无尽模式只有分数与威胁等级，玩家缺少最直观的进度参照；
// 主循环在有效战斗帧累加 survivalSeconds（真·暂停 / 结算 / 菜单不计入），
// HUD 每秒刷新一次 m:ss（仅秒位变化时写 DOM），结算界面给出终局时长。
// 关卡模式与累计分数同口径跨关累计，开新对局 / 返回菜单时归零。
// -----------------------------------------------------------------------
function formatSurvivalTime(seconds) {
  const total = Math.max(0, Math.floor(seconds));
  return Math.floor(total / 60) + ":" + String(total % 60).padStart(2, "0");
}

function updateSurvivalClockUI() {
  if (!survivalTimeText) return;
  const shownSecond = Math.floor(survivalSeconds);
  if (shownSecond === survivalTimeShown) return;
  survivalTimeShown = shownSecond;
  survivalTimeText.textContent = formatSurvivalTime(survivalSeconds);
}

function resetSurvivalClock() {
  survivalSeconds = 0;
  updateSurvivalClockUI();
}

// -----------------------------------------------------------------------
// 任务进度条：击杀进度即时可视化
// -----------------------------------------------------------------------
function updateMissionProgressBar() {
  if (!missionTrack || !missionTrackFill || !missionTrackLabel) return;

  let label = "";
  let fraction = 0;

  if (selectedMode === "关卡") {
    fraction = THREE.MathUtils.clamp(levelKills / LEVEL_ENEMY_TOTAL, 0, 1);
    label = "关卡进度 " + levelKills + " / " + LEVEL_ENEMY_TOTAL +
      "　剩余 " + Math.max(0, LEVEL_ENEMY_TOTAL - levelKills);
  } else if (selectedMode === "无尽") {
    fraction = (totalKills % PROGRESS_BAR_KILLS) / PROGRESS_BAR_KILLS;
    label = "下一威胁等级 " + (totalKills % PROGRESS_BAR_KILLS) + " / " +
      PROGRESS_BAR_KILLS + " 击杀　累计 " + totalKills;
  } else {
    fraction = 0;
    label = "";
  }

  missionProgressFraction = fraction;
  if (selectedMode) {
    missionTrack.classList.remove("hidden");
    missionTrackFill.style.width = (fraction * 100).toFixed(1) + "%";
    missionTrackLabel.textContent = label;
  } else {
    missionTrack.classList.add("hidden");
  }
  // 无尽模式的第二条进度条：威胁等级推进（在同一调用点保持同步刷新）。
  updateThreatTierBar();
  // 最佳纪录追踪条：与威胁等级条共用同一刷新链路（击杀结算 / 回合刷新）。
  updateRecordTrack();
}

function updateHeadshotUI() {
  const node = HUD_NODE_CACHE.headshotText;
  if (node) node.textContent = String(hitZoneHeadshotKills);
}

// -----------------------------------------------------------------------
// 射击精度遥测：实时 HUD、结算报告与里程碑播报
// -----------------------------------------------------------------------
const HUD_NODE_CACHE = {
  headshotText: document.getElementById("headshotText"),
  accuracyText: document.getElementById("accuracyText"),
  shotsText: document.getElementById("shotsText")
};

// 本局命中率（0-100 的整数百分比）。一发未射时返回 null，界面显示 “--”。
function getAccuracyPercent() {
  if (shotsFired <= 0) return null;
  return Math.round((shotsHit / shotsFired) * 100);
}

function updateAccuracyUI() {
  const accuracy = getAccuracyPercent();
  const node = HUD_NODE_CACHE.accuracyText;
  if (node) node.textContent = accuracy === null ? "--" : accuracy + "%";
  const shotsNode = HUD_NODE_CACHE.shotsText;
  if (shotsNode) shotsNode.textContent = String(shotsFired);
}

// 无尽模式里程碑：每跨过 SCORE_MILESTONE 的整数倍播报一次，避免刷屏。
function checkScoreMilestone(previousScore, currentScore) {
  if (selectedMode !== "无尽") return;
  const step = SCORE_MILESTONE;
  if (Math.floor(currentScore / step) > Math.floor(previousScore / step)) {
    const accuracy = getAccuracyPercent();
    const accuracyText = accuracy === null ? "--" : accuracy + "%";
    registerCombatLog(
      "里程碑 " + currentScore + " 分！当前命中率 " + accuracyText +
      "（发射 " + shotsFired + " / 命中 " + shotsHit + "）",
      "good"
    );
  }
}

function createThreatMarker() {
  const marker = document.createElement("div");
  marker.className = "threat-marker";
  marker.innerHTML =
    '<i class="threat-arrow"></i><span class="threat-distance"></span>';
  threatMarkersPanel.appendChild(marker);
  return {
    element: marker,
    arrow: marker.querySelector(".threat-arrow"),
    distance: marker.querySelector(".threat-distance"),
    angle: 0,
    distanceValue: 0,
    active: false
  };
}

function setThreatMarkersVisible(visible) {
  for (const marker of threatMarkers) {
    marker.active = false;
    marker.element.style.opacity = "0";
  }
  if (visible) threatMarkerTimer = 0;
}

// -----------------------------------------------------------------------
// 敌情预告读数：把下一名敌兵的抵达倒计时读给玩家。
// 数据与敌方增员逻辑共用 respawnTimers，因此读数不会撒谎；
// 3 秒内将有增员抵达时读数转入脉冲警示态，帮助玩家决定是否抢占补给。
// -----------------------------------------------------------------------
function updateIntakeReadout() {
  if (!intakeReadout || !intakeReadoutText) return;

  const seconds = typeof getNextEnemyIntakeSeconds === "function"
    ? getNextEnemyIntakeSeconds()
    : null;

  if (selectedMode !== "无尽" || seconds === null) {
    // 关卡模式与暂停/结算阶段隐藏读数，避免与任务进度信息互相干扰。
    intakeReadout.classList.add("hidden");
    intakeEscalating = false;
    intakeReadout.classList.remove("escalating");
    return;
  }

  intakeReadout.classList.remove("hidden");
  intakeReadoutText.textContent = seconds === Infinity
    ? "增援尚未排队　敌阵满编"
    : "下一名敌兵 " + seconds.toFixed(1) + " 秒后抵达";

  const escalating = seconds !== Infinity && seconds <= INTAKE_WARN_SECONDS;
  if (escalating !== intakeEscalating) {
    intakeEscalating = escalating;
    intakeReadout.classList.toggle("escalating", escalating);
  }
}

function updateThreatMarkers(delta) {
  if (!threatMarkersPanel) return;
  const active = lowHealthActive && gameState === "战斗";
  if (!active) {
    if (threatMarkers.length === 0) return;
    let stillVisible = false;
    for (const marker of threatMarkers) {
      if (marker.element.style.opacity !== "0") {
        marker.element.style.opacity = "0";
        marker.active = false;
      }
    }
    return;
  }

  threatMarkerTimer -= delta;
  if (threatMarkerTimer > 0) return;
  threatMarkerTimer = THREAT_MARKER_INTERVAL;

  const living = enemies.filter(function (enemy) {
    return enemy.alive && enemy.group.position.distanceToSquared(
      player.position) < 45 * 45;
  });
  living.sort(function (a, b) {
    return a.group.position.distanceToSquared(player.position)
      - b.group.position.distanceToSquared(player.position);
  });

  const shown = living.slice(0, THREAT_MARKER_MAX);
  let index = 0;
  for (; index < shown.length; index++) {
    const enemy = shown[index];
    let marker = threatMarkers[index];
    if (!marker) {
      marker = createThreatMarker();
      threatMarkers.push(marker);
    }
    const angle = relativeAngleTo(
      enemy.group.position.x, enemy.group.position.z);
    marker.angle = angle;
    marker.distanceValue = Math.hypot(
      enemy.group.position.x - player.position.x,
      enemy.group.position.z - player.position.z);
    marker.element.style.transform =
      "rotate(" + angle.toFixed(3) + "rad)";
    marker.distance.textContent = marker.distanceValue.toFixed(0) + "m";
    marker.element.style.opacity = "1";
    marker.active = true;
  }
  for (; index < threatMarkers.length; index++) {
    if (threatMarkers[index].element.style.opacity !== "0") {
      threatMarkers[index].element.style.opacity = "0";
    }
    threatMarkers[index].active = false;
  }
}

// -----------------------------------------------------------------------
// 补给指引：弹药耗尽（弹匣与备弹同时为空）或濒死时，屏幕边缘出现一枚
// 指向最近同类补给的箭头——青色菱形 = 弹药包、绿色十字 = 血包。数据源
// 与小地图 / 补给投放共用的 pickups 列表，方位角与威胁指示共用
// relativeAngleTo，方向不会撒谎；补给被拾取后下一拍熄灭或改指次近目标。
// 刷新节奏 0.2 秒（与威胁标记同模式）；真·暂停整帧冻结，指引随之冻结，
// 暂停瞬间 / 死亡 / 重开 / 返回菜单时熄灭（见 main.js 的复位路径）。
// -----------------------------------------------------------------------
const supplyGuides = {
  ammo: null,
  health: null
};
function bindSupplyGuide(kind, element) {
  supplyGuides[kind] = {
    element: element,
    distance: element ? element.querySelector(".supply-guide-distance") : null,
    visible: false
  };
}
bindSupplyGuide("ammo", ammoGuideElement);
bindSupplyGuide("health", healthGuideElement);

function nearestPickupOfType(type) {
  let best = null;
  let bestDistSq = Infinity;
  for (const pickup of pickups) {
    if (pickup.type !== type) continue;
    const distSq = pickup.group.position.distanceToSquared(player.position);
    if (distSq < bestDistSq) {
      bestDistSq = distSq;
      best = pickup;
    }
  }
  return best;
}

function setSupplyGuide(kind, target) {
  const guide = supplyGuides[kind];
  if (!guide || !guide.element) return;
  if (!target) {
    if (guide.visible) {
      guide.visible = false;
      guide.element.style.opacity = "0";
    }
    return;
  }
  const angle = relativeAngleTo(
    target.group.position.x, target.group.position.z);
  guide.element.style.transform = "rotate(" + angle.toFixed(3) + "rad)";
  if (guide.distance) {
    guide.distance.textContent = Math.sqrt(
      target.group.position.distanceToSquared(player.position)
    ).toFixed(0) + "m";
  }
  if (!guide.visible) {
    guide.visible = true;
    guide.element.style.opacity = "1";
  }
}

function hideSupplyGuide() {
  setSupplyGuide("ammo", null);
  setSupplyGuide("health", null);
}

function updateSupplyGuide(delta) {
  if (gameState !== "战斗") {
    hideSupplyGuide();
    return;
  }
  supplyGuideTimer -= delta;
  if (supplyGuideTimer > 0) return;
  supplyGuideTimer = SUPPLY_GUIDE_INTERVAL;

  // 弹药指引与换弹提示同口径：只看当前武器（切枪后由下一拍自愈）。
  const profile = weaponProfiles[currentWeapon];
  const ammo = profile && profile.usesAmmo ? getWeaponAmmo(currentWeapon) : null;
  const needAmmo = Boolean(ammo && ammo.magazine <= 0 && ammo.reserve <= 0);
  const needHealth = lowHealthActive && player.health > 0;

  setSupplyGuide("ammo", needAmmo ? nearestPickupOfType("弹药包") : null);
  setSupplyGuide("health", needHealth ? nearestPickupOfType("血包") : null);
}

// -----------------------------------------------------------------------
// 连杀反馈与战斗信息流
// -----------------------------------------------------------------------
// 相对玩家朝向返回 [-π, π] 的目标方位角，0 表示正前方，顺时针（屏幕右侧）为正。
// 方位角必须按视角的“右 / 前”方向分量投影后求 atan2：直接
// atan2(dx, dz) - yaw 的左右虽对、前后却是镜像，会把正前方的威胁指到屏幕下方。
function relativeAngleTo(targetX, targetZ) {
  const dx = targetX - player.position.x;
  const dz = targetZ - player.position.z;
  const screenRight = dx * Math.cos(player.yaw) - dz * Math.sin(player.yaw);
  const screenForward = -dx * Math.sin(player.yaw) - dz * Math.cos(player.yaw);
  return Math.atan2(screenRight, screenForward);
}

// -----------------------------------------------------------------------
// 受击方向指示：被击中后屏幕边缘短暂出现一段弧线，指向伤害来源在
// 命中瞬间的方位。任意血量生效（不依赖濒死威胁标记），让玩家在受到
// 火力时立即知道该往哪个方向转。连续受击会刷新停留计时；死亡、重开
// 与返回菜单时立即清除。
// -----------------------------------------------------------------------
function registerDamageDirection(source) {
  const position = source && source.group ? source.group.position : null;
  if (!position) return;
  damageDirectionAngle = relativeAngleTo(position.x, position.z);
  damageDirectionTimer = DAMAGE_DIRECTION_TTL;
  damageDirection.style.transform =
    "rotate(" + damageDirectionAngle.toFixed(3) + "rad)";
}

function updateDamageDirection(delta) {
  if (damageDirectionTimer > 0) {
    damageDirectionTimer = Math.max(0, damageDirectionTimer - delta);
  }
  if (damageDirectionTimer <= 0) {
    if (damageDirection.style.opacity !== "0") damageDirection.style.opacity = "0";
    return;
  }
  // 快速淡入、中间常亮、尾部线性淡出；opacity 由 JS 每帧驱动，
  // 与真·暂停语义一致（暂停时 updateVisualUI 整体不执行，计时冻结）。
  const elapsed = DAMAGE_DIRECTION_TTL - damageDirectionTimer;
  const opacity = Math.min(
    1,
    elapsed / DAMAGE_DIRECTION_FADE_IN,
    damageDirectionTimer / DAMAGE_DIRECTION_FADE_OUT
  );
  damageDirection.style.opacity = opacity.toFixed(3);
}

function clearDamageDirection() {
  damageDirectionTimer = 0;
  damageDirectionAngle = 0;
  damageDirection.style.opacity = "0";
}

// 濒死状态下扫描半径内敌人与可拾取物资，供方位指针与危机情报使用。
function scanDangerSurroundings() {
  let nearestEnemy = null;
  let nearestEnemyDist = Infinity;
  let nearestHealthDist = Infinity;
  let healthPickup = null;

  for (const enemy of enemies) {
    if (!enemy.alive) continue;
    const dist = Math.hypot(
      enemy.group.position.x - player.position.x,
      enemy.group.position.z - player.position.z
    );
    if (dist < nearestEnemyDist) {
      nearestEnemyDist = dist;
      nearestEnemy = enemy;
    }
  }

  // 补给被拾取后会直接从 pickups 数组移除，因此无需额外的存活标记。
  for (const pickup of pickups) {
    const dist = Math.hypot(
      pickup.group.position.x - player.position.x,
      pickup.group.position.z - player.position.z
    );
    if (dist < nearestHealthDist) {
      nearestHealthDist = dist;
      healthPickup = pickup;
    }
  }

  nearestThreatInfo = {
    enemy: nearestEnemy,
    enemyDistance: nearestEnemy === null ? null : nearestEnemyDist,
    healthPickup: healthPickup,
    healthDistance: healthPickup === null ? null : nearestHealthDist
  };
}

function setLowHealthActive(active) {
  if (lowHealthActive === Boolean(active)) return;
  if (window.SFX) window.SFX.alarm(Boolean(active));
  lowHealthActive = Boolean(active);
  dangerVignette.classList.toggle("active", lowHealthActive);
  lowHealthWarning.classList.toggle("hidden", !lowHealthActive);
  setThreatMarkersVisible(lowHealthActive);
}

function updateLowHealthWarning(delta) {
  const health = player.health;

  // 带迟滞的阈值判断：短暂受到大伤害不会立刻解除警告。
  if (!lowHealthActive) {
    if (gameState === "战斗" && health > 0 && health <= LOW_HEALTH_THRESHOLD) {
      lowHealthPeakDamage = recentDamageTotal(2.5);
      setLowHealthActive(true);
      registerCombatLog(
        "生命值危急！最近 2.5 秒受到 " + Math.round(lowHealthPeakDamage) +
        " 点伤害", "danger");
    }
  } else if (health > LOW_HEALTH_RECOVER || health <= 0 || gameState !== "战斗") {
    setLowHealthActive(false);
    if (window.SFX) window.SFX.alarm(false);
    nearestThreatInfo = null;
    return;
  }

  if (!lowHealthActive) return;

  dangerScanTimer -= delta;
  if (dangerScanTimer <= 0) {
    dangerScanTimer = DANGER_VISION_INTERVAL;
    scanDangerSurroundings();
    const threat = nearestThreatInfo;
    if (threat && threat.enemy) {
      const angle = relativeAngleTo(
        threat.enemy.group.position.x, threat.enemy.group.position.z);
      dangerArrow.textContent = "▲";
      dangerArrow.style.transform = "rotate(" + angle.toFixed(2) + "rad)";
      dangerTarget.textContent = "最近威胁 " + threat.enemyDistance.toFixed(0) + " 米";
    } else {
      dangerArrow.textContent = "◎";
      dangerArrow.style.transform = "rotate(0rad)";
      dangerTarget.textContent = "附近未见敌人";
    }
  }
}


function recentDamageTotal(windowSeconds) {
  const cutoff = performance.now() / 1000 - windowSeconds;
  let total = 0;
  let i = 0;
  while (i < recentDamage.length) {
    if (recentDamage[i].at < cutoff) {
      recentDamage.splice(i, 1);
    } else {
      total += recentDamage[i].amount;
      i++;
    }
  }
  return total;
}

function loadBestScore() {
  try {
    const stored = window.localStorage.getItem(BEST_SCORE_STORAGE_KEY);
    bestScore = stored === null ? 0 : Math.max(0, Number(stored) || 0);
  } catch (error) {
    bestScore = 0;
  }
  return bestScore;
}

function saveBestScore() {
  try {
    window.localStorage.setItem(BEST_SCORE_STORAGE_KEY, String(bestScore));
  } catch (error) {
    // 隐私模式下可能禁用存储，忽略即可，不影响游戏进行。
  }
  bestScoreText.textContent = String(bestScore);
}

function updateBestScoreUI() {
  bestScoreText.textContent = String(bestScore);
}

function commitBestScore() {
  if (score > bestScore) {
    bestScore = score;
    saveBestScore();
    return true;
  }
  return false;
}

function damageEnemy(enemy, amount, zone, weaponName) {
  if (!enemy || !enemy.alive) return;
  enemy.health -= amount;
  // 击杀播报记录致死一击的武器：每次命中都刷新（火箭弹等延迟命中按
  // 弹道发射时的武器名，不随玩家之后的切枪漂移）。
  enemy.lastHitWeapon = weaponName || currentWeapon;
  hitFlash = 0.12;
  // 被命中的敌人模型同步闪白（按敌人材质克隆驱动，见 enemies.js）。
  enemy.hitFlash = 1;
  // 每次有效命中都重放命中 X 脉冲；爆头走金色强化版本。
  hitMarkerPulse = 1;
  hitMarkerStrong = zone === "head";

  if (zone === "head") {
    hitZoneDamageDealt += Math.max(0, Math.round(amount * (HIT_ZONE_MULTIPLIERS.head - 1)));
    updateHeadshotUI();
  }

  if (enemy.health <= 0) {
    if (zone === "head") registerHeadshotKill();
    killEnemy(enemy, zone === "head");
  } else if (enemy.health <= enemy.maxHealth * 0.35 && !enemy.lowHealthWarned) {
    enemy.lowHealthWarned = true;
    registerCombatLog("目标残血 " + Math.max(1, Math.ceil(enemy.health)) +
      " HP　补一枪即可击杀");
  }
}

function createPlayerProjectile(kind, profile) {
  camera.updateMatrixWorld(true);
  const direction = camera.getWorldDirection(new THREE.Vector3()).normalize();
  const group = new THREE.Group();
  const speed = 17;
  const lifetime = 6.5;
  const body = new THREE.Mesh(
    new THREE.CylinderGeometry(0.085, 0.085, 0.72, 10),
    rocketBodyMaterial
  );
  body.rotation.x = Math.PI / 2;
  group.add(body);
  const nose = new THREE.Mesh(
    new THREE.ConeGeometry(0.09, 0.22, 10),
    projectileMetalMaterial
  );
  nose.rotation.x = -Math.PI / 2;
  nose.position.z = -0.45;
  group.add(nose);
  const flame = new THREE.PointLight(0xff7a24, 4.5, 3.2, 2);
  flame.position.z = 0.38;
  group.add(flame);

  group.quaternion.copy(camera.quaternion);
  group.position.copy(camera.position).addScaledVector(direction, 0.72);
  scene.add(group);
  playerProjectiles.push({
    kind: kind,
    group: group,
    velocity: direction.multiplyScalar(speed),
    damage: profile.damage,
    // 击杀播报：弹道发射时的武器名；落点结算时不随玩家切枪漂移。
    weapon: currentWeapon,
    lifetime: lifetime
  });
}

function removePlayerProjectile(projectile) {
  projectile.group.traverse(function (object) {
    if (object.geometry) object.geometry.dispose();
  });
  scene.remove(projectile.group);
  const index = playerProjectiles.indexOf(projectile);
  if (index >= 0) playerProjectiles.splice(index, 1);
}

function explodeRocket(position, baseDamage, weaponName) {
  if (window.SFX) window.SFX.explosion();
  const radius = 5.2;
  for (let i = 0; i < 6; i++) {
    const normal = new THREE.Vector3(
      THREE.MathUtils.randFloatSpread(1),
      Math.random() * 0.9 + 0.15,
      THREE.MathUtils.randFloatSpread(1)
    ).normalize();
    spawnImpact(position, normal, false);
  }

  let rocketHits = 0;
  for (const enemy of enemies.slice()) {
    if (!enemy.alive) continue;
    const enemyCenter = enemy.group.position.clone();
    enemyCenter.y += 1;
    const distance = enemyCenter.distanceTo(position);
    if (distance <= radius) {
      const falloff = THREE.MathUtils.clamp(1 - distance / radius, 0.25, 1);
      damageEnemy(enemy, baseDamage * falloff, "torso", weaponName);
      rocketHits++;
    }
  }

  if (rocketHits > 0) {
    shotsHit++;
    updateAccuracyUI(); // 火箭弹：爆炸波及到敌人才记一次命中
  }
  cameraShake = Math.min(0.07, cameraShake + 0.045);
}

function updatePlayerProjectiles(delta) {
  if (gameState !== "战斗") return;
  for (const projectile of playerProjectiles.slice()) {
    projectile.lifetime -= delta;
    if (projectile.lifetime <= 0) {
      if (projectile.kind === "rocket") {
        explodeRocket(projectile.group.position.clone(), projectile.damage, projectile.weapon);
      }
      removePlayerProjectile(projectile);
      continue;
    }

    projectileStep.copy(projectile.velocity).multiplyScalar(delta);
    const travelDistance = projectileStep.length();
    projectileDirection.copy(projectile.velocity).normalize();
    projectileRaycaster.set(projectile.group.position, projectileDirection);
    projectileRaycaster.near = 0;
    projectileRaycaster.far = travelDistance + 0.08;

    const targets = raycastWorld.slice();
    for (const enemy of enemies) {
      if (enemy.alive) targets.push.apply(targets, enemy.hitMeshes);
    }
    const hits = projectileRaycaster.intersectObjects(targets, false);

    if (hits.length > 0) {
      const hit = hits[0];
      const enemy = findEnemyFromObject(hit.object);
      const normal = hit.face
        ? hit.face.normal.clone().transformDirection(hit.object.matrixWorld)
        : new THREE.Vector3(0, 1, 0);

      if (projectile.kind === "rocket") {
        explodeRocket(hit.point, projectile.damage, projectile.weapon);
      } else {
        spawnImpact(hit.point, normal, Boolean(enemy && enemy.alive));
        if (enemy && enemy.alive) damageEnemy(enemy, projectile.damage, "torso", projectile.weapon);
      }
      removePlayerProjectile(projectile);
      continue;
    }

    projectile.group.position.add(projectileStep);
    if (projectile.kind === "rocket") {
      projectile.group.rotation.z += delta * 6;
    }
  }
}

// 空仓干火反馈：弹匣为空时扣扳机（含自动换弹进行中连扣）播放空膛机械
// 双响，并给第一人称枪身一次小幅点动（小于任何实弹后坐），让玩家明确
// 感知"扳机已扣下但未发射"。按住扳机时每 0.16 秒至多触发一次，防止
// 连续点击噪声刷屏；真·暂停与结算 / 菜单下 shoot() 提前返回，不会触发。
const DRY_FIRE_INTERVAL = 0.16;
const DRY_FIRE_RECOIL_KICK = 0.05;

function playDryFire() {
  const now = performance.now() / 1000;
  if (now - lastDryFireTime < DRY_FIRE_INTERVAL) return;
  lastDryFireTime = now;
  if (window.SFX) window.SFX.dryFire();
  weaponRecoil = Math.min(0.22, weaponRecoil + DRY_FIRE_RECOIL_KICK);
}

function shoot() {
  if (
    gameState !== "战斗" ||
    document.pointerLockElement !== renderer.domElement
  ) {
    return;
  }

  const profile = weaponProfiles[currentWeapon];
  const ammo = getWeaponAmmo(currentWeapon);
  if (profile.usesAmmo && ammo.magazine <= 0) {
    // 空仓：先按原有语义尝试自动换弹（已在换弹中则不重复启动；无备弹则
    // 弹回"寻找弹药包"播报），再叠加干火反馈。
    if (!reloadingWeapon && !startReload(true)) {
      const emptyNoticeTime = performance.now() / 1000;
      if (emptyNoticeTime - lastEmptyAmmoNotice > 1.2) {
        showPickupNotice("弹药耗尽：寻找蓝色弹药包");
        lastEmptyAmmoNotice = emptyNoticeTime;
      }
    }
    playDryFire();
    return;
  }
  if (reloadingWeapon) return;
  const now = performance.now() / 1000;
  if (now - lastShotTime < profile.cooldown) return;
  lastShotTime = now;
  if (profile.usesAmmo) shotsFired++; // 已确认发射：空仓与冷却期扣扳机不计入
  if (window.SFX) window.SFX.shot(currentWeapon);
  updateAccuracyUI();

  if (profile.usesAmmo) {
    ammo.magazine--;
    updateAmmoUI();
    if (ammo.magazine <= 0 && ammo.reserve > 0) startReload(false);
  }

  muzzleTimer = 0.055;
  muzzleFlash.visible = profile.flash;
  muzzleFlash.rotation.z = Math.random() * Math.PI;
  muzzleFlash.scale.set(
    THREE.MathUtils.randFloat(0.55, 0.85),
    THREE.MathUtils.randFloat(0.55, 0.85),
    THREE.MathUtils.randFloat(2.2, 3.1)
  );
  muzzleLight.intensity = profile.flash ? 10 : 0;
  weaponRecoil = Math.min(0.22, weaponRecoil + profile.recoil);
  cameraShake = Math.min(0.055, cameraShake + profile.shake);
  player.pitch = Math.min(
    Math.PI / 2 - 0.03,
    player.pitch + THREE.MathUtils.randFloat(0.002, profile.shake * 0.48 + 0.003)
  );

  if (profile.type === "rocket") {
    createPlayerProjectile(profile.type, profile);
    return;
  }

  raycaster.setFromCamera(new THREE.Vector2(0, 0), camera);
  raycaster.far = profile.range;
  const targets = raycastWorld.slice();
  for (const enemy of enemies) {
    if (enemy.alive) targets.push.apply(targets, enemy.hitMeshes);
  }

  const intersections = raycaster.intersectObjects(targets, false);
  if (intersections.length === 0) {
    updateAccuracyUI(); // 脱靶：命中率随这一发落空而下降
    return;
  }

  const hit = intersections[0];
  const enemy = findEnemyFromObject(hit.object);

  if (enemy && enemy.alive) shotsHit++; // 命中敌人才算有效命中
  updateAccuracyUI();
  const worldNormal = hit.face
    ? hit.face.normal.clone().transformDirection(hit.object.matrixWorld)
    : new THREE.Vector3(0, 1, 0);

  spawnImpact(hit.point, worldNormal, Boolean(enemy && enemy.alive));

  if (enemy && enemy.alive) {
    const zone = classifyHitZone(hit);
    const multiplier = HIT_ZONE_MULTIPLIERS[zone] || 1;
    registerHitFeedback(hit, enemy);
    const appliedDamage = profile.damage * multiplier;
    spawnDamageNumber(hit.point, appliedDamage, zone, false);
    damageEnemy(enemy, appliedDamage, zone, currentWeapon);
  }
}

function killEnemy(enemy, headshot) {
  if (!enemy.alive) return;

  enemy.alive = false;
  // 死亡当帧熄灭血条：死亡爆裂与收缩动画播放期间不再显示残条。
  if (enemy.hpBarBackground) enemy.hpBarBackground.visible = false;
  if (enemy.hpBarFill) enemy.hpBarFill.visible = false;
  // 击杀不再“瞬间消失”：模型先播放短暂原位收缩 + 橙色火花爆裂（纯视觉层）；
  // 游戏逻辑（enemies 数组、小地图、重生调度）仍在本帧按原样结算。
  spawnEnemyDeathBurst(enemy.group.position);
  beginEnemyDeathAnimation(enemy);
  const enemyIndex = enemies.indexOf(enemy);
  if (enemyIndex >= 0) enemies.splice(enemyIndex, 1);
  totalKills++;
  registerKillStreak();
  if (window.SFX) window.SFX.kill();
  if (killStreakCount >= 2 && window.SFX) window.SFX.streak(killStreakCount);

  const stats = getDifficultyStats();
  const scoreBefore = score;
  const killScore = 100 * stats.tier;
  score += killScore;
  // 击杀得分漂浮：弹出的数值与本帧写入累计分数的 killScore 完全同源。
  spawnScoreNumber(enemy.group.position, killScore, Boolean(headshot));
  // 击杀播报：武器、得分与 HUD 累计分数同源；爆头条目带金色徽章。
  registerKillFeed(enemy.lastHitWeapon || currentWeapon, killScore, Boolean(headshot));
  checkScoreMilestone(scoreBefore, score); // 无尽模式：跨过 800 分整数倍时播报

  if (selectedMode === "无尽") {
    if (score > bestScore) {
      bestScore = score;
      saveBestScore();
    }
    scheduleRespawn(stats.respawnDelay + Math.random() * 0.45);
  } else {
    levelKills++;

    if (levelKills >= LEVEL_ENEMY_TOTAL) {
      completeCurrentLevel();
    } else {
      scheduleRespawn(stats.respawnDelay + Math.random() * 0.35);
    }
  }

  updateMissionProgressBar();
  updateGameInfo();
}

// -----------------------------------------------------------------------
// 玩家生命、梯子、跳跃和移动
// -----------------------------------------------------------------------
function damagePlayer(amount, source) {
  if (gameState !== "战斗") return;

  if (window.SFX) window.SFX.hurt();
  player.health = Math.max(0, player.health - amount);
  damageFlash = Math.min(1, damageFlash + amount * 0.028);
  recordDamageTaken(amount);
  // 受击伤害数值聚合窗口累计（含近战逐帧 tick），由 updateDamageTakenNumbers 结算。
  damageTakenPending += amount;
  updateHealthUI();
  registerDamageDirection(source);

  if (player.health <= 0) {
    showGameOver();
  }
}

function updateHealthUI() {
  const health = Math.max(0, Math.ceil(player.health));
  healthText.textContent = String(health);
  healthFill.style.width = Math.max(0, player.health) + "%";

  if (player.health > 55) {
    healthFill.style.background = "linear-gradient(90deg, #38b84a, #75ea68)";
  } else if (player.health > 25) {
    healthFill.style.background = "linear-gradient(90deg, #d49b23, #f1cc43)";
  } else {
    healthFill.style.background = "linear-gradient(90deg, #a91d1d, #ef4538)";
  }
}

function findNearbyLadder() {
  for (const ladder of ladderZones) {
    if (
      player.position.x >= ladder.minX &&
      player.position.x <= ladder.maxX &&
      player.position.z >= ladder.minZ &&
      player.position.z <= ladder.maxZ &&
      player.position.y >= ladder.bottomY - 0.25 &&
      player.position.y <= ladder.topY + 0.45
    ) {
      return ladder;
    }
  }
  return null;
}

function getSupportHeight(x, z, oldY, newY) {
  let support = 0;

  for (const platform of platforms) {
    if (
      x >= platform.minX + player.radius * 0.15 &&
      x <= platform.maxX - player.radius * 0.15 &&
      z >= platform.minZ + player.radius * 0.15 &&
      z <= platform.maxZ - player.radius * 0.15 &&
      oldY >= platform.topY - 0.08 &&
      newY <= platform.topY + 0.04
    ) {
      support = Math.max(support, platform.topY);
    }
  }

  return support;
}

function findCeilingHeight(x, z, oldTop, newTop) {
  let ceiling = Infinity;

  for (const box of colliders) {
    if (
      box.minY >= oldTop - 0.04 &&
      box.minY <= newTop + 0.02 &&
      circleIntersectsBox(x, z, player.radius * 0.8, box)
    ) {
      ceiling = Math.min(ceiling, box.minY);
    }
  }

  return ceiling;
}

function updatePlayer(delta) {
  if (gameState !== "战斗") return;

  const locked = document.pointerLockElement === renderer.domElement;
  if (!locked) {
    climbHint.style.opacity = "0";
    return;
  }

  const ladder = findNearbyLadder();
  climbHint.style.opacity = ladder && locked ? "1" : "0";

  let climbInput = 0;
  if (keys.KeyW || keys.Space) climbInput += 1;
  if (keys.KeyS) climbInput -= 1;

  player.climbing = Boolean(ladder && climbInput !== 0 && locked);

  if (player.climbing) {
    player.velocityY = 0;
    player.grounded = false;
    player.position.y += climbInput * player.climbSpeed * delta;

    if (player.position.y >= ladder.topY) {
      player.position.y = ladder.topY + 0.025;
      player.position.x += ladder.exitX * 0.62;
      player.position.z += ladder.exitZ * 0.62;
      player.climbing = false;
      player.grounded = true;
    } else if (player.position.y <= ladder.bottomY) {
      player.position.y = ladder.bottomY;
      player.climbing = false;
      player.grounded = true;
    }
  }

  const inputX = (keys.KeyD ? 1 : 0) - (keys.KeyA ? 1 : 0);
  let inputZ = (keys.KeyW ? 1 : 0) - (keys.KeyS ? 1 : 0);
  if (player.climbing) inputZ = 0;

  const hasHorizontalInput = inputX !== 0 || inputZ !== 0;

  if (hasHorizontalInput && locked) {
    const forward = tempVector.set(
      -Math.sin(player.yaw),
      0,
      -Math.cos(player.yaw)
    );
    const right = tempVector2.set(
      Math.cos(player.yaw),
      0,
      -Math.sin(player.yaw)
    );
    const movement = new THREE.Vector3()
      .addScaledVector(forward, inputZ)
      .addScaledVector(right, inputX)
      .normalize();
    const speed = keys.ShiftLeft || keys.ShiftRight
      ? player.sprintSpeed
      : player.walkSpeed;

    moveWithCollisions(
      player.position,
      movement.x * speed * delta,
      movement.z * speed * delta,
      player.radius,
      player.bodyHeight
    );
  }

  if (!player.climbing) {
    const oldY = player.position.y;
    const oldTop = oldY + player.bodyHeight;
    player.velocityY -= player.gravity * delta;
    let newY = oldY + player.velocityY * delta;

    if (player.velocityY > 0) {
      const ceiling = findCeilingHeight(
        player.position.x,
        player.position.z,
        oldTop,
        newY + player.bodyHeight
      );
      if (ceiling < Infinity) {
        newY = ceiling - player.bodyHeight - 0.02;
        player.velocityY = 0;
      }
    }

    if (player.velocityY <= 0) {
      const support = getSupportHeight(
        player.position.x,
        player.position.z,
        oldY,
        newY
      );

      if (newY <= support) {
        newY = support;
        player.velocityY = 0;
        player.grounded = true;
      } else {
        player.grounded = false;
      }
    }

    player.position.y = Math.max(0, newY);
    if (player.position.y === 0) {
      player.velocityY = 0;
      player.grounded = true;
    }
  }

  // 最后进行一次自动脱墙；若复杂重叠墙角仍未解开，则回退到上一帧安全位置。
  resolveCirclePenetration(player.position, player.radius, player.bodyHeight);
  if (collidesAt(
    player.position.x,
    player.position.z,
    player.radius,
    player.position.y,
    player.bodyHeight
  )) {
    player.position.copy(playerLastSafePosition);
    player.velocityY = 0;
    player.climbing = false;
  } else {
    playerLastSafePosition.copy(player.position);
  }

  const movingOnGround =
    hasHorizontalInput &&
    player.grounded &&
    locked;
  const bobSpeed = keys.ShiftLeft || keys.ShiftRight ? 15 : 10;
  const bobAmount = movingOnGround
    ? Math.sin(performance.now() * 0.001 * bobSpeed) * 0.025
    : 0;

  camera.position.set(
    player.position.x,
    player.position.y + player.eyeHeight + bobAmount,
    player.position.z
  );

  cameraShake = THREE.MathUtils.damp(cameraShake, 0, 15, delta);
  const shakePitch = (Math.random() - 0.5) * cameraShake;
  const shakeYaw = (Math.random() - 0.5) * cameraShake * 0.55;
  const shakeRoll = (Math.random() - 0.5) * cameraShake * 0.8;

  camera.rotation.set(
    player.pitch + shakePitch,
    player.yaw + shakeYaw,
    shakeRoll
  );
}

function updateWeapon(delta) {
  if (reloadingWeapon) {
    reloadTimer -= delta;
    if (reloadTimer <= 0) completeReload();
    else updateAmmoUI();
  }

  const targetFov = aiming ? 24 : 75;
  const nextFov = THREE.MathUtils.damp(camera.fov, targetFov, aiming ? 13 : 9, delta);
  if (Math.abs(nextFov - camera.fov) > 0.001) {
    camera.fov = nextFov;
    camera.updateProjectionMatrix();
  }

  weaponRecoil = THREE.MathUtils.damp(weaponRecoil, 0, 17, delta);
  weapon.position.copy(weaponBasePosition);
  weapon.position.z += weaponRecoil;
  weapon.position.y += weaponRecoil * 0.32;
  weapon.rotation.x = -0.035 + weaponRecoil * 0.65;
  weapon.rotation.y = -0.025;
  weapon.rotation.z = -0.025;

  if (reloadingWeapon && reloadDuration > 0) {
    const progress = THREE.MathUtils.clamp(1 - reloadTimer / reloadDuration, 0, 1);
    const arc = Math.sin(progress * Math.PI);
    weapon.position.y -= arc * 0.22;
    weapon.position.x += arc * 0.08;
    weapon.rotation.z -= arc * 0.42;
  }

  // 进入狙击镜时隐藏第一人称枪身，避免模型遮住镜片中心。
  weapon.visible = !aiming;

  muzzleTimer -= delta;
  if (muzzleTimer <= 0) {
    muzzleFlash.visible = false;
    muzzleLight.intensity = 0;
  } else {
    muzzleLight.intensity = 10 * (muzzleTimer / 0.055);
  }
}

function updateVisualUI(delta) {
  damageFlash = THREE.MathUtils.damp(damageFlash, 0, 7, delta);
  damageVignette.style.opacity = String(Math.min(0.9, damageFlash));

  hitFlash = Math.max(0, hitFlash - delta);
  hitMarker.style.opacity = hitFlash > 0
    ? String(Math.min(1, hitFlash * 12))
    : "0";

  // 动态散布：开火时准星张开（狙击镜内收紧为 0.35 倍），停火后按指数回收。
  const bloomTarget = (firing && !aiming) ? CROSSHAIR_BLOOM_MAX : 0;
  crosshairBloom = THREE.MathUtils.damp(crosshairBloom, bloomTarget, 9, delta);
  if (crosshairBloom < 0.05) crosshairBloom = 0;
  crosshair.style.setProperty("--bloom", crosshairBloom.toFixed(2) + "px");
  crosshair.classList.toggle("is-blooming", crosshairBloom >= CROSSHAIR_BLOOM_WARN);

  // 命中 X 脉冲：0 -> 1 -> 0，配合 CSS scale 形成“收缩命中”动画。
  if (hitMarkerPulse > 0) {
    hitMarkerPulse = Math.max(0, hitMarkerPulse - delta / HIT_MARKER_TTL);
    if (hitMarkerPulse > 0) {
      hitMarker.classList.add("pulse");
      hitMarker.classList.toggle("strong", hitMarkerStrong);
      hitMarker.style.setProperty("--pulse", hitMarkerPulse.toFixed(3));
    } else {
      hitMarker.classList.remove("pulse", "strong");
      hitMarker.style.removeProperty("--pulse");
    }
  } else if (hitMarker.classList.contains("pulse")) {
    hitMarker.classList.remove("pulse", "strong");
    hitMarker.style.removeProperty("--pulse");
  }

  // 命中部位标签：命中头 / 四肢后短暂显示倍率，躯干命中不显示。
  if (hitZoneLabel) {
    hitZoneLabelTimer = Math.max(0, hitZoneLabelTimer - delta);
    hitZoneLabel.style.opacity = hitZoneLabelTimer > 0
      ? String(Math.min(1, Math.min(hitZoneLabelTimer, 0.08) * 14))
      : "0";
    if (hitZoneLabelTimer === 0 && hitZoneLabel.textContent) {
      hitZoneLabel.textContent = "";
      hitZoneLabel.className = "";
    }
  }

  // 准星目标距离读数：12.5 Hz 战斗帧时钟，真·暂停整帧冻结随之冻结。
  updateTargetRange(delta);

  // 威胁等级进度条：等级提升后的高亮闪烁到达时限后移除，避免常亮。
  if (threatTierFlashTimer > 0) {
    threatTierFlashTimer = Math.max(0, threatTierFlashTimer - delta);
    if (threatTierFlashTimer === 0 && threatTrack.classList.contains("tier-up")) {
      threatTrack.classList.remove("tier-up");
    }
  }

  // 最佳纪录追踪条：破纪录高亮到达时限后移除闪烁类，但保留金色领先形态。
  if (recordTrackFlashTimer > 0 && recordTrack) {
    recordTrackFlashTimer = Math.max(0, recordTrackFlashTimer - delta);
    if (recordTrackFlashTimer === 0 && recordTrack.classList.contains("record-flash")) {
      // 高亮动画结束；record-broken 金色常亮形态由 CSS 规则接管。
      recordTrack.classList.remove("record-flash");
    }
  }

  pickupNoticeTimer = Math.max(0, pickupNoticeTimer - delta);
  pickupNotice.style.opacity = pickupNoticeTimer > 0
    ? String(Math.min(1, pickupNoticeTimer * 3))
    : "0";

  if (killStreakTimer > 0) {
    killStreakTimer = Math.max(0, killStreakTimer - delta);
    if (killStreakTimer === 0) resetKillStreak(true);
  }
  updateStreakTrack();

  updateLowHealthWarning(delta);
  updateSupplyGuide(delta);
  updateIntakeReadout();
  updateSurvivalClockUI();
  updateThreatMarkers(delta);
  updateDamageDirection(delta);

  for (let i = combatLogEntries.length - 1; i >= 0; i--) {
    const item = combatLogEntries[i];
    item.remaining -= delta;
    if (item.remaining <= 0.2) item.element.classList.remove("visible");
    if (item.remaining <= 0 && item.element.parentNode === combatLog) {
      combatLog.removeChild(item.element);
      combatLogEntries.splice(i, 1);
    }
  }

  // 击杀播报条目倒计时：与信息流同为战斗帧驱动，真·暂停整帧冻结。
  updateKillFeed(delta);
}
