import { $, message } from "./dom.js";
import { state } from "./state.js";
import { ApiError } from "./api.js";
import { reportError, setBusy, cancelPreparation } from "./shell.js";
import { trackArtwork } from "./artwork.js";
import { resolveTrack, prefetchNextLocal, cancelLocalPrefetch } from "./localPlayback.js";
import { updatePlayer } from "./player.js";

export function getCastMediaSession(session) {
  if (!session) return null;
  const media = session.getMediaSession();
  if (media) return media;
  const sessions = session.getSessionObj().media.filter(item => item.playerState !== "IDLE");
  return sessions.length === 1 ? sessions[0] : null;
}

export function castQueueItems(queue, token, start, end) {
  const items = [];
  for (let i = start; i < end; i++) {
    const url = new URL(state.auth.base + `/api/v1/cast-stream/${i}`);
    url.searchParams.set("token", token);
    const media = new chrome.cast.media.MediaInfo(url.href, "audio/mp4");
    media.customData = { bragiBrowser: { queueId: queue.id, index: i } };
    const metadata = new chrome.cast.media.MusicTrackMediaMetadata();
    metadata.title = queue.videos[i].name;
    const thumbnail = trackArtwork(queue.videos[i]);
    if (thumbnail) metadata.images = [new chrome.cast.Image(thumbnail)];
    media.metadata = metadata;
    const item = new chrome.cast.media.QueueItem(media);
    item.autoplay = true;
    items.push(item);
  }
  return items;
}

export async function insertCastItems(media, items, before) {
  const request = new chrome.cast.media.QueueInsertItemsRequest(items);
  if (before != null) request.insertBefore = before;
  await new Promise((resolve, reject) => media.queueInsertItems(request, resolve, reject));
}

export async function queueNext(video) {
  if (!state.auth || state.busy || state.castLoading) return;
  const session = state.castContext && state.castContext.getCurrentSession();
  if (!session) {
    if (!$("audio").getAttribute("src") || !state.localQueue.length || state.localPlayingIndex < 0) {
      message("Start browser playback before queuing a song.");
      return;
    }
    let position = state.localIndex + 1;
    while (position < state.localQueueOrigins.length && state.localQueueOrigins[position] === null) position++;
    state.localQueue.splice(position, 0, video);
    state.localQueueOrigins.splice(position, 0, null);
    prefetchNextLocal();
    updatePlayer();
    message(`Queued “${video.name}” to play next in this browser.`);
    return;
  }
  const media = getCastMediaSession(session);
  if (!media || media.playerState === "IDLE" || media.currentItemId == null) {
    message("Start receiver playback before queuing a song.");
    return;
  }
  const currentId = media.currentItemId;
  const sessionVersion = state.castSessionVersion;
  cancelPreparation();
  const generation = state.generation;
  const controller = new AbortController();
  state.controller = controller;
  state.preparingOutput = "cast";
  setBusy(true);
  try {
    if (!Array.isArray(media.items) || !media.items.some(item => item.itemId === currentId)) {
      throw new ApiError("The receiver did not provide its current queue. Cannot determine where to insert the song.");
    }
    const currentItem = Array.isArray(media.items) && media.items.find(item => item.itemId === currentId);
    const data = currentItem && currentItem.media && currentItem.media.customData;
    const marker = data && data.bragiBrowser;
    const ownedQueue = state.castQueue && data && ((marker && marker.queueId === state.castQueue.id) ||
      data.bragiBrowserNextQueue === state.castQueue.id);
    const index = ownedQueue && state.castToken
      ? state.castQueue.videos.findIndex(item => item.link === video.link) : -1;
    let item;
    let temporary = false;
    if (index >= 0) {
      item = castQueueItems(state.castQueue, state.castToken, index, index + 1)[0];
    } else {
      message(`Preparing “${video.name}” for the receiver…`);
      const audio = await resolveTrack(video, controller.signal, "Could not queue");
      if (!audio) throw new ApiError(`Could not resolve “${video.name}” for the receiver.`);
      const info = new chrome.cast.media.MediaInfo(audio.url, audio.content_type);
      const metadata = new chrome.cast.media.MusicTrackMediaMetadata();
      metadata.title = video.name;
      const thumbnail = trackArtwork(video);
      if (thumbnail) metadata.images = [new chrome.cast.Image(thumbnail)];
      info.metadata = metadata;
      item = new chrome.cast.media.QueueItem(info);
      item.autoplay = true;
      temporary = true;
    }
    if (generation !== state.generation || controller.signal.aborted) return;
    if (state.castContext.getCurrentSession() !== session || state.castSessionVersion !== sessionVersion ||
        getCastMediaSession(session) !== media || media.currentItemId !== currentId) {
      throw new ApiError("Receiver playback changed while preparing the song. Check its queue before trying again.");
    }
    if (!Array.isArray(media.items)) throw new ApiError("The receiver did not provide its queue. Cannot determine where to insert the song.");
    const currentIndex = media.items.findIndex(entry => entry.itemId === currentId);
    if (currentIndex < 0) throw new ApiError("The current receiver track is missing from its queue. Refresh the receiver before trying again.");
    let next = currentIndex + 1;
    while (next < media.items.length && media.items[next].media && media.items[next].media.customData &&
           media.items[next].media.customData.bragiBrowserNext === true) next++;
    const before = next < media.items.length ? media.items[next].itemId : null;
    item.media.customData = {...item.media.customData, bragiBrowserNext: true,
      ...(ownedQueue ? {bragiBrowserNextQueue: state.castQueue.id} : {})};
    state.castLoading = true;
    setBusy(true);
    try { await insertCastItems(media, [item], before); }
    catch { throw new ApiError("The receiver did not confirm the insertion. Check its queue before trying again."); }
    finally { state.castLoading = false; }
    if (generation !== state.generation || state.castContext.getCurrentSession() !== session ||
        state.castSessionVersion !== sessionVersion || getCastMediaSession(session) !== media || media.currentItemId !== currentId) {
      message("The receiver changed while inserting the song. Check its queue before trying again.");
      return;
    }
    if (before != null && Array.isArray(media.items) && !media.items.some(entry => entry.itemId === before)) {
      message("The receiver queue changed while inserting the song. Check its position before trying again.");
      return;
    }
    message(temporary
      ? `Queued “${video.name}” on the receiver. Its temporary link may expire before playback.`
      : `Queued “${video.name}” to play next on the receiver.`);
  } catch (error) {
    if (generation === state.generation) reportError(error);
  } finally {
    if (state.controller === controller) {
      state.controller = null;
      state.preparingOutput = null;
    }
    if (generation === state.generation) setBusy(false);
    else if (!state.castLoading) setBusy(state.busy);
  }
}

