import { $, log } from "./dom.js";
import { state, visualizer } from "./state.js";
import { api, ApiError } from "./api.js";

export function stopVisualizer(releaseContext = false) {
  if (visualizer.frame) cancelAnimationFrame(visualizer.frame);
  visualizer.frame = 0;
  if (visualizer.source) visualizer.source.disconnect();
  if (visualizer.analyser) visualizer.analyser.disconnect();
  if (visualizer.sink) visualizer.sink.disconnect();
  if (visualizer.stream) visualizer.stream.getTracks().forEach(track => track.stop());
  if (releaseContext && visualizer.context && typeof visualizer.context.close === "function" && visualizer.context.state !== "closed") {
    visualizer.context.close();
    visualizer.context = null;
  }
  visualizer.source = visualizer.analyser = visualizer.sink = visualizer.stream = null;
  visualizer.timeData = visualizer.freqData = null;
  visualizer.mode = "";
  visualizer.particles = [];
  visualizer.lastEnergy = 0;
  visualizer.history = null;
  $("visualizer").hidden = true;
}

export function prepareVisualizer() {
  if ($("visualizer-mode").value === "off") return;
  if (!window.AudioContext || typeof $("audio").captureStream !== "function") {
    visualizer.failure = "Visualizer is not supported by this browser.";
    return;
  }
  try {
    if (!visualizer.context) visualizer.context = new AudioContext();
    visualizer.failure = "";
    if (visualizer.context.state !== "running") {
      visualizer.context.resume().then(syncVisualizer, () => {
        visualizer.failure = "Visualizer could not start. Press Play to retry.";
        syncVisualizer();
      });
    }
  } catch {
    visualizer.failure = "Visualizer could not start in this browser.";
  }
}

export async function prepareAudioProxy(url, signal) {
  if ($("visualizer-mode").value === "off" || visualizer.failure || !visualizer.context) return null;
  const controller = new AbortController();
  const abort = () => controller.abort();
  const timer = setTimeout(abort, 5000);
  if (signal.aborted) abort();
  else signal.addEventListener("abort", abort, { once: true });
  try {
    const result = await api("/audio-proxy", { method: "POST", body: { url }, signal: controller.signal });
    if (!result || typeof result.proxy_url !== "string" || !result.proxy_url.startsWith("/") || result.proxy_url.startsWith("//")) {
      throw new ApiError("The server returned an invalid audio proxy URL.");
    }
    const proxy = new URL(result.proxy_url, state.auth.base + "/");
    const expected = new URL(state.auth.base + "/api/v1/audio-stream");
    const params = [...proxy.searchParams];
    if (proxy.origin !== expected.origin || proxy.pathname !== expected.pathname || proxy.username || proxy.password ||
        proxy.hash || params.length !== 1 || params[0][0] !== "token" || !params[0][1]) {
      throw new ApiError("The server returned an invalid audio proxy URL.");
    }
    return proxy.href;
  } catch (error) {
    if (signal.aborted || error.status === 401) throw error;
    const reason = controller.signal.aborted ? "Request timed out." : error instanceof ApiError ? error.message : "Unexpected error.";
    log(`Could not prepare the audio proxy: ${reason} Playing directly without the visualizer.`);
    return null;
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", abort);
  }
}

function bandLevel(data, band, bands, frequencyBins) {
  const start = Math.floor(Math.pow(band / bands, 1.8) * frequencyBins);
  const end = Math.max(start + 1, Math.floor(Math.pow((band + 1) / bands, 1.8) * frequencyBins));
  let level = 0;
  for (let i = start; i < end; i++) level = Math.max(level, data[i]);
  return level;
}

