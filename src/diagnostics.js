import { $ } from "./dom.js";
import { state, visualizer } from "./state.js";
import { api } from "./api.js";
import { configuredServerBase } from "./config.js";
import { syncVisualizer } from "./visualizer.js";

let checkController = null;
let checks = { serverApi: null, search: null, serverConfig: null };

function formatTime(seconds) {
  const total = Number.isFinite(seconds) && seconds > 0 ? Math.floor(seconds) : 0;
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor(total / 60) % 60;
  const rest = String(total % 60).padStart(2, "0");
  return hours ? `${hours}:${String(minutes).padStart(2, "0")}:${rest}` : `${minutes}:${rest}`;
}

function setText(id, value, tone = "") {
  const node = $(id);
  if (!node) return;
  if (node.textContent !== value) node.textContent = value;
  if (tone) node.dataset.tone = tone;
  else delete node.dataset.tone;
}

function setStatus(value, tone = "") {
  setText("diagnostics-status", value, tone);
}

function redact(value) {
  return String(value)
    .replace(/Basic\s+[A-Za-z0-9+/=]+/gi, "Basic [redacted]")
    .replace(/([?&](?:token|sig|signature)=)[^\s"'<>&#]+/gi, "$1[redacted]")
    .replace(/https?:\/\/[^\s"'<>]*[?&](?:token|sig|signature)=[^\s"'<>]+/gi, "[URL redacted]");
}

function safe(fn, fallback) {
  try { return fn(); } catch { return fallback; }
}

function currentSession() {
  return state.castContext && typeof state.castContext.getCurrentSession === "function"
    ? state.castContext.getCurrentSession() : null;
}

function deviceName(session) {
  const device = session && typeof session.getCastDevice === "function" ? session.getCastDevice() : null;
  return device && device.friendlyName || "Cast receiver";
}

function castMedia(session) {
  return session && typeof session.getMediaSession === "function" ? session.getMediaSession() : null;
}

function serverOrigin() {
  const base = state.auth && state.auth.base;
  if (!base) return "";
  return safe(() => new URL(base).origin, "Configured server");
}

function checkText(check, fallback) {
  if (!check) return fallback;
  return check.detail || fallback;
}

function checkTone(check, fallback = "warn") {
  return check && check.tone || fallback;
}

function castSdkTone(text) {
  if (/could not|failed|unavailable|error/i.test(text)) return "error";
  if (/waiting|unknown|no cast|not connected|reconnect/i.test(text)) return "warn";
  return "ok";
}

function visualizerTone(mode, notice, failure) {
  if (mode === "off") return "ok";
  if (notice || failure || state.visualizerAccess === "blocked") return "warn";
  if (!visualizer.context || visualizer.context.state !== "running") return "warn";
  return "ok";
}

function storageTone(value) {
  return value === "Available" ? "ok" : "warn";
}

function storageStatus() {
  const key = "bragi.diagnostics.test";
  try {
    localStorage.setItem(key, "1");
    localStorage.removeItem(key);
    return "Available";
  } catch (error) {
    return `Unavailable (${error && error.name || "unknown error"})`;
  }
}

function activityEntries() {
  return [...document.querySelectorAll("#activity li")]
    .map(item => redact(item.textContent.trim()))
    .filter(Boolean)
    .slice(0, 20);
}

function renderActivity() {
  const entries = activityEntries();
  const list = $("diagnostics-activity");
  list.replaceChildren();
  for (const entry of entries) {
    const item = document.createElement("li");
    item.textContent = entry;
    list.append(item);
  }
  $("diagnostics-activity-empty").hidden = entries.length > 0;
}

function renderSnapshot() {
  const session = currentSession();
  const media = castMedia(session);
  const audio = $("audio");
  const source = audio.getAttribute("src");
  const mode = $("visualizer-mode").value;
  const notice = $("visualizer-status").hidden ? "" : $("visualizer-status").textContent.trim();
  const visualizerParts = [
    `Mode: ${mode}`,
    `AudioContext: ${visualizer.context ? visualizer.context.state : "not started"}`,
    `Analysis: ${state.visualizerAccess}`,
    notice || visualizer.failure
  ].filter(Boolean);
  const castSdk = $("cast-status").textContent.trim() || "Unknown";
  const serverBase = serverOrigin();
  const serverConfig = serverBase
    ? `Connected to ${serverBase}`
    : checkText(checks.serverConfig, "Not loaded; run checks to read server-url.txt");
  let searchInstanceTone = "warn";
  if (state.youtubeSearchInstance) {
    try { searchInstanceTone = new URL(state.youtubeSearchInstance).protocol === "https:" ? "ok" : "error"; }
    catch { searchInstanceTone = "error"; }
  }
  const queue = state.castQueue || state.localQueueSnapshot || state.lastQueue;
  const queueSource = state.castQueue ? "Cast queue" : state.localQueueSnapshot ? "Local queue" : state.lastQueue ? "Server queue" : "Queue";
  const track = session
    ? media && media.media && media.media.metadata && media.media.metadata.title || "No receiver track loaded."
    : state.localTitle || "No local track loaded.";
  let audioSource = "None";
  if (session) audioSource = "Receiver media (URL hidden)";
  else if (source) {
    audioSource = state.auth && source.startsWith(`${state.auth.base}/api/v1/audio-stream?`)
      ? "Bragi audio proxy (URL hidden)" : "Direct HTTPS stream (URL hidden)";
  }
  const audioTone = audio.error ? "error" : !source && !session ? "warn" : "ok";
  const support = [];
  support.push(window.AudioContext ? "AudioContext available" : "AudioContext unavailable");
  support.push(typeof audio.captureStream === "function" ? "captureStream available" : "captureStream unavailable");
  const storage = storageStatus();
  const dialogAvailable = typeof HTMLDialogElement !== "undefined" && typeof HTMLDialogElement.prototype.showModal === "function";

  setText("diag-server-config", serverConfig, serverBase ? "ok" : checkTone(checks.serverConfig));
  setText("diag-server-api", checkText(checks.serverApi, "Not checked"), checkTone(checks.serverApi));
  setText("diag-account", state.auth ? `Signed in as ${$("username").value || "unknown user"}` : "Signed out", state.auth ? "ok" : "warn");
  setText("diag-credentials", state.auth
    ? "Authorization header is kept in memory; password was cleared after sign-in."
    : "No authorization header in memory.", "ok");
  setText("diag-search-instance", state.youtubeSearchInstance, searchInstanceTone);
  setText("diag-search-check", checkText(checks.search, "Not checked"), checkTone(checks.search));

  setText("diag-output", session ? `Chromecast: ${deviceName(session)}` : "This browser", "ok");
  setText("diag-cast-sdk", castSdk, castSdkTone(castSdk));
  setText("diag-cast-session", session ? `Connected: ${deviceName(session)}` : "No receiver connected", session ? "ok" : "warn");
  setText("diag-queue", queue ? `${queueSource}: ${queue.name} (${queue.videos.length} tracks)` : "None", queue ? "ok" : "warn");
  setText("diag-track", track, /No .* loaded/i.test(track) ? "warn" : "ok");
  setText("diag-audio-source", audioSource, audioSource === "None" ? "warn" : "ok");
  setText("diag-audio-state", `${audio.paused ? "Paused" : "Playing"} · ${formatTime(audio.currentTime)} / ${formatTime(audio.duration)} · readyState ${audio.readyState}${audio.error ? ` · error ${audio.error.code}` : ""}`, audioTone);
  setText("diag-visualizer", visualizerParts.join(" · "), visualizerTone(mode, notice, visualizer.failure));

  setText("diag-page", location.origin, "ok");
  setText("diag-secure", window.isSecureContext ? `Yes (${location.protocol})` : `No (${location.protocol})`, window.isSecureContext ? "ok" : "error");
  setText("diag-media-session", "mediaSession" in navigator ? "Available" : "Not available", "mediaSession" in navigator ? "ok" : "warn");
  setText("diag-audio-analysis", support.join(" · "), support.some(value => value.includes("unavailable")) ? "warn" : "ok");
  setText("diag-dialog", dialogAvailable ? "Available" : "Not available", dialogAvailable ? "ok" : "warn");
  setText("diag-storage", storage, storageTone(storage));
  renderActivity();
}

const reportGroups = [
  ["Connection", ["diag-server-config", "diag-server-api", "diag-account", "diag-credentials", "diag-search-instance", "diag-search-check"]],
  ["Playback", ["diag-output", "diag-cast-sdk", "diag-cast-session", "diag-queue", "diag-track", "diag-audio-source", "diag-audio-state", "diag-visualizer"]],
  ["Browser", ["diag-page", "diag-secure", "diag-media-session", "diag-audio-analysis", "diag-dialog", "diag-storage"]]
];

function buildReport() {
  const lines = ["Bragi Browser diagnostics", `Generated: ${new Date().toISOString()}`, ""];
  lines.push(`Checks: ${$("diagnostics-status").textContent.trim() || "Not run"}`);
  for (const [heading, ids] of reportGroups) {
    lines.push("", `## ${heading}`);
    for (const id of ids) {
      const node = $(id);
      const label = node.closest("div").querySelector("dt").textContent.trim();
      const tone = node.dataset.tone ? ` [${node.dataset.tone.toUpperCase()}]` : "";
      lines.push(`${label}${tone}: ${node.textContent.trim()}`);
    }
  }
  const entries = activityEntries();
  lines.push("", "## Recent activity");
  lines.push(...(entries.length ? entries : ["No activity yet."]));
  return redact(lines.join("\n"));
}

async function copyText(text) {
  if (navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
    await navigator.clipboard.writeText(text);
    return;
  }
  const field = document.createElement("textarea");
  field.value = text;
  field.setAttribute("readonly", "");
  field.style.position = "fixed";
  field.style.opacity = "0";
  document.body.append(field);
  field.select();
  try {
    if (!document.execCommand("copy")) throw new Error("Copy was rejected.");
  } finally {
    field.remove();
  }
}

async function copyReport() {
  try {
    await copyText(buildReport());
    setStatus("Redacted report copied to clipboard.", "ok");
  } catch {
    setStatus("Could not copy the report in this browser.", "error");
  }
}

async function checkServerApi(signal) {
  if (!state.auth) {
    try {
      const base = await configuredServerBase();
      checks.serverConfig = {tone: "ok", detail: `Configured: ${safe(() => new URL(base).origin, base)}`};
    } catch (error) {
      checks.serverConfig = {tone: "error", detail: error.message || "Could not read server-url.txt."};
    }
    checks.serverApi = {tone: "warn", detail: "Sign in to check the server API."};
    return;
  }
  checks.serverConfig = {tone: "ok", detail: `Connected to ${serverOrigin()}`};
  try {
    const result = await api("/playlists", {signal});
    if (!result || !Array.isArray(result.playlists)) throw new Error("The server returned an invalid playlist list.");
    checks.serverApi = {tone: "ok", detail: `Reachable · ${result.playlists.length} playlists`};
  } catch (error) {
    checks.serverApi = {
      tone: error.name === "AbortError" ? "warn" : "error",
      detail: error.name === "AbortError" ? "Check cancelled." : error.message || "Server check failed."
    };
  }
}

async function checkSearch(signal) {
  let url;
  try { url = new URL("/api/v1/search", state.youtubeSearchInstance); }
  catch { checks.search = {tone: "error", detail: "Search instance URL is invalid."}; return; }
  url.searchParams.set("q", "bragi");
  url.searchParams.set("type", "video");
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(), 8000);
  const abort = () => timeout.abort();
  if (signal.aborted) abort();
  else signal.addEventListener("abort", abort, {once: true});
  try {
    const response = await fetch(url, {
      signal: timeout.signal, headers: {Accept: "application/json"},
      credentials: "omit", referrerPolicy: "no-referrer", cache: "no-store"
    });
    checks.search = response.ok
      ? {tone: "ok", detail: `Reachable (HTTP ${response.status})`}
      : {tone: "error", detail: `Search endpoint returned HTTP ${response.status}.`};
  } catch (error) {
    checks.search = {
      tone: signal.aborted ? "warn" : "error",
      detail: signal.aborted ? "Check cancelled." : "Could not reach the search instance. Check HTTPS and CORS support."
    };
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", abort);
  }
}

export function cancelDiagnostics() {
  if (checkController) checkController.abort();
  checkController = null;
  checks = { serverApi: null, search: null, serverConfig: null };
  $("diagnostics-run").disabled = false;
  setStatus("Checks cancelled.", "warn");
}

export function closeDiagnostics() {
  if ($("diagnostics-panel").hidden) return;
  $("diagnostics-panel").hidden = true;
  $("login-panel").hidden = !!state.auth;
  $("library").hidden = !state.auth;
  $("open-diagnostics").focus();
  syncVisualizer();
}

async function runChecks() {
  if (checkController) checkController.abort();
  const controller = new AbortController();
  checkController = controller;
  checks = {
    serverApi: {tone: "warn", detail: "Checking…"},
    search: {tone: "warn", detail: "Checking…"},
    serverConfig: checks.serverConfig
  };
  $("diagnostics-run").disabled = true;
  setStatus("Running checks…", "warn");
  renderSnapshot();
  await Promise.all([checkServerApi(controller.signal), checkSearch(controller.signal)]);
  if (checkController === controller) {
    checkController = null;
    $("diagnostics-run").disabled = false;
    const tones = Object.values(checks).filter(Boolean).map(check => check.tone);
    const tone = tones.includes("error") ? "error" : tones.includes("warn") ? "warn" : "ok";
    setStatus("Checks complete.", tone);
    renderSnapshot();
  }
}

export function openDiagnostics() {
  $("login-panel").hidden = true;
  $("library").hidden = true;
  $("settings-panel").hidden = true;
  $("diagnostics-panel").hidden = false;
  renderSnapshot();
  $("diagnostics-heading").focus();
  syncVisualizer();
}

export function initDiagnostics() {
  $("open-diagnostics").addEventListener("click", openDiagnostics);
  $("close-diagnostics").addEventListener("click", closeDiagnostics);
  $("diagnostics-run").addEventListener("click", runChecks);
  $("diagnostics-copy").addEventListener("click", copyReport);
}
