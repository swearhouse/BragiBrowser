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

export function drawVisualizer() {
  visualizer.frame = 0;
  const canvas = $("visualizer");
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
    const mode = $("visualizer-mode").value;
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
      if (mode === "bars" || mode === "mirrored") {
        frequencyBins = Math.floor(frequencyBins);
        while (frequencyBins > 1 && data[frequencyBins - 1] === 0) frequencyBins--;
      }
      if (mode === "radial") ctx.lineWidth = 3 * scale;
      for (let i = 0; i < bars; i++) {
        const band = mode === "mirrored" ? bars / 2 - 1 - Math.min(i, bars - 1 - i) : i;
        const bands = mode === "mirrored" ? bars / 2 : bars;
        const start = Math.floor(Math.pow(band / bands, 1.8) * frequencyBins);
        const end = Math.max(start + 1, Math.floor(Math.pow((band + 1) / bands, 1.8) * frequencyBins));
        let level = 0;
        for (let j = start; j < end; j++) level = Math.max(level, data[j]);
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
