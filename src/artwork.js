import { $, log } from "./dom.js";
import { state, visualizer } from "./state.js";
import { setPlayback, seekFromMediaSession } from "./player.js";

export function safeArtworkUrl(value) {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password ? url.href : null;
  } catch {
    return null;
  }
}

export function trackArtwork(video) {
  const thumbnail = safeArtworkUrl(video.thumbnail_url);
  if (video.thumbnail_url != null && !thumbnail) log(`Invalid artwork URL for “${video.name}”; showing the placeholder.`);
  return thumbnail;
}

export function artworkAccent(image) {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 32;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) throw new Error("Canvas is unavailable.");
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
  const hues = Array.from({ length: 24 }, () => ({ weight: 0, red: 0, green: 0, blue: 0 }));
  let visible = false;
  for (let i = 0; i < pixels.length; i += 4) {
    const [red, green, blue, alpha] = pixels.subarray(i, i + 4);
    if (alpha < 32) continue;
    visible = true;
    const max = Math.max(red, green, blue), min = Math.min(red, green, blue), chroma = max - min;
    if (chroma < 20 || max < 25) continue;
    let hue = max === red ? (green - blue) / chroma : max === green ? (blue - red) / chroma + 2 : (red - green) / chroma + 4;
    hue = (hue * 60 + 360) % 360;
    const weight = (alpha / 255) * (0.3 + 0.7 * chroma / 255);
    const bucket = hues[Math.floor(hue / 15)];
    bucket.weight += weight;
    bucket.red += red * weight;
    bucket.green += green * weight;
    bucket.blue += blue * weight;
  }
  if (!visible) throw new Error("Artwork has no visible pixels.");
  const best = hues.reduce((a, b) => b.weight > a.weight ? b : a);
  if (!best.weight) return "hsl(0 0% 80%)";
  const red = best.red / best.weight, green = best.green / best.weight, blue = best.blue / best.weight;
  const max = Math.max(red, green, blue), min = Math.min(red, green, blue), chroma = max - min;
  let hue = max === red ? (green - blue) / chroma : max === green ? (blue - red) / chroma + 2 : (red - green) / chroma + 4;
  hue = Math.round((hue * 60 + 360) % 360);
  return `hsl(${hue} 55% 80%)`;
}

export function updateAccent(url, version) {
  const image = new Image();
  image.crossOrigin = "anonymous";
  image.referrerPolicy = "no-referrer";
  image.onload = () => {
    if (version !== state.artworkVersion) return;
    try {
      const accent = artworkAccent(image);
      document.documentElement.style.setProperty("--accent", accent);
      visualizer.accent = accent;
    }
    catch { log("Could not extract an accent from the artwork; using the default color."); }
  };
  image.onerror = () => {
    if (version === state.artworkVersion) log("Could not sample artwork for an accent; using the default color.");
  };
  image.src = url;
}

export function updateArtwork(source) {
  if (source === state.artworkSource) return;
  state.artworkSource = source;
  state.artworkVersion++;
  document.documentElement.style.removeProperty("--accent");
  visualizer.accent = "";
  const image = $("player-artwork");
  image.hidden = true;
  $("artwork-placeholder").hidden = false;
  image.removeAttribute("src");
  $("player-background").hidden = true;
  $("player-background").removeAttribute("src");
  if (source == null) return;
  const url = safeArtworkUrl(source);
  if (!url) {
    log("Invalid receiver artwork URL; showing the placeholder.");
    return;
  }
  image.src = url;
}

export const mediaActions = {
  play: () => setPlayback(true),
  pause: () => setPlayback(false),
  stop: () => $("stop").click(),
  previoustrack: () => $("previous").click(),
  nexttrack: () => $("next").click(),
  seekto: details => seekFromMediaSession(details.seekTime),
  seekbackward: details => seekFromMediaSession(null, -(Number.isFinite(details.seekOffset) && details.seekOffset > 0 ? details.seekOffset : 10)),
  seekforward: details => seekFromMediaSession(null, Number.isFinite(details.seekOffset) && details.seekOffset > 0 ? details.seekOffset : 10)
};
export const mediaActionStates = {};
let mediaMetadataKey = null;