function drawArea(ctx, width, height, scale, data, frequencyBins) {
  const bands = 64;
  const levels = [];
  let peak = 0;
  for (let i = 0; i < bands; i++) {
    const level = bandLevel(data, i, bands, frequencyBins);
    levels.push(level);
    if (level > peak) peak = level;
  }
  if (!peak) return;
  const step = width / (bands - 1);
  const pointY = level => height - height * 0.82 * level / 255;
  ctx.beginPath();
  ctx.moveTo(0, height);
  levels.forEach((level, i) => ctx.lineTo(i * step, pointY(level)));
  ctx.lineTo(width, height);
  ctx.closePath();
  ctx.globalAlpha = 0.28;
  ctx.fill();
  ctx.beginPath();
  levels.forEach((level, i) => {
    const x = i * step, y = pointY(level);
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  });
  ctx.globalAlpha = 0.6;
  ctx.lineWidth = 2 * scale;
  ctx.stroke();
}

function drawSpectrogram(ctx, width, height, data, accent) {
  if (!visualizer.history || visualizer.history.width !== width || visualizer.history.height !== height) {
    visualizer.history = document.createElement("canvas");
    visualizer.history.width = width;
    visualizer.history.height = height;
  }
  const historyCtx = visualizer.history.getContext("2d");
  if (!historyCtx) return;
  const bins = Math.max(1, Math.floor(data.length * 0.8));
  let peak = 0;
  for (let i = 0; i < bins; i++) if (data[i] > peak) peak = data[i];
  if (!peak) {
    historyCtx.clearRect(0, 0, width, height);
    return;
  }
  historyCtx.globalCompositeOperation = "copy";
  historyCtx.globalAlpha = 1;
  historyCtx.drawImage(visualizer.history, -1, 0);
  historyCtx.globalCompositeOperation = "source-over";
  historyCtx.fillStyle = accent;
  for (let y = 0; y < height; y++) {
    const bin = Math.floor((1 - y / Math.max(1, height - 1)) * (bins - 1));
    const level = data[bin] / 255;
    if (!level) continue;
    historyCtx.globalAlpha = 0.15 + level * 0.75;
    historyCtx.fillRect(width - 1, y, 1, 1);
  }
  historyCtx.globalAlpha = 1;
  ctx.globalAlpha = 1;
  ctx.drawImage(visualizer.history, 0, 0);
}

function emitParticles(data, energy, scale) {
  const bands = 12;
  const burst = Math.min(12, 4 + Math.floor(energy / 32));
  for (let i = 0; i < burst; i++) {
    const band = i % bands;
    const level = data[Math.floor(band / bands * data.length * 0.8)] / 255;
    const angle = band * 2 * Math.PI / bands + (Math.random() - 0.5) * (2 * Math.PI / bands) * 0.6;
    const speed = 0.003 + level * 0.01 + Math.random() * 0.002;
    visualizer.particles.push({
      x: 0.5 + Math.cos(angle) * 0.02,
      y: 0.5 + Math.sin(angle) * 0.02,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed,
      life: 1,
      decay: 0.012 + Math.random() * 0.016,
      size: (1 + level * 2.2) * scale
    });
  }
  if (visualizer.particles.length > 96) visualizer.particles.splice(0, visualizer.particles.length - 96);
}

function drawParticles(ctx, width, height) {
  const living = [];
  for (const particle of visualizer.particles) {
    particle.x += particle.vx;
    particle.y += particle.vy;
    particle.vx *= 0.99;
    particle.vy *= 0.99;
    particle.life -= particle.decay;
    if (particle.life <= 0 || particle.x < -0.05 || particle.x > 1.05 || particle.y < -0.05 || particle.y > 1.05) continue;
    ctx.globalAlpha = 0.15 + particle.life * 0.55;
    ctx.beginPath();
    ctx.arc(particle.x * width, particle.y * height, particle.size * (0.6 + particle.life * 0.4), 0, Math.PI * 2);
    ctx.fill();
    living.push(particle);
  }
  visualizer.particles = living;
}