export function waitForCastMediaSession(session, sessionVersion, generation, signal, queueId, itemIndex) {
  return new Promise((resolve, reject) => {
    const eventType = cast.framework.SessionEventType.MEDIA_SESSION;
    let settled = false;
    let timeout;
    const cleanup = () => {
      if (timeout) clearTimeout(timeout);
      session.removeEventListener(eventType, onMediaSession);
      signal.removeEventListener("abort", onAbort);
    };
    const fail = error => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const onAbort = () => fail(new DOMException("Cancelled", "AbortError"));
    const onMediaSession = () => {
      if (settled) return;
      if (signal.aborted || generation !== state.generation) {
        fail(new DOMException("Cancelled", "AbortError"));
        return;
      }
      if (state.castContext.getCurrentSession() !== session || state.castSessionVersion !== sessionVersion) {
        fail(new ApiError("The Cast session changed during loading; check the receiver before retrying."));
        return;
      }
      const media = getCastMediaSession(session);
      const currentItem = media && media.media && media.media.customData && media.media.customData.bragiBrowser;
      if (media && media.currentItemId != null && currentItem &&
          currentItem.queueId === queueId && currentItem.index === itemIndex) {
        settled = true;
        cleanup();
        resolve(media);
      }
    };
    session.addEventListener(eventType, onMediaSession);
    signal.addEventListener("abort", onAbort, { once: true });
    timeout = setTimeout(() => {
      onMediaSession();
      if (!settled) {
        fail(new ApiError("Playback started, but the receiver did not report its queue. Check it before retrying."));
      }
    }, 10000);
    onMediaSession();
  });
}

export function updateCast() {
  const session = state.castContext && state.castContext.getCurrentSession();
  if (session !== state.castSession) {
    cancelLocalPrefetch();
    state.castSessionVersion++;
    state.castQueue = null;
    state.castToken = null;
    if (state.busy && !state.castLoading) {
      cancelPreparation();
      message("Cast session changed; preparation cancelled.");
    } else if (state.castLoading) {
      message("Cast session changed during loading; check the receiver before retrying.");
    }
    if (state.castSession) {
      state.castSession.removeEventListener(cast.framework.SessionEventType.MEDIA_SESSION, updateCast);
      state.castSession.removeEventListener(cast.framework.SessionEventType.VOLUME_CHANGED, updateCast);
    }
    state.castSession = session;
    if (!session) prefetchNextLocal();
    if (session) {
      session.addEventListener(cast.framework.SessionEventType.MEDIA_SESSION, updateCast);
      session.addEventListener(cast.framework.SessionEventType.VOLUME_CHANGED, updateCast);
    }
  }
  const media = getCastMediaSession(session);
  if (media !== state.castMedia) {
    if (state.castMedia) state.castMedia.removeUpdateListener(updateCast);
    state.castMedia = media;
    if (media) media.addUpdateListener(updateCast);
  }
  const device = session && session.getCastDevice();
  $("cast-status").textContent = session ? `Connected: ${device && device.friendlyName || "Cast receiver"}` : "No Cast receiver connected";
  updatePlayer();
}

export function onGcCastApiAvailable(available) {
  if (!available) { $("cast-status").textContent = "Cast unavailable in this browser."; return; }
  try {
    state.castContext = cast.framework.CastContext.getInstance();
    state.castContext.setOptions({ receiverApplicationId: chrome.cast.media.DEFAULT_MEDIA_RECEIVER_APP_ID, autoJoinPolicy: chrome.cast.AutoJoinPolicy.ORIGIN_SCOPED });
    state.castContext.addEventListener(cast.framework.CastContextEventType.SESSION_STATE_CHANGED, updateCast);
    updateCast();
  } catch { $("cast-status").textContent = "Cast could not initialize."; }
}

export function castSdkLoadFailed() {
  $("cast-status").textContent = "Cast SDK could not be downloaded.";
}

export async function castCommand(command) {
  const session = state.castContext && state.castContext.getCurrentSession();
  const media = getCastMediaSession(session);
  if (!media) { updateCast(); return; }
  try {
    await new Promise((resolve, reject) => {
      if (command === "stop") media.stop(new chrome.cast.media.StopRequest(), resolve, reject);
      else if (command === "next") media.queueNext(resolve, reject);
      else if (command === "previous") media.queuePrev(resolve, reject);
      else if (command === "pause") media.pause(new chrome.cast.media.PauseRequest(), resolve, reject);
      else media.play(new chrome.cast.media.PlayRequest(), resolve, reject);
    });
    message("Playback command sent to receiver.");
  } catch { message("The receiver did not confirm the playback command."); }
}

export function initCast() {
  window.__onGCastApiAvailable = onGcCastApiAvailable;
  window.castSdkLoadFailed = castSdkLoadFailed;
}
