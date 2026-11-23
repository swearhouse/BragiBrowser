import { $, message, log } from "./dom.js";
import { state, visualizer } from "./state.js";
import { api, ApiError, requireQueue } from "./api.js";
import { reportError, setBusy, cancelPreparation } from "./shell.js";
import { prepareVisualizer, prepareAudioProxy, stopVisualizer, syncVisualizer } from "./visualizer.js";
import { trackArtwork } from "./artwork.js";
import { updatePlayer } from "./player.js";
import { showTracks } from "./playlists.js";
import { castQueueItems, insertCastItems, waitForCastMediaSession, updateCast, getCastMediaSession } from "./cast.js";

export function stopLocal() {
  cancelLocalPrefetch();
  stopVisualizer(true);
  const audio = $("audio");
  audio.pause();
  audio.removeAttribute("src");
  audio.load();
  state.localQueue = [];
  state.localQueueOrigins = [];
  state.localQueueSnapshot = null;
  state.localIndex = -1;
  state.localPlayingIndex = -1;
  state.localStarting = false;
  state.localTitle = "";
  state.localArtwork = null;
  state.visualizerAccess = "unchecked";
  state.localHasPlayed = false;
  state.localDirectUrl = "";
  state.localUsingPrefetch = false;
  state.localRetry = null;
  updatePlayer();
}

export async function resolveAudio(video, signal) {
  const result = await api("/resolve", { method: "POST", body: { url: video.link }, signal });
  const audio = result && result.audio;
  if (!audio || typeof audio.title !== "string" || !["audio/mp4", "audio/webm"].includes(audio.content_type)) throw new ApiError("Invalid audio response.");
  let url;
  try { url = new URL(audio.url); } catch { throw new ApiError("Invalid audio URL returned by server."); }
  if (url.protocol !== "https:" || url.username || url.password) throw new ApiError("The server returned an unsafe audio URL.");
  return audio;
}

export async function resolveTrack(video, signal, failure = "Skipped") {
  let lastError;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await resolveAudio(video, signal);
    } catch (error) {
      if (error.name === "AbortError" || error.status === 401) throw error;
      lastError = error;
    }
  }
  log(`${failure} “${video.name}” after 3 resolution attempts: ${lastError.message}`);
  return null;
}

export function cancelLocalPrefetch() {
  const prefetch = state.localPrefetch;
  state.localPrefetch = null;
  if (prefetch) prefetch.controller.abort();
}

export function prefetchNextLocal() {
  const audio = $("audio");
  const session = state.castContext && state.castContext.getCurrentSession();
  const index = state.localPlayingIndex + 1;
  const video = state.localQueue[index];
  if (!state.auth || session || !audio.getAttribute("src") || audio.paused ||
      state.localPlayingIndex < 0 || state.localPlayingIndex !== state.localIndex || !video) {
    cancelLocalPrefetch();
    return;
  }
  if (state.localPrefetch && state.localPrefetch.index === index &&
      state.localPrefetch.video === video && state.localPrefetch.auth === state.auth) return;
  cancelLocalPrefetch();
  const controller = new AbortController();
  const prefetch = {index, video, auth: state.auth, controller, promise: null};
  state.localPrefetch = prefetch;
  prefetch.promise = resolveAudio(video, controller.signal).catch(error => {
    if (error.name !== "AbortError" && state.localPrefetch === prefetch) {
      log(`Could not prefetch “${video.name}”; it will be resolved when needed.`);
    }
    return null;
  });
}

export async function takeLocalPrefetch(index, video, signal) {
  const prefetch = state.localPrefetch;
  if (!prefetch || prefetch.index !== index || prefetch.video !== video || prefetch.auth !== state.auth) {
    cancelLocalPrefetch();
    return null;
  }
  const abort = () => prefetch.controller.abort();
  if (signal.aborted) abort();
  else signal.addEventListener("abort", abort, {once: true});
  try {
    const audio = await prefetch.promise;
    if (signal.aborted || state.localPrefetch !== prefetch) return null;
    state.localPrefetch = null;
    return audio;
  } finally {
    signal.removeEventListener("abort", abort);
  }
}