function drawKaleidoscope(ctx, width, height, scale, data, frequencyBins) {
  const segments = 8, bars = 6;
  const inner = Math.min(width, height) * 0.16;
  const outer = Math.min(width, height) * 0.44;
  const spread = Math.PI / segments / bars * 0.85;
  ctx.lineWidth = 2.5 * scale;
  for (let segment = 0; segment < segments; segment++) {
    for (let i = 0; i < bars; i++) {
      const band = i < bars / 2 ? i : bars - 1 - i;
      const level = bandLevel(data, band, bars, frequencyBins);
      if (!level) continue;
      const angle = (segment + (i + 0.5) / bars) * 2 * Math.PI / segments;
      const x = Math.cos(angle), y = Math.sin(angle);
      const length = (outer - inner) * level / 255;
      ctx.globalAlpha = 0.12 + level / 255 * 0.4;
      ctx.beginPath();
      ctx.moveTo(width / 2 + x * inner, height / 2 + y * inner);
      ctx.lineTo(width / 2 + x * (inner + length), height / 2 + y * (inner + length));
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(width / 2 + x * inner, height / 2 + y * inner);
      ctx.lineTo(width / 2 + Math.cos(angle - spread) * (inner + length), height / 2 + Math.sin(angle - spread) * (inner + length));
      ctx.lineTo(width / 2 + Math.cos(angle + spread) * (inner + length), height / 2 + Math.sin(angle + spread) * (inner + length));
      ctx.closePath();
      ctx.fill();
    }
  }
}

export function drawVisualizer() {
  visualizer.frame = 0;
  const canvas = $("visualizer");
  const mode = $("visualizer-mode").value;
  if (visualizer.mode !== mode) {
    visualizer.mode = mode;
    visualizer.particles = [];
    visualizer.lastEnergy = 0;
    visualizer.history = null;
  }
  const bounds = canvas.getBoundingClientRect();
  if (bounds.width && bounds.height && visualizer.analyser) {
    const scale = Math.min(window.devicePixelRatio || 1, 2);
    const width = Math.round(bounds.width * scale), height = Math.round(bounds.height * scale);
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      visualizer.failure = "Visualizer canvas is unavailable in this browser.";
      syncVisualizer();
      return;
    }
    ctx.clearRect(0, 0, width, height);
    if (!visualizer.accent) visualizer.accent = getComputedStyle(document.documentElement).getPropertyValue("--accent").trim() || "#8de0bd";
    ctx.fillStyle = ctx.strokeStyle = visualizer.accent;
    ctx.globalAlpha = 0.22;
    if (mode === "wave") {
      if (!visualizer.timeData || visualizer.timeData.length !== visualizer.analyser.fftSize) {
        visualizer.timeData = new Uint8Array(visualizer.analyser.fftSize);
      }
      const data = visualizer.timeData;
      visualizer.analyser.getByteTimeDomainData(data);
      ctx.lineWidth = 2 * scale;
      ctx.beginPath();
      data.forEach((value, i) => {
        const x = i * width / (data.length - 1);
        const y = height * (0.55 + (value - 128) / 128 * 0.3);
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      });
      ctx.stroke();
    } else {
      if (!visualizer.freqData || visualizer.freqData.length !== visualizer.analyser.frequencyBinCount) {
        visualizer.freqData = new Uint8Array(visualizer.analyser.frequencyBinCount);
      }
      const data = visualizer.freqData;
      visualizer.analyser.getByteFrequencyData(data);
      const bars = 48, step = width / bars;
      const radius = Math.min(width, height) * 0.18;
      let frequencyBins = data.length * 0.8;
      if (mode === "bars" || mode === "mirrored" || mode === "area") {
        frequencyBins = Math.floor(frequencyBins);
        while (frequencyBins > 1 && data[frequencyBins - 1] === 0) frequencyBins--;
      }
      if (mode === "area") {
        drawArea(ctx, width, height, scale, data, frequencyBins);
      } else if (mode === "spectrogram") {
        drawSpectrogram(ctx, width, height, data, visualizer.accent);
      } else if (mode === "kaleidoscope") {
        drawKaleidoscope(ctx, width, height, scale, data, frequencyBins);
      } else if (mode === "particles") {
        let sum = 0;
        for (const value of data) sum += value;
        const energy = sum / data.length;
        if (energy < 12) {
          visualizer.particles = [];
          visualizer.lastEnergy = energy;
        } else {
          if (energy > visualizer.lastEnergy + 8) emitParticles(data, energy, scale);
          visualizer.lastEnergy = energy;
          drawParticles(ctx, width, height);
        }
      } else {
        if (mode === "radial") ctx.lineWidth = 3 * scale;
        for (let i = 0; i < bars; i++) {
          const band = mode === "mirrored" ? bars / 2 - 1 - Math.min(i, bars - 1 - i) : i;
          const bands = mode === "mirrored" ? bars / 2 : bars;
          const level = bandLevel(data, band, bands, frequencyBins);
          if (mode === "radial") {
            const angle = i * 2 * Math.PI / bars;
            const length = Math.min(width, height) * 0.3 * level / 255;
            const x = Math.cos(angle), y = Math.sin(angle);
            ctx.beginPath();
            ctx.moveTo(width / 2 + x * radius, height / 2 + y * radius);
            ctx.lineTo(width / 2 + x * (radius + length), height / 2 + y * (radius + length));
            ctx.stroke();
          } else if (mode === "mirrored") {
            const barHeight = height * 0.4 * level / 255;
            const barWidth = Math.min(step, Math.max(1, step - 3 * scale));
            ctx.fillRect(i * step + (step - barWidth) / 2, height / 2 - barHeight, barWidth, barHeight * 2);
          } else {
            const barHeight = height * 0.8 * level / 255;
            ctx.fillRect(i * step, height - barHeight, Math.max(1, step - 3 * scale), barHeight);
          }
        }
      }
    }
  }
  visualizer.frame = requestAnimationFrame(drawVisualizer);
}

