
(function () {
  const tier = Number(document.documentElement.dataset.demoTier || 0);
  const game = document.documentElement.dataset.demoGame || 'generic';
  document.body.classList.add(`demo-tier-${tier}`);
  const scene = document.createElement('div');
  scene.className = `demo-scene scene-${game}`;
  const add = (className, styles = {}) => {
    const node = document.createElement('i');
    node.className = className;
    Object.assign(node.style, styles);
    scene.appendChild(node);
  };
  if (game === 'iron-breakout-fps') {
    add('scene-grid');
    if (tier > 0) for (let i = 0; i < tier; i++) add('scene-tower', { left: `${8 + i * 29}%`, opacity: 0.55 + i * .1 });
    if (tier > 0) for (let i = 0; i < tier + 1; i++) add('scene-light', { left: `${12 + i * 19}%`, top: `${22 + (i % 3) * 23}%` });
    if (tier > 1) for (let i = 0; i < tier - 1; i++) add('scene-enemy', { left: `${26 + i * 28}%`, top: `${31 + (i % 2) * 28}%` });
    if (tier > 1) add('scene-muzzle', { left: '58%', top: '43%' });
  } else if (game === 'chudopoly') {
    add('scene-runway');
    if (tier > 0) add('scene-mark');
    if (tier > 0) for (let i = 0; i < tier; i++) add('scene-card', { left: `${10 + i * 27}%`, top: `${22 + (i % 2) * 48}%`, transform: `rotate(${i % 2 ? 7 : -8}deg)` });
    if (tier > 1) for (let i = 0; i < tier + 1; i++) add('scene-light', { left: `${12 + i * 22}%`, top: `${18 + (i % 2) * 64}%` });
    if (tier >= 3) {
      add('scene-terminal'); add('scene-flight-board'); add('scene-card-tray');
      add('scene-deck-stack'); add('scene-discard-stack');
      add('scene-gateway gateway-left'); add('scene-gateway gateway-right');
      add('scene-route route-a'); add('scene-route route-b');
      add('scene-aircraft aircraft-a'); add('scene-aircraft aircraft-b');
      for (let i = 0; i < 9; i++) add('scene-runway-light', { left: `${12 + i * 9}%` });
    }
  } else if (game === 'polybranch-remediated') {
    add('scene-side left'); add('scene-side right');
    if (tier > 0) add('scene-gate');
    if (tier > 0) for (let i = 0; i < tier + 1; i++) add('scene-ring', { width: `${120 + i * 160}px`, height: `${48 + i * 26}px` });
    if (tier > 0) for (let i = 0; i < tier * 6; i++) add('scene-dust', { left: `${8 + (i * 19) % 84}%`, top: `${16 + (i * 31) % 72}%`, animationDelay: `${i * -.18}s` });
    if (tier > 1) for (let i = 0; i < tier; i++) add('scene-hazard', { left: `${20 + i * 27}%`, top: `${28 + (i % 2) * 34}%`, transform: `rotate(45deg) scale(${.7 + tier * .12})` });
    if (tier > 1) for (let i = 0; i < tier * 2; i++) add('scene-flame', { left: `${38 + (i * 9) % 24}%`, top: `${66 + (i % 3) * 5}%` });
  }
  document.body.appendChild(scene);
  if (game === 'iron-breakout-fps' && tier >= 2) {
    const recoil = document.createElement('div');
    recoil.className = 'demo-fps-recoil';
    document.body.appendChild(recoil);
    const fire = (event) => {
      const x = event.clientX || innerWidth * .52, y = event.clientY || innerHeight * .5;
      document.body.classList.remove('demo-fps-shake'); void document.body.offsetWidth; document.body.classList.add('demo-fps-shake');
      recoil.classList.remove('recoil'); void recoil.offsetWidth; recoil.classList.add('recoil');
      const flash = document.createElement('i');
      flash.className = 'demo-fps-flash'; flash.style.left = `${x - 110}px`; flash.style.top = `${y - 110}px`;
      recoil.appendChild(flash);
      const tracer = document.createElement('i');
      tracer.className = 'demo-fps-tracer'; tracer.style.left = `${innerWidth * .5}px`; tracer.style.top = `${innerHeight * .56}px`;
      tracer.style.width = `${Math.hypot(x - innerWidth * .5, y - innerHeight * .56)}px`;
      tracer.style.transform = `rotate(${Math.atan2(y - innerHeight * .56, x - innerWidth * .5)}rad)`;
      recoil.appendChild(tracer);
      setTimeout(() => { flash.remove(); tracer.remove(); }, 360);
    };
    document.addEventListener('mousedown', fire);
    document.addEventListener('keydown', (event) => { if (['1', '2', '3', 'q', 'e'].includes(event.key.toLowerCase())) fire(event); });
  }
  if (game === 'chudopoly' && tier >= 1) {
    document.addEventListener('click', (event) => {
      const card = document.createElement('i');
      card.className = 'demo-card-burst';
      card.style.left = `${event.clientX - 40}px`; card.style.top = `${event.clientY - 56}px`;
      document.body.appendChild(card);
      const toast = document.createElement('i');
      toast.className = 'demo-card-toast';
      toast.textContent = tier >= 3 ? 'CARD PLAY RESOLVED  /  AIRCRAFT READY' : 'CARD PLAY  /  ACTION CONFIRMED';
      toast.style.left = `${Math.min(event.clientX + 18, innerWidth - 330)}px`;
      toast.style.top = `${Math.max(event.clientY - 34, 28)}px`;
      document.body.appendChild(toast);
      setTimeout(() => { card.remove(); toast.remove(); }, 1600);
    });
    if (tier >= 3) {
      document.addEventListener('click', (event) => {
        const pulse = document.createElement('i');
        pulse.className = 'demo-flight-pulse';
        pulse.style.left = `${event.clientX - 18}px`;
        pulse.style.top = `${event.clientY - 18}px`;
        document.body.appendChild(pulse);
        setTimeout(() => pulse.remove(), 900);
      });
    }
  }
  if (game === 'polybranch-remediated' && tier >= 2) {
    const wake = document.createElement('div');
    wake.className = 'demo-poly-wake';
    document.body.appendChild(wake);
    const burst = (x, y) => {
      for (let i = 0; i < 5 + tier * 2; i++) {
        const spark = document.createElement('i');
        spark.className = 'demo-poly-spark'; spark.style.left = `${x}px`; spark.style.top = `${y}px`;
        spark.style.setProperty('--dx', `${(Math.random() - .5) * 150}px`);
        spark.style.setProperty('--dy', `${40 + Math.random() * 120}px`);
        wake.appendChild(spark); setTimeout(() => spark.remove(), 820);
      }
    };
    let lastX = innerWidth * .5, lastY = innerHeight * .72;
    document.addEventListener('mousemove', (event) => { if (Math.hypot(event.clientX - lastX, event.clientY - lastY) > 28) { burst(lastX, lastY); lastX = event.clientX; lastY = event.clientY; } });
    setInterval(() => burst(innerWidth * .5, innerHeight * .72), tier === 3 ? 620 : 1000);
  }
}());