export async function startPlayback(playlistId = null, selection = null) {
  if (state.busy || state.castLoading || !state.auth) return;
  cancelLocalPrefetch();
  const session = state.castContext && state.castContext.getCurrentSession();
  const output = session ? "cast" : "local";
  const castSessionVersion = state.castSessionVersion;
  cancelPreparation();
  const generation = state.generation;
  const controller = new AbortController();
  state.controller = controller;
  state.preparingOutput = output;
  setBusy(true);
  try {
    let queue;
    if (playlistId !== null) {
      message("Creating the shared server queue…");
      try {
        queue = requireQueue(await api("/queue", { method: "POST", body: { playlist_id: playlistId, shuffle: $("auto-shuffle").checked }, signal: controller.signal }));
      } catch (error) {
        if (error.uncertain) {
          try {
            const current = requireQueue(await api("/queue", { signal: controller.signal }));
            $("queue-status").textContent = `Current server queue: ${current.name} (${current.videos.length} tracks). It may or may not be the requested queue.`;
          } catch (checkError) {
            if (checkError.status === 401 || checkError.name === "AbortError") throw checkError;
            $("queue-status").textContent = "Could not determine the current server queue.";
          }
          throw new ApiError("Queue creation outcome is uncertain. Check the queue status before retrying.");
        }
        throw error;
      }
    } else {
      queue = requireQueue(await api("/queue", { signal: controller.signal }));
    }
    if (generation !== state.generation) return;
    if (!queue.videos.length) throw new ApiError("The current queue has no tracks.");
    let startIndex = 0;
    if (selection && playlistId === null) {
      if (queue.id !== selection.queueId || selection.index >= queue.videos.length) {
        throw new ApiError("The server queue changed. Select a playlist to create a new queue.");
      }
      startIndex = selection.index;
    } else if (selection) {
      let occurrence = 0;
      startIndex = queue.videos.findIndex(video => {
        if (video.name !== selection.video.name || video.link !== selection.video.link) return false;
        return ++occurrence === selection.occurrence;
      });
      if (startIndex < 0) throw new ApiError("The selected track is no longer in the playlist. Refresh and try again.");
    }
    $("queue-status").textContent = `Server queue: ${queue.name} (${queue.videos.length} tracks${queue.shuffled ? ", shuffled" : ""}).`;
    state.lastQueue = queue;
    if (state.displayedIsQueue) showTracks(queue, true);
    else $("toggle-track-view").hidden = false;
    if (output === "local") {
      stopLocal();
      prepareVisualizer();
      state.localQueue = queue.videos.slice();
      state.localQueueOrigins = queue.videos.map((_, index) => index);
      state.localQueueSnapshot = queue;
      state.localIndex = startIndex - 1;
      await nextLocal(generation, controller.signal);
    } else {
      if (state.castContext.getCurrentSession() !== session) throw new ApiError("The Cast session changed. Reconnect and try again.");
      if ((session.getMediaSession() || session.getSessionObj().media.some(media => media.playerState !== "IDLE")) &&
          !window.confirm("The receiver already has media. Replace its current queue?")) {
        message("Receiver queue was not changed.");
        return;
      }
      let prepared;
      try {
        prepared = await api("/cast-queue", { method: "POST", body: { queue_id: queue.id }, signal: controller.signal });
      } catch (error) {
        if (error.status === 404) throw new ApiError("BragiServer must be updated for on-demand Cast playback.");
        throw error;
      }
      if (generation !== state.generation) return;
      if (prepared && !Object.hasOwn(prepared, "batch_size")) {
        throw new ApiError("BragiServer must be updated for configurable Cast batches.");
      }
      if (!prepared || typeof prepared.token !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(prepared.token) ||
          !Number.isInteger(prepared.batch_size) || prepared.batch_size < 1 || prepared.batch_size > 5000) {
        throw new ApiError("The server returned an invalid Cast queue.");
      }
      if (state.castContext.getCurrentSession() !== session || state.castSessionVersion !== castSessionVersion) {
        throw new ApiError("The Cast session changed. Reconnect and try again.");
      }
      const data = new chrome.cast.media.QueueData();
      data.name = queue.name;
      data.repeatMode = chrome.cast.media.RepeatMode.REPEAT_OFF;
      data.items = castQueueItems(queue, prepared.token, startIndex, startIndex + 1);
      data.startIndex = 0;
      data.startTime = 0;
      const request = new chrome.cast.media.LoadRequest(data.items[0].media);
      request.queueData = data;
      request.autoplay = true;
      if (new TextEncoder().encode(JSON.stringify(request)).length > 32000) {
        throw new ApiError("The selected track is too large for the Cast queue.");
      }
      state.castLoading = true;
      setBusy(true);
      message("Sending queue to the receiver; this request cannot be cancelled.");
      try { await session.loadMedia(request); }
      catch { throw new ApiError("The receiver did not confirm the load. Check its status before trying again."); }
      finally { state.castLoading = false; }
      if (generation !== state.generation) return;
      if (state.castContext.getCurrentSession() !== session || state.castSessionVersion !== castSessionVersion) {
        throw new ApiError("The Cast session changed during loading; check the receiver before retrying.");
      }
      state.castQueue = queue;
      state.castToken = prepared.token;
      stopLocal();
      updateCast();
      const media = await waitForCastMediaSession(
        session, castSessionVersion, generation, controller.signal, queue.id, startIndex,
      );
      const firstId = media.currentItemId;
      const checkSession = () => {
        if (state.castContext.getCurrentSession() !== session || state.castSessionVersion !== castSessionVersion ||
            getCastMediaSession(session) !== media) {
          throw new ApiError("The Cast session changed while sending the queue. Check the receiver before retrying.");
        }
      };
      const insert = async (start, end, before) => {
        checkSession();
        const items = castQueueItems(queue, prepared.token, start, end);
        if (new TextEncoder().encode(JSON.stringify(items)).length > 32000) {
          if (end - start === 1) throw new ApiError("A track is too large for the Cast queue. Playback may already have started.");
          const middle = Math.floor((start + end) / 2);
          await insert(start, middle, before);
          await insert(middle, end, before);
          return;
        }
        try { await insertCastItems(media, items, before); }
        catch { throw new ApiError("The receiver did not confirm the entire queue. Check its queue before retrying."); }
        checkSession();
      };
      state.castLoading = true;
      setBusy(true);
      let sent = 1;
      try {
        for (let start = startIndex + 1; start < queue.videos.length; start += prepared.batch_size) {
          const end = Math.min(start + prepared.batch_size, queue.videos.length);
          await insert(start, end, null);
          sent += end - start;
          message(`Sending queue to the receiver: ${sent} of ${queue.videos.length} songs.`);
        }
        for (let start = 0; start < startIndex; start += prepared.batch_size) {
          const end = Math.min(start + prepared.batch_size, startIndex);
          await insert(start, end, firstId);
          sent += end - start;
          message(`Sending queue to the receiver: ${sent} of ${queue.videos.length} songs.`);
        }
      } finally { state.castLoading = false; }
      message(`Sent ${queue.videos.length} tracks to the receiver. Cast links expire in 7 days or when BragiServer restarts.`);
    }
  } catch (error) {
    if (generation === state.generation) reportError(error);
  } finally {
    if (state.controller === controller) {
      state.controller = null;
      state.preparingOutput = null;
    }
    if (generation === state.generation) {
      setBusy(false);
      prefetchNextLocal();
    }
    else if (!state.castLoading) setBusy(state.busy);
  }
}

