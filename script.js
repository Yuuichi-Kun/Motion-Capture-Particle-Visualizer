(() => {
  const canvas = document.getElementById("viz");
  const ctx = canvas.getContext("2d");
  const startBtn = document.getElementById("startBtn");
  const stopBtn = document.getElementById("stopBtn");
  const statusText = document.getElementById("statusText");

  const video = document.createElement("video");
  video.playsInline = true;
  video.muted = true;
  video.autoplay = true;

  // Low-resolution buffer for motion analysis.
  const analysis = {
    width: 180,
    height: 100,
    sampleStep: 2,
    gridCols: 24,
    gridRows: 14,
    threshold: 26,
  };

  let prevFrame = null;
  let stream = null;
  let running = false;
  let rafId = null;
  const particles = [];
  let tick = 0;
  let gestureState = "scatter"; // scatter | point | open | fist | triangle | square | thumbs | heart
  let lastGestureChange = performance.now();
  let gestureConfidence = 0;
  let textTargets = [];
  let heartTargets = [];

  const analysisCtx = document.createElement("canvas").getContext("2d");
  analysisCtx.canvas.width = analysis.width;
  analysisCtx.canvas.height = analysis.height;

  // MediaPipe Hands setup (lightweight gesture detection).
  const hands = new Hands({
    locateFile: (file) =>
      `https://cdn.jsdelivr.net/npm/@mediapipe/hands/${file}`,
  });
  hands.setOptions({
    maxNumHands: 2,
    modelComplexity: 0,
    minDetectionConfidence: 0.5,
    minTrackingConfidence: 0.5,
  });

  let processingHands = false;
  hands.onResults((results) => {
    if (!results.multiHandLandmarks?.length) {
      gestureConfidence = Math.max(gestureConfidence - 0.05, 0);
      if (gestureConfidence < 0.2 && gestureState !== "scatter") {
        gestureState = "scatter";
        lastGestureChange = performance.now();
      }
      return;
    }

    const nextGesture = classifyCombinedGesture(results.multiHandLandmarks);
    if (nextGesture === gestureState) {
      gestureConfidence = Math.min(1, gestureConfidence + 0.08);
    } else {
      gestureConfidence = Math.max(0, gestureConfidence - 0.1);
      if (gestureConfidence < 0.2) {
        gestureState = nextGesture;
        lastGestureChange = performance.now();
      }
    }
  });

  function detectExtendedFingers(lm) {
    const fingers = { thumb: false, index: false, middle: false, ring: false, pinky: false };
    // Thumb: compare x against MCP depending on handedness (assume mirrored webcam, so use tip.x < ip.x).
    fingers.thumb = lm[4].x < lm[3].x;
    // Other fingers: tip higher (smaller y) than pip.
    fingers.index = lm[8].y < lm[6].y;
    fingers.middle = lm[12].y < lm[10].y;
    fingers.ring = lm[16].y < lm[14].y;
    fingers.pinky = lm[20].y < lm[18].y;
    return fingers;
  }

  function classifyGesture(f) {
    const upCount = Object.values(f).filter(Boolean).length;
    if (f.index && !f.middle && !f.ring && !f.pinky) return "point";
    if (upCount >= 4) return "open";
    if (upCount <= 1) return "fist";
    return "scatter";
  }

  function classifyCombinedGesture(handsLm) {
    // Thumbs up: thumb extended up, others closed.
    for (const lm of handsLm) {
      if (isThumbsUp(lm)) return "thumbs";
    }

    // Heart gesture: two fingers (index + middle) up, others down.
    for (const lm of handsLm) {
      const f = detectExtendedFingers(lm);
      if (f.index && f.middle && !f.ring && !f.pinky && !f.thumb) return "heart";
    }

    // Triangle: two hands, each mainly index+thumb extended.
    if (handsLm.length >= 2) {
      const a = detectExtendedFingers(handsLm[0]);
      const b = detectExtendedFingers(handsLm[1]);
      const ok = (f) => f.index && f.thumb && !f.middle && !f.ring && !f.pinky;
      if (ok(a) && ok(b)) return "triangle";
    }

    // Square: one very open hand (all fingers).
    for (const lm of handsLm) {
      const f = detectExtendedFingers(lm);
      const upCount = Object.values(f).filter(Boolean).length;
      if (upCount === 5) return "square";
    }

    // Fallback to single-hand classifier.
    return classifyGesture(detectExtendedFingers(handsLm[0]));
  }

  function isThumbsUp(lm) {
    const f = detectExtendedFingers(lm);
    const thumbOnly = f.thumb && !f.index && !f.middle && !f.ring && !f.pinky;
    const thumbAboveWrist = lm[4].y < lm[0].y - 0.05;
    return thumbOnly && thumbAboveWrist;
  }

  async function processHands() {
    if (!running || processingHands || !video.videoWidth) return;
    processingHands = true;
    try {
      await hands.send({ image: video });
    } catch (err) {
      console.warn("Hands processing error", err);
    } finally {
      processingHands = false;
    }
  }

  function buildTextTargets() {
    const text = "THANK YOU";
    const off = document.createElement("canvas");
    const baseW = 820;
    const baseH = 200;
    off.width = baseW;
    off.height = baseH;
    const octx = off.getContext("2d");
    octx.fillStyle = "#fff";
    octx.font = "bold 120px Arial";
    octx.textAlign = "center";
    octx.textBaseline = "middle";
    octx.fillText(text, baseW / 2, baseH / 2);

    const { data } = octx.getImageData(0, 0, baseW, baseH);
    const pts = [];
    const step = 6;
    for (let y = 0; y < baseH; y += step) {
      for (let x = 0; x < baseW; x += step) {
        const idx = (y * baseW + x) * 4 + 3;
        if (data[idx] > 16) {
          pts.push({ x, y });
        }
      }
    }

    const scale = Math.min(canvas.width / baseW, canvas.height / baseH) * 0.6;
    const offsetX = canvas.width * 0.5 - (baseW * scale) / 2;
    const offsetY = canvas.height * 0.5 - (baseH * scale) / 2;
    textTargets = pts.map((p) => ({
      x: offsetX + p.x * scale,
      y: offsetY + p.y * scale,
    }));
  }

  function buildHeartTargets() {
    const off = document.createElement("canvas");
    const baseW = 480;
    const baseH = 420;
    off.width = baseW;
    off.height = baseH;
    const pts = [];
    const step = 4;
    // Sample implicit heart curve: (x^2 + y^2 -1)^3 - x^2 y^3 <= 0
    for (let y = -baseH / 2; y <= baseH / 2; y += step) {
      for (let x = -baseW / 2; x <= baseW / 2; x += step) {
        const nx = x / (baseW / 2);
        const ny = y / (baseH / 2);
        const v = Math.pow(nx * nx + ny * ny - 1, 3) - nx * nx * Math.pow(ny, 3);
        if (v <= 0) {
          pts.push({ x: nx, y: ny });
        }
      }
    }

    const scale = Math.min(canvas.width, canvas.height) * 0.32;
    const cx = canvas.width * 0.5;
    const cy = canvas.height * 0.48;
    heartTargets = pts.map((p) => ({
      x: cx + p.x * scale,
      y: cy + p.y * scale,
    }));
  }

  function resize() {
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
    buildTextTargets();
    buildHeartTargets();
  }

  resize();
  window.addEventListener("resize", resize);

  class Particle {
    constructor(x, y, impulse = 1) {
      this.x = x + (Math.random() - 0.5) * 14;
      this.y = y + (Math.random() - 0.5) * 14;
      const angle = Math.random() * Math.PI * 2;
      const speed = (0.4 + Math.random() * 0.8) * (1 + impulse * 0.02);
      this.vx = Math.cos(angle) * speed;
      this.vy = Math.sin(angle) * speed;
      this.life = 90 + Math.random() * 110;
      this.size = 1.2 + Math.random() * 1.6;
      this.hue = 180 + Math.random() * 120;
    }

    update(motionCells) {
      // Nudge toward the strongest motion point.
      if (motionCells.length) {
        const idx = (tick + Math.floor(Math.random() * motionCells.length)) % motionCells.length;
        const target = motionCells[idx];
        const dx = target.x - this.x;
        const dy = target.y - this.y;
        const dist = Math.hypot(dx, dy) + 1e-4;
        const pull = Math.min(target.strength / 480, 1.4);
        this.vx += (dx / dist) * 0.08 * pull;
        this.vy += (dy / dist) * 0.08 * pull;
      }

      // Small random drift keeps the motion organic.
      const scatterBoost = gestureState === "open" ? 0.18 : 0.08;
      this.vx += (Math.random() - 0.5) * scatterBoost;
      this.vy += (Math.random() - 0.5) * scatterBoost;

      // Spiral swirl when triangle gesture is active.
      if (gestureState === "triangle") {
        const dx = this.x - canvas.width * 0.5;
        const dy = this.y - canvas.height * 0.5;
        const dist = Math.hypot(dx, dy) + 1e-4;
        const tangential = 0.08;
        this.vx += (-dy / dist) * tangential;
        this.vy += (dx / dist) * tangential;
      }

      const damping =
        gestureState === "point" ? 0.99 : gestureState === "fist" ? 0.96 : 0.985;
      this.vx *= damping;
      this.vy *= damping;
      this.x += this.vx;
      this.y += this.vy;
      this.life -= 1;

      // Wrap around edges to keep the canvas filled.
      if (this.x < -10) this.x = canvas.width + 10;
      if (this.x > canvas.width + 10) this.x = -10;
      if (this.y < -10) this.y = canvas.height + 10;
      if (this.y > canvas.height + 10) this.y = -10;
    }

    draw() {
      const alpha = Math.max(this.life / 200, 0);
      ctx.fillStyle = `hsla(${this.hue}, 90%, 70%, ${alpha})`;
      ctx.beginPath();
      ctx.arc(this.x, this.y, this.size, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  function computeMotion() {
    if (!video.videoWidth || !video.videoHeight) return [];

    analysisCtx.drawImage(video, 0, 0, analysis.width, analysis.height);
    const { data } = analysisCtx.getImageData(0, 0, analysis.width, analysis.height);

    if (!prevFrame) {
      prevFrame = new Uint8ClampedArray(data);
      return [];
    }

    const cells = [];
    const cellW = Math.floor(analysis.width / analysis.gridCols);
    const cellH = Math.floor(analysis.height / analysis.gridRows);
    const scaleX = canvas.width / analysis.width;
    const scaleY = canvas.height / analysis.height;

    for (let gy = 0; gy < analysis.gridRows; gy++) {
      for (let gx = 0; gx < analysis.gridCols; gx++) {
        const startX = gx * cellW;
        const startY = gy * cellH;
        let sum = 0;
        let count = 0;

        for (let y = startY; y < startY + cellH; y += analysis.sampleStep) {
          for (let x = startX; x < startX + cellW; x += analysis.sampleStep) {
            const idx = (y * analysis.width + x) * 4;
            const dr = Math.abs(data[idx] - prevFrame[idx]);
            const dg = Math.abs(data[idx + 1] - prevFrame[idx + 1]);
            const db = Math.abs(data[idx + 2] - prevFrame[idx + 2]);
            sum += dr + dg + db;
            count++;
          }
        }

        const avg = sum / Math.max(count, 1);
        if (avg > analysis.threshold) {
          cells.push({
            x: (startX + cellW * 0.5) * scaleX,
            y: (startY + cellH * 0.5) * scaleY,
            strength: avg,
          });
        }
      }
    }

    prevFrame.set(data);
    cells.sort((a, b) => b.strength - a.strength);
    return cells;
  }

  function spawnParticles(motionCells) {
    for (const cell of motionCells.slice(0, 32)) {
      const count = Math.min(6, Math.ceil(cell.strength / 90));
      for (let i = 0; i < count; i++) {
        particles.push(new Particle(cell.x, cell.y, cell.strength));
      }
    }

    // Keep particle budget reasonable.
    const maxParticles = 1200;
    if (particles.length > maxParticles) {
      particles.splice(0, particles.length - maxParticles);
    }
  }

  function applyGestureShape(motionCells) {
    const cells = [...motionCells];
    const centerX = canvas.width * 0.5;
    const centerY = canvas.height * 0.5;

    if (gestureState === "point") {
      // Strong pull to the center for a tight cluster.
      cells.unshift({ x: centerX, y: centerY, strength: 1200 });
    } else if (gestureState === "open") {
      // Scatter: add weak attractors near corners to spread them out.
      const scatterPoints = [
        { x: canvas.width * 0.2, y: canvas.height * 0.2 },
        { x: canvas.width * 0.8, y: canvas.height * 0.25 },
        { x: canvas.width * 0.25, y: canvas.height * 0.75 },
        { x: canvas.width * 0.8, y: canvas.height * 0.8 },
      ];
      scatterPoints.forEach((p) => cells.push({ ...p, strength: 300 }));
    } else if (gestureState === "fist") {
      // Slow drift: reduce strengths so particles glide calmly.
      return cells.map((c) => ({ ...c, strength: c.strength * 0.35 }));
    } else if (gestureState === "square") {
      const w = canvas.width * 0.36;
      const h = canvas.height * 0.36;
      const cx = centerX;
      const cy = centerY;
      const corners = [
        { x: cx - w * 0.5, y: cy - h * 0.5 },
        { x: cx + w * 0.5, y: cy - h * 0.5 },
        { x: cx + w * 0.5, y: cy + h * 0.5 },
        { x: cx - w * 0.5, y: cy + h * 0.5 },
      ];
      const mids = [
        { x: cx, y: cy - h * 0.5 },
        { x: cx + w * 0.5, y: cy },
        { x: cx, y: cy + h * 0.5 },
        { x: cx - w * 0.5, y: cy },
      ];
      [...corners, ...mids].forEach((p) => cells.unshift({ ...p, strength: 850 }));
    } else if (gestureState === "triangle") {
      const r = Math.min(canvas.width, canvas.height) * 0.28;
      const pts = [0, (2 * Math.PI) / 3, (4 * Math.PI) / 3].map((a) => ({
        x: centerX + Math.cos(a) * r,
        y: centerY + Math.sin(a) * r,
      }));
      pts.forEach((p) => cells.unshift({ ...p, strength: 980 }));
      // Add slight center pull so spiral has a core.
      cells.unshift({ x: centerX, y: centerY, strength: 600 });
    } else if (gestureState === "thumbs" && textTargets.length) {
      textTargets.forEach((p) => cells.unshift({ ...p, strength: 1050 }));
    } else if (gestureState === "heart" && heartTargets.length) {
      heartTargets.forEach((p) => cells.unshift({ ...p, strength: 1100 }));
    }

    return cells;
  }

  function gestureMessage() {
    if (gestureState === "point") return "Point at the camera to gather particles to the center.";
    if (gestureState === "open") return "Open hand detected: particles scatter wide.";
    if (gestureState === "fist") return "Fist detected: particles calm and slow.";
    if (gestureState === "triangle") return "Two-hand triangle: particles spiral.";
    if (gestureState === "square") return "Square hand: particles form a square.";
    if (gestureState === "thumbs") return "Thumbs up: particles say THANK YOU.";
    if (gestureState === "heart") return "Two fingers up: particles form a heart.";
    return "Motion detected: more movement spawns more particles.";
  }

  function updateAndRender(motionCells) {
    ctx.fillStyle = "rgba(3, 7, 15, 0.24)";
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    for (let i = particles.length - 1; i >= 0; i--) {
      const p = particles[i];
      p.update(motionCells);
      p.draw();
      if (p.life <= 0) {
        particles.splice(i, 1);
      }
    }
  }

  function loop() {
    if (!running) return;
    tick++;
    const motionCells = computeMotion();
    if (tick % 3 === 0) processHands();

    const shapedTargets = applyGestureShape(motionCells);
    if (motionCells.length) {
      statusText.textContent = gestureMessage();
    } else {
      statusText.textContent = "Move in front of the camera to drive the particles.";
    }
    spawnParticles(shapedTargets);
    updateAndRender(shapedTargets);
    rafId = requestAnimationFrame(loop);
  }

  async function start() {
    if (running) return;
    try {
      statusText.textContent = "Requesting camera...";
      stream = await navigator.mediaDevices.getUserMedia({
        video: { width: 1280, height: 720, facingMode: "user" },
        audio: false,
      });
      video.srcObject = stream;
      await video.play();
      running = true;
      startBtn.disabled = true;
      stopBtn.disabled = false;
      statusText.textContent = "Camera active. Wave to paint with particles!";
      prevFrame = null;
      loop();
    } catch (err) {
      console.error(err);
      statusText.textContent =
        "Unable to access the webcam. Please allow camera access and use a secure (https) context.";
    }
  }

  function stop() {
    running = false;
    if (rafId) cancelAnimationFrame(rafId);
    if (stream) {
      stream.getTracks().forEach((t) => t.stop());
      stream = null;
    }
    startBtn.disabled = false;
    stopBtn.disabled = true;
    statusText.textContent = "Camera stopped. Click start to run again.";
  }

  startBtn.addEventListener("click", start);
  stopBtn.addEventListener("click", stop);

  // Attempt to start automatically when possible (will fail silently on some browsers).
  if (navigator.mediaDevices?.getUserMedia) {
    start().catch(() => {
      // User will have to click start; message already set.
    });
  } else {
    statusText.textContent = "Webcam not supported in this browser.";
  }
})();

