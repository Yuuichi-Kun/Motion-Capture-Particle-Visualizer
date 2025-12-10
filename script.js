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

  const analysisCtx = document.createElement("canvas").getContext("2d");
  analysisCtx.canvas.width = analysis.width;
  analysisCtx.canvas.height = analysis.height;

  function resize() {
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
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
      this.vx += (Math.random() - 0.5) * 0.08;
      this.vy += (Math.random() - 0.5) * 0.08;

      this.vx *= 0.985;
      this.vy *= 0.985;
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
    if (motionCells.length) {
      statusText.textContent = "Motion detected: more movement spawns more particles.";
    } else {
      statusText.textContent = "Move in front of the camera to drive the particles.";
    }
    spawnParticles(motionCells);
    updateAndRender(motionCells);
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