export async function nextLocal(generation, signal, direction = 1) {
  const originalIndex = state.localIndex;
  while (state.localIndex + direction >= 0 && state.localIndex + direction < state.localQueue.length) {
    state.localIndex += direction;
    const video = state.localQueue[state.localIndex];
    message(`Resolving local track ${state.localIndex + 1} of ${state.localQueue.length}…`);
    const prefetched = direction > 0 ? await takeLocalPrefetch(state.localIndex, video, signal) : null;
    if (generation !== state.generation || signal.aborted) return;
    const audio = prefetched || await resolveTrack(video, signal);
    if (generation !== state.generation) return;
    if (!audio) continue;
    const wantsVisualizer = $("visualizer-mode").value !== "off" && !visualizer.failure && !!visualizer.context;
    const proxyUrl = wantsVisualizer ? await prepareAudioProxy(audio.url, signal) : null;
    if (generation !== state.generation) return;
    const access = $("visualizer-mode").value === "off" || !wantsVisualizer ? "unchecked" : proxyUrl ? "allowed" : "blocked";
    stopVisualizer();
    state.visualizerAccess = access;
    state.localHasPlayed = false;
    state.localDirectUrl = audio.url;
    state.localUsingPrefetch = !!prefetched;
    if (access === "allowed") $("audio").crossOrigin = "anonymous";
    else $("audio").removeAttribute("crossorigin");
    $("audio").src = access === "allowed" ? proxyUrl : audio.url;
    state.localPlayingIndex = state.localIndex;
    state.localTitle = audio.title;
    state.localArtwork = trackArtwork(video);
    updatePlayer();
    $("queue-status").textContent = `Local playback: ${audio.title} (${state.localIndex + 1} of ${state.localQueue.length}).`;
    state.localStarting = true;
    try {
      await $("audio").play();
      if (generation === state.generation && !(access === "allowed" && state.visualizerAccess === "blocked")) message("Playing locally in this browser.");
      return;
    } catch {
      if (generation !== state.generation || (access === "allowed" && state.visualizerAccess === "blocked")) return;
      log(`Could not start “${video.name}”. Use Play to retry, or choose Next.`);
      message("Browser playback was blocked or failed. Use Play to retry, or choose Next.");
      return;
    } finally {
      if (generation === state.generation) state.localStarting = false;
    }
  }
  if (direction < 0) {
    state.localIndex = originalIndex;
    message("No earlier track could be resolved.");
    return;
  }
  stopLocal();
  message("Local queue finished or no remaining tracks could be resolved.");
}