export function syncVisualizer() {
  const audio = $("audio");
  const mode = $("visualizer-mode").value;
  const casting = state.castContext && state.castContext.getCurrentSession();
  let notice = "";
  if (mode !== "off" && casting) notice = "Visualizer is unavailable while casting.";
  else if (mode !== "off" && audio.getAttribute("src")) {
    if (visualizer.failure) notice = visualizer.failure;
    else if (state.visualizerAccess === "blocked") notice = "Audio analysis is unavailable for this stream.";
    else if (state.visualizerAccess === "unchecked") notice = "Visualizer will be available on the next compatible track.";
    else if (!visualizer.context || visualizer.context.state !== "running") notice = "Press Play to enable the visualizer.";
  }
  $("visualizer-status").textContent = notice;
  $("visualizer-status").hidden = !notice;
  if (mode === "off" || casting || notice || document.hidden || $("library").hidden ||
      !audio.getAttribute("src") || audio.paused || audio.ended || audio.readyState < 2) {
    stopVisualizer();
    return;
  }
  if (!visualizer.source) {
    try {
      visualizer.stream = audio.captureStream();
      if (!visualizer.stream.getAudioTracks().length) throw new Error("No audio track");
      visualizer.source = visualizer.context.createMediaStreamSource(visualizer.stream);
      visualizer.analyser = visualizer.context.createAnalyser();
      visualizer.analyser.fftSize = 256;
      visualizer.sink = visualizer.context.createGain();
      visualizer.sink.gain.value = 0;
      visualizer.source.connect(visualizer.analyser);
      visualizer.analyser.connect(visualizer.sink);
      visualizer.sink.connect(visualizer.context.destination);
    } catch {
      stopVisualizer(true);
      visualizer.failure = "This stream could not be analyzed; browser playback is unchanged.";
      $("visualizer-status").textContent = visualizer.failure;
      $("visualizer-status").hidden = false;
      return;
    }
  }
  $("visualizer").hidden = false;
  if (!visualizer.frame) visualizer.frame = requestAnimationFrame(drawVisualizer);
}