export function resetMediaSessionCache() {
  mediaMetadataKey = null;
  for (const key of Object.keys(mediaActionStates)) delete mediaActionStates[key];
}

export function syncMediaSession(hasMedia, playing, casting, media, duration, current, canSeek) {
  const session = navigator.mediaSession;
  if (!session) return;
  const active = !!state.auth && hasMedia;
  const castMetadata = casting && media && media.media && media.media.metadata;
  const title = active ? (casting ? castMetadata && castMetadata.title : state.localTitle) || "Bragi" : "";
  const album = active ? (casting ? castMetadata && castMetadata.albumName : state.localQueueSnapshot && state.localQueueSnapshot.name) || "" : "";
  const images = castMetadata && castMetadata.images;
  const artwork = active ? safeArtworkUrl(casting ? Array.isArray(images) && images[0] && images[0].url : state.localArtwork) : null;
  const metadataKey = JSON.stringify([active, title, album, artwork]);
  if (metadataKey !== mediaMetadataKey) {
    session.metadata = active && typeof window.MediaMetadata === "function"
      ? new MediaMetadata({title, album, artwork: artwork ? [{src: artwork}] : []}) : null;
    mediaMetadataKey = metadataKey;
  }
  const playbackState = active ? playing ? "playing" : "paused" : "none";
  if (session.playbackState !== playbackState) session.playbackState = playbackState;
  const enabled = {
    play: active && !$("play-pause").disabled,
    pause: active && !$("play-pause").disabled,
    stop: active && !$("stop").disabled,
    previoustrack: active && !$("previous").disabled,
    nexttrack: active && !$("next").disabled,
    seekto: active && !$("seek").disabled,
    seekbackward: active && !$("seek").disabled,
    seekforward: active && !$("seek").disabled
  };
  for (const [action, handler] of Object.entries(mediaActions)) {
    if (mediaActionStates[action] === "unsupported" || mediaActionStates[action] === enabled[action]) continue;
    try {
      session.setActionHandler(action, enabled[action] ? handler : null);
      mediaActionStates[action] = enabled[action];
    } catch (error) {
      if (error.name !== "TypeError" && error.name !== "NotSupportedError") throw error;
      mediaActionStates[action] = "unsupported";
      log(`Media session action "${action}" is not supported by this browser.`);
    }
  }
  if (typeof session.setPositionState === "function") {
    if (active && canSeek && Number.isFinite(current)) {
      const rate = casting ? 1 : $("audio").playbackRate;
      session.setPositionState({
        duration, position: Math.min(duration, Math.max(0, current)),
        playbackRate: Number.isFinite(rate) && rate > 0 ? rate : 1
      });
    } else session.setPositionState();
  }
}

export function initArtwork() {
  $("player-artwork").addEventListener("load", () => {
    if (!$("player-artwork").hasAttribute("src")) return;
    $("player-artwork").hidden = false;
    $("artwork-placeholder").hidden = true;
    $("player-background").src = $("player-artwork").src;
    updateAccent($("player-artwork").src, state.artworkVersion);
  });
  $("player-artwork").addEventListener("error", () => {
    state.artworkVersion++;
    document.documentElement.style.removeProperty("--accent");
    visualizer.accent = "";
    $("player-artwork").hidden = true;
    $("artwork-placeholder").hidden = false;
    $("player-background").hidden = true;
    $("player-background").removeAttribute("src");
    log("Could not load track artwork; showing the placeholder.");
  });
  $("player-background").addEventListener("load", () => {
    if ($("player-background").hasAttribute("src")) $("player-background").hidden = false;
  });
  $("player-background").addEventListener("error", () => {
    $("player-background").hidden = true;
    log("Could not load the player background artwork.");
  });
}