export async function advanceLocal(direction = 1) {
  if (state.busy || !state.localQueue.length) return;
  if (direction < 0) cancelLocalPrefetch();
  cancelPreparation();
  prepareVisualizer();
  const generation = state.generation;
  const controller = new AbortController();
  state.controller = controller;
  state.preparingOutput = "local";
  setBusy(true);
  try { await nextLocal(generation, controller.signal, direction); }
  catch (error) { if (generation === state.generation) reportError(error); }
  finally {
    if (state.controller === controller) {
      state.controller = null;
      state.preparingOutput = null;
    }
    if (generation === state.generation) setBusy(false);
  }
}

export function retryPrefetchedLocal() {
  const retry = state.localRetry;
  if (!retry || state.busy) return;
  state.localRetry = null;
  if (retry.generation !== state.generation || retry.index !== state.localIndex ||
      !state.localQueue.length || !state.localUsingPrefetch || state.localHasPlayed) return;
  state.localUsingPrefetch = false;
  cancelLocalPrefetch();
  state.localIndex = retry.index - 1;
  log(`Prefetched audio for “${state.localQueue[retry.index].name}” failed; resolving it again.`);
  advanceLocal();
}

export function initLocalPlayback() {
  $("play-selected").addEventListener("click", () => {
    if (state.selectedPlaylistId !== null) startPlayback(state.selectedPlaylistId);
  });
  $("audio").addEventListener("ended", () => advanceLocal());
  $("audio").addEventListener("playing", () => {
    state.localHasPlayed = true;
    syncVisualizer();
    prefetchNextLocal();
  });
  $("audio").addEventListener("error", () => {
    if (!state.localQueue.length || !$("audio").getAttribute("src") || !$("audio").error) return;
    const generation = state.generation;
    const index = state.localIndex;
    const audio = $("audio");
    if (state.visualizerAccess === "allowed") {
      const url = state.localDirectUrl;
      const position = audio.currentTime;
      const shouldPlay = !state.localHasPlayed || !audio.paused;
      state.visualizerAccess = "blocked";
      stopVisualizer(true);
      audio.removeAttribute("crossorigin");
      if (Number.isFinite(position) && position > 0) {
        audio.addEventListener("loadedmetadata", () => {
          if (generation !== state.generation || index !== state.localIndex) return;
          try { audio.currentTime = position; }
          catch { message("Could not restore the browser playback position after visualizer fallback."); }
        }, { once: true });
      }
      audio.src = url;
      log("Audio proxy playback failed; retrying the direct stream without audio analysis.");
      message("Audio proxy playback failed; retrying browser playback normally.");
      updatePlayer();
      if (shouldPlay) audio.play().catch(() => {
        if (generation === state.generation && index === state.localIndex) {
          message("Browser playback could not restart. Use Play to retry.");
        }
      });
      return;
    }
    if (state.localUsingPrefetch && !state.localHasPlayed) {
      state.localRetry = {generation, index};
      setTimeout(retryPrefetchedLocal, 0);
      return;
    }
    setTimeout(() => {
      if (generation !== state.generation || index !== state.localIndex || !state.localQueue.length) return;
      log(`Playback failed for “${state.localQueue[index].name}”; skipping.`);
      advanceLocal();
    }, 0);
  });
}
