# Motion-Controlled Particle Visualizer

Web-based particle field driven by simple webcam motion tracking. Frame differencing locates motion cells; brighter motion spawns and steers colorful particles across a fullscreen canvas.

## Quick start
- Serve locally (required for webcam on most browsers):
  - `npx serve .` or `python -m http.server 8000`
- Open the printed `http://localhost:XXXX` in a modern browser.
- Click **Start camera**, allow webcam access, and wave your hands/objects to paint with particles. Click **Stop** to release the camera.

## Files
- `index.html` – Canvas and UI (start/stop, status text).
- `style.css` – Glassy HUD styling over the fullscreen canvas.
- `script.js` – Motion analysis and particle system:
  - Downsamples webcam frames to a small buffer, does frame differencing.
  - Converts motion heat into grid cells (strength-weighted).
  - Spawns particles at motion cells; motion also tugs existing particles.
  - Limits particle count (~1200) and wraps edges for continuous flow.

## Notes
- Requires camera permission; some browsers block camera on `file://`, so use `http://localhost` or `https`.
- For higher sensitivity, reduce `threshold` in `analysis` (in `script.js`); for fewer particles, lower `maxParticles`.
- If auto-start is blocked by the browser, click **Start camera** manually.

## Troubleshooting
- **No video prompt**: ensure the page is served over `http://localhost` or `https`, and camera permissions are allowed.
- **Performance**: lower the canvas size by zooming out or reduce `analysis.width/height` to lighten motion processing.

