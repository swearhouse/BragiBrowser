import {test, expect} from "./fixtures/client.js";

const ONE = "https://youtu.be/abcdefghijk";
const BAD = "https://youtu.be/12345678901";
const COVER = "https://artwork.example/cover.png";
const DIRECT = "https://media.example/signed-secret";
const PROXY = "https://server.example/api/v1/audio-stream?token=proxy-secret";

async function clickById(client, id) {
  await client.page.evaluate(id => document.getElementById(id).click(), id);
}

async function waitForIdle(client) {
  await expect.poll(async () => (await client.state()).busy).toBe(false);
}

async function waitForLocalPlayback(client) {
  await expect(client.el("queue-status")).toContainText("Local playback:");
  await waitForIdle(client);
}

async function waitForGate(client, name) {
  await expect.poll(() => client.page.evaluate(gate => typeof window.__harness.gates[gate], name)).toBe("function");
}

async function setVisualizerMode(client, mode) {
  await clickById(client, "open-settings");
  await client.el("visualizer-mode").selectOption(mode);
  await clickById(client, "close-settings");
}

async function setAutoShuffle(client, checked) {
  await clickById(client, "open-settings");
  if (checked) await client.el("auto-shuffle").check();
  else await client.el("auto-shuffle").uncheck();
  await clickById(client, "close-settings");
}

async function queueSong(client, index) {
  const menu = client.page.locator(".track-menu").nth(index);
  await menu.evaluate(element => { element.open = true; });
  await menu.locator(".queue-song").evaluate(element => element.click());
}

async function resolveCount(client, url) {
  return client.page.evaluate(expected => window.__harness.requests.filter(request =>
    request.path.endsWith("/resolve") && JSON.parse(request.body).url === expected).length, url);
}

async function mediaSnapshot(client) {
  return client.page.evaluate(() => {
    const session = window.__harness.mediaSession;
    return {
      metadata: session.metadata && {
        title: session.metadata.title,
        album: session.metadata.album,
        artwork: session.metadata.artwork.map(item => item.src)
      },
      playbackState: session.playbackState,
      position: session.position && {...session.position},
      handlers: Object.fromEntries(Object.entries(window.__harness.mediaHandlers).map(([action, handler]) =>
        [action, handler === null ? null : typeof handler]))
    };
  });
}

async function mediaCall(client, action, details = {}) {
  await client.page.evaluate(async ({action, details}) => {
    const handler = window.__harness.mediaHandlers[action];
    if (typeof handler !== "function") throw new Error(`No ${action} handler`);
    await handler(details);
  }, {action, details});
}

async function audioProperty(client, name) {
  return client.page.evaluate(property => document.getElementById("audio")[property], name);
}

async function audioSrc(client) {
  return client.page.evaluate(() => document.getElementById("audio").getAttribute("src"));
}

async function setQueueIndexes(client, indexes) {
  await client.page.evaluate(indexes => {
    const harness = window.__harness;
    harness.controls.currentQueue = {...harness.queue, id: "q", videos: indexes.map(index => harness.videos[index])};
  }, indexes);
}

async function measureSpectrum(client, {level = 200, low = false, descending = false} = {}) {
  return client.page.evaluate(async ({level, low, descending}) => {
    Object.assign(window.__harness.controls, {spectrumLevel: level, lowFrequencyOnly: low, descendingSpectrum: descending});
    const canvas = document.getElementById("visualizer");
    canvas.getBoundingClientRect = () => ({width: 160, height: 100});
    const app = await window.__harness.app();
    app.visualizer.drawVisualizer();
    cancelAnimationFrame(app.visualizerState.frame);
    app.visualizerState.frame = 0;
    const {width, height} = canvas;
    const pixels = canvas.getContext("2d").getImageData(0, 0, width, height).data;
    const quadrants = [0, 0, 0, 0];
    let total = 0;
    let center = 0;
    let leftEdge = 0;
    let rightEdge = 0;
    let centerLeft = 0;
    let centerRight = 0;
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      if (!pixels[(y * width + x) * 4 + 3]) continue;
      total++;
      quadrants[(y >= height / 2 ? 2 : 0) + (x >= width / 2 ? 1 : 0)]++;
      if (Math.abs(x - width / 2) < height * 0.08 && Math.abs(y - height / 2) < height * 0.08) center++;
      if (x < width * 0.1) leftEdge++;
      if (x >= width * 0.9) rightEdge++;
      if (x >= width * 0.4 && x < width * 0.5) centerLeft++;
      if (x >= width * 0.5 && x < width * 0.6) centerRight++;
    }
    return {total, quadrants, center, leftEdge, rightEdge, centerLeft, centerRight};
  }, {level, low, descending});
}

test("local FIFO queue preserves order and starts the selected duplicate by occurrence", async ({client}) => {
  await client.login();
  await client.selectPlaylist();
  await client.el("track-search").fill("one");
  await expect(client.page.locator("#tracks li:visible")).toHaveCount(2);
  const before = await resolveCount(client, ONE);
  await client.page.locator("#tracks li:visible .track-button").nth(1).click();
  await expect(client.el("queue-status")).toContainText("(3 of 3)");
  await waitForIdle(client);
  expect(await resolveCount(client, ONE)).toBe(before + 1);
  expect((await client.state()).localQueue.map(video => video.name)).toEqual(["One", "Bad", "One"]);
  expect(await client.el("player-title")).toHaveText("One");
  await expect(client.page.locator("#tracks li:visible .track-button").nth(1)).toHaveAttribute("aria-current", "true");
  await client.el("track-search").fill("");
  expect(await client.page.evaluate(() => window.__harness.controls.currentQueue.videos.length)).toBe(3);
});

test("an in-flight prefetch is reused when the next local track starts", async ({client}) => {
  await client.login();
  await client.selectPlaylist();
  await client.playSelected();
  await waitForLocalPlayback(client);
  const before = await resolveCount(client, ONE);
  await client.controls({deferredPrefetchUrl: ONE});
  await queueSong(client, 2);
  await waitForGate(client, "finishPrefetch");
  await queueSong(client, 1);
  expect(await client.control("prefetchCancelled")).toBe(false);
  expect((await client.state()).localQueue.map(video => video.name)).toEqual(["One", "One", "Bad", "Bad", "One"]);
  const afterPrefetch = await resolveCount(client, ONE);
  expect(afterPrefetch).toBe(before + 1);
  await clickById(client, "next");
  await expect(client.el("play-selected")).toBeDisabled();
  await client.controls({deferredPrefetchUrl: null});
  await client.release("finishPrefetch");
  await expect(client.el("queue-status")).toContainText("(2 of 5)");
  await waitForIdle(client);
  expect(await resolveCount(client, ONE)).toBe(afterPrefetch);
  await queueSong(client, 2);
  expect((await client.state()).localQueue.map(video => video.name)).toEqual(["One", "One", "Bad", "One", "Bad", "One"]);
});

test("stopping playback cancels and discards an in-flight prefetch", async ({client}) => {
  await client.login();
  await client.selectPlaylist();
  await client.controls({deferredPrefetchUrl: BAD});
  await client.playSelected();
  await waitForGate(client, "finishPrefetch");
  await clickById(client, "stop");
  await expect.poll(() => client.control("prefetchCancelled")).toBe(true);
  expect(await client.page.evaluate(async () => (await window.__harness.app()).stateObject.localPrefetch)).toBe(null);
});

test("a failed prefetch is logged and the track is resolved again when needed", async ({client}) => {
  await client.login();
  await client.selectPlaylist();
  await client.playSelected();
  await waitForLocalPlayback(client);
  await expect(client.el("activity")).toContainText("Could not prefetch “Bad”");
  const failuresBeforeSkip = await client.control("badAttempts");
  await clickById(client, "next");
  await waitForLocalPlayback(client);
  expect(await client.control("badAttempts")).toBe(failuresBeforeSkip + 3);
  await expect(client.el("activity")).toContainText("Skipped “Bad”");
  await expect(client.el("player-title")).toHaveText("One");
});

test("an expired prefetched stream is resolved again after an audio error", async ({client}) => {
  await client.login();
  await setVisualizerMode(client, "off");
  await setQueueIndexes(client, [0, 2]);
  await client.app("localPlayback", "startPlayback", [null, {queueId: "q", index: 0}]);
  await waitForLocalPlayback(client);
  await client.app("localPlayback", "cancelLocalPrefetch");
  await client.controls({deferredPrefetchUrl: ONE});
  await client.app("localPlayback", "prefetchNextLocal");
  await waitForGate(client, "finishPrefetch");
  await client.page.evaluate(() => {
    const original = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function () {
      return new Promise((resolve, reject) => {
        window.__harness.app().then(({stateObject}) => {
          if (!window.__expiredHandled && stateObject.localUsingPrefetch) {
            window.__expiredHandled = true;
            const audio = document.getElementById("audio");
            window.__harness.controls.localError = {code: 4};
            audio.dispatchEvent(new Event("error"));
            window.__harness.controls.localError = null;
            window.__harness.gates.finishFailedPlay = () => reject(new Error("Expired stream"));
          } else original.call(this).then(resolve, reject);
        }, reject);
      });
    };
  });
  const beforeRetry = await resolveCount(client, ONE);
  await clickById(client, "next");
  await client.controls({deferredPrefetchUrl: null});
  await client.release("finishPrefetch");
  await expect.poll(() => client.page.evaluate(() => window.__expiredHandled === true)).toBe(true);
  await client.release("finishFailedPlay");
  await expect(client.el("activity")).toContainText("resolving it again");
  await expect(client.el("queue-status")).toContainText("(2 of 2)");
  await waitForIdle(client);
  expect(await resolveCount(client, ONE)).toBe(beforeRetry + 1);
});

test("Media Session publishes metadata, state, position, and action handlers", async ({client}) => {
  await client.login();
  await setQueueIndexes(client, [0, 0, 0]);
  await client.app("localPlayback", "startPlayback", [null, {queueId: "q", index: 1}]);
  await waitForLocalPlayback(client);
  const media = await mediaSnapshot(client);
  expect(media.metadata).toEqual({title: "One", album: "Mix", artwork: [COVER]});
  expect(media.playbackState).toBe("playing");
  expect(media.position).toEqual({duration: 180, position: 0, playbackRate: 1});
  expect(media.handlers).toEqual({
    play: "function", pause: "function", stop: "function", previoustrack: "function",
    nexttrack: "function", seekto: "function", seekbackward: "function", seekforward: "function"
  });
});

test("Media Session play and pause handlers are idempotent", async ({client}) => {
  await client.login();
  await setQueueIndexes(client, [0, 0, 0]);
  await client.app("localPlayback", "startPlayback", [null, {queueId: "q", index: 1}]);
  await waitForLocalPlayback(client);
  await mediaCall(client, "pause");
  await mediaCall(client, "pause");
  expect(await client.control("localPaused")).toBe(true);
  expect((await mediaSnapshot(client)).playbackState).toBe("paused");
  await mediaCall(client, "play");
  await mediaCall(client, "play");
  expect(await client.control("localPaused")).toBe(false);
  expect((await mediaSnapshot(client)).playbackState).toBe("playing");
});

test("Media Session seek handlers clamp and use default relative offsets", async ({client}) => {
  await client.login();
  await setQueueIndexes(client, [0, 0, 0]);
  await client.app("localPlayback", "startPlayback", [null, {queueId: "q", index: 1}]);
  await waitForLocalPlayback(client);
  await mediaCall(client, "seekto", {seekTime: 500});
  expect(await client.control("localTime")).toBe(180);
  expect((await mediaSnapshot(client)).position.position).toBe(180);
  await mediaCall(client, "seekbackward", {seekOffset: 20});
  expect(await client.control("localTime")).toBe(160);
  await mediaCall(client, "seekforward", {});
  expect(await client.control("localTime")).toBe(170);
  await mediaCall(client, "seekto", {seekTime: -5});
  expect(await client.control("localTime")).toBe(0);
  expect((await mediaSnapshot(client)).position.position).toBe(0);
});

test("a paused Media Session can be reclaimed with the reclaim button", async ({client}) => {
  await client.login();
  await client.selectPlaylist();
  await client.playSelected();
  await waitForLocalPlayback(client);
  await expect(client.el("reclaim-media-session")).toBeHidden();
  await mediaCall(client, "pause");
  await expect(client.el("reclaim-media-session")).toBeVisible();
  await clickById(client, "reclaim-media-session");
  await expect(client.el("reclaim-media-session")).toBeHidden();
  await expect(client.el("status")).toContainText("Reclaim request sent");
  await expect.poll(() => client.control("localPaused")).toBe(true);
  await mediaCall(client, "play");
  await expect(client.el("reclaim-media-session")).toBeHidden();
  await expect.poll(() => client.control("localPaused")).toBe(false);
});

test("track thumbnails setting can be toggled and renders thumbnails", async ({client}) => {
  await client.login();
  await client.selectPlaylist();
  await expect(client.page.locator(".track-thumb, .track-thumb-placeholder")).toHaveCount(0);
  await clickById(client, "open-settings");
  await client.el("show-track-thumbs").check();
  await expect.poll(async () => client.page.evaluate(() => localStorage.getItem("bragi.trackThumbs"))).toBe("true");
  await clickById(client, "close-settings");
  await expect(client.page.locator(".track-thumb, .track-thumb-placeholder")).toHaveCount(3);
  await expect(client.page.locator(".track-thumb").first()).toHaveAttribute("src", /artwork\.example/);
  await clickById(client, "open-settings");
  await client.el("show-track-thumbs").uncheck();
  await clickById(client, "close-settings");
  await expect(client.page.locator(".track-thumb, .track-thumb-placeholder")).toHaveCount(0);
});

test("an unsupported Media Session action does not block the remaining controls", async ({client}) => {
  await client.login();
  await client.selectPlaylist();
  await client.playSelected();
  await waitForLocalPlayback(client);
  await client.page.evaluate(() => { window.__harness.mediaSession.unsupported = "seekforward"; });
  await client.page.evaluate(async () => {
    const app = await window.__harness.app();
    delete app.artwork.mediaActionStates.seekforward;
  });
  await client.resetMediaSessionCache();
  await client.updatePlayer();
  await expect(client.el("activity")).toContainText("Media session action \"seekforward\"");
  expect((await mediaSnapshot(client)).handlers.nexttrack).toBe("function");
  await client.page.evaluate(() => { window.__harness.mediaSession.unsupported = null; });
  await client.page.evaluate(async () => {
    const app = await window.__harness.app();
    delete app.artwork.mediaActionStates.seekforward;
  });
  await client.resetMediaSessionCache();
  await client.updatePlayer();
  expect((await mediaSnapshot(client)).handlers.seekforward).toBe("function");
});

test("playback still works when navigator.mediaSession is unavailable", async ({client}) => {
  await client.login();
  await client.selectPlaylist();
  await client.playSelected();
  await waitForLocalPlayback(client);
  await client.page.evaluate(() => {
    const descriptor = Object.getOwnPropertyDescriptor(navigator, "mediaSession");
    Object.defineProperty(navigator, "mediaSession", {value: undefined, configurable: true});
    window.__restoreMediaSession = () => Object.defineProperty(navigator, "mediaSession", descriptor);
  });
  await client.resetMediaSessionCache();
  await client.updatePlayer();
  expect(await client.control("localPaused")).toBe(false);
  await expect(client.el("player-title")).toHaveText("One");
  await client.page.evaluate(() => window.__restoreMediaSession());
  await client.resetMediaSessionCache();
  await client.updatePlayer();
  expect((await mediaSnapshot(client)).metadata.title).toBe("One");
});

test("auto-scroll centers the current track and pauses for manual scrolling", async ({client}) => {
  await client.login();
  await client.selectPlaylist();
  await client.playSelected();
  await waitForLocalPlayback(client);
  expect(await client.page.evaluate(() => matchMedia("(prefers-reduced-motion: reduce)").matches)).toBe(true);
  await client.page.evaluate(() => {
    const list = document.getElementById("tracks");
    list.style.maxHeight = "70px";
    window.__harness.captureScrollTimer();
  });
  await client.setState({localPlayingIndex: 1});
  await client.updatePlayer();
  await expect.poll(() => client.page.evaluate(() => document.getElementById("tracks").scrollTop)).toBeGreaterThan(0);
  await client.page.evaluate(() => {
    document.getElementById("tracks").dispatchEvent(new WheelEvent("wheel", {bubbles: true, deltaY: 10}));
    document.getElementById("tracks").scrollTop = 0;
  });
  await client.setState({localPlayingIndex: 2});
  await client.updatePlayer();
  await client.updatePlayer();
  expect(await client.page.evaluate(() => document.getElementById("tracks").scrollTop)).toBe(0);
  expect(await client.page.evaluate(() => typeof window.__harness.scrollResume)).toBe("function");
  await client.page.evaluate(() => {
    document.getElementById("tracks").dispatchEvent(new Event("touchmove", {bubbles: true}));
  });
  expect(await client.page.evaluate(() => typeof window.__harness.scrollResume)).toBe("function");
  await client.page.evaluate(() => {
    document.getElementById("tracks").dispatchEvent(new Event("pointerdown", {bubbles: true}));
  });
  expect(await client.page.evaluate(() => typeof window.__harness.scrollResume)).toBe("function");
  await client.page.evaluate(() => window.__harness.scrollResume());
  expect(await client.page.evaluate(() => {
    const list = document.getElementById("tracks");
    return list.scrollTop === list.scrollHeight - list.clientHeight;
  })).toBe(true);
  await client.page.evaluate(() => window.__harness.releaseScrollTimer());
});

test("artwork load applies a sampled accent and background", async ({client}) => {
  await client.login();
  await client.selectPlaylist();
  await client.playSelected();
  await waitForLocalPlayback(client);
  await expect(client.el("player-artwork")).toHaveAttribute("src", COVER);
  const before = await client.page.evaluate(() => ({
    button: getComputedStyle(document.getElementById("play-selected")).backgroundColor,
    primary: getComputedStyle(document.getElementById("login-button")).backgroundColor,
    page: getComputedStyle(document.body).backgroundImage,
    queue: getComputedStyle(document.querySelector(".queue-card")).backgroundImage
  }));
  await client.page.evaluate(() => document.getElementById("player-artwork").dispatchEvent(new Event("load")));
  await expect(client.el("player-artwork")).toBeVisible();
  await expect(client.el("artwork-placeholder")).toBeHidden();
  await expect(client.el("player-background")).toHaveAttribute("src", COVER);
  const request = await client.page.evaluate(() => {
    const image = window.__harness.paletteRequests[0];
    return {crossOrigin: image.crossOrigin, url: image.imageUrl};
  });
  expect(request).toEqual({crossOrigin: "anonymous", url: COVER});
  await client.page.evaluate(() => window.__harness.paletteRequests[0].onload());
  expect(await client.page.evaluate(() => document.documentElement.style.getPropertyValue("--accent").trim())).toBe("hsl(0 55% 80%)");
  const after = await client.page.evaluate(() => ({
    button: getComputedStyle(document.getElementById("play-selected")).backgroundColor,
    primary: getComputedStyle(document.getElementById("login-button")).backgroundColor,
    page: getComputedStyle(document.body).backgroundImage,
    queue: getComputedStyle(document.querySelector(".queue-card")).backgroundImage
  }));
  expect(after.button).toBe(before.button);
  expect(after.primary).not.toBe(before.primary);
  expect(after.page).not.toBe(before.page);
  expect(after.queue).not.toBe(before.queue);
  await client.page.evaluate(() => document.getElementById("player-background").dispatchEvent(new Event("load")));
  await expect(client.el("player-background")).toBeVisible();
});

test("stale artwork samples and load errors restore the placeholder styling", async ({client}) => {
  await client.login();
  await client.selectPlaylist();
  await client.playSelected();
  await waitForLocalPlayback(client);
  const defaults = await client.page.evaluate(() => ({
    page: getComputedStyle(document.body).backgroundImage,
    queue: getComputedStyle(document.querySelector(".queue-card")).backgroundImage
  }));
  await client.page.evaluate(() => document.getElementById("player-artwork").dispatchEvent(new Event("load")));
  await client.page.evaluate(() => window.__harness.paletteRequests[0].onload());
  await client.page.evaluate(() => document.getElementById("player-artwork").dispatchEvent(new Event("load")));
  const pending = await client.page.evaluate(() => window.__harness.paletteRequests.length - 1);
  await client.page.evaluate(() => document.getElementById("player-artwork").dispatchEvent(new Event("error")));
  await expect(client.el("player-artwork")).toBeHidden();
  await expect(client.el("artwork-placeholder")).toBeVisible();
  await expect(client.el("player-background")).toBeHidden();
  expect(await client.page.evaluate(() => document.getElementById("player-background").hasAttribute("src"))).toBe(false);
  await client.page.evaluate(index => window.__harness.paletteRequests[index].onload(), pending);
  expect(await client.page.evaluate(() => document.documentElement.style.getPropertyValue("--accent").trim())).toBe("");
  expect(await client.page.evaluate(() => getComputedStyle(document.body).backgroundImage)).toBe(defaults.page);
  expect(await client.page.evaluate(() => getComputedStyle(document.querySelector(".queue-card")).backgroundImage)).toBe(defaults.queue);
  await expect(client.el("activity")).toContainText("Could not load track artwork");
});

test("unsafe artwork URLs are rejected and logged", async ({client}) => {
  await client.login();
  await client.page.evaluate(() => { window.__harness.videos[2].thumbnail_url = "javascript:alert(1)"; });
  await client.app("localPlayback", "startPlayback", [null, {queueId: "q", index: 2}]);
  await waitForLocalPlayback(client);
  expect(await client.page.evaluate(() => document.getElementById("player-artwork").hasAttribute("src"))).toBe(false);
  await expect(client.el("artwork-placeholder")).toBeVisible();
  await expect(client.el("activity")).toContainText("Invalid artwork URL");
});

test("proxy requests use the resolved URL and account authentication", async ({client}) => {
  await client.login();
  await client.selectPlaylist();
  await client.playSelected();
  await waitForLocalPlayback(client);
  expect(await audioSrc(client)).toBe(PROXY);
  const request = await client.page.evaluate(() => {
    const found = window.__harness.requests.find(item => item.path.endsWith("/audio-proxy"));
    return {method: found.method, body: JSON.parse(found.body), authorization: found.headers.Authorization};
  });
  expect(request.method).toBe("POST");
  expect(request.body).toEqual({url: DIRECT});
  expect(request.authorization.startsWith("Basic ")).toBe(true);
  expect(await client.page.evaluate(() => document.getElementById("audio").crossOrigin)).toBe("anonymous");
  expect(await client.control("captures")).toBeGreaterThan(0);
  await expect(client.el("visualizer")).toBeVisible();
});

test("visualizer setup opens and closes an audio capture without changing playback", async ({client}) => {
  await client.login();
  await client.selectPlaylist();
  await client.playSelected();
  await waitForLocalPlayback(client);
  const initialCaptures = await client.control("captures");
  const initialContexts = await client.control("audioContexts");
  expect(initialCaptures).toBeGreaterThan(0);
  expect(initialContexts).toBeGreaterThan(0);
  await clickById(client, "open-settings");
  expect(await client.control("localPaused")).toBe(false);
  expect(await client.control("stoppedCaptures")).toBeGreaterThan(0);
  expect(await client.control("closedContexts")).toBe(0);
  await expect(client.el("visualizer")).toBeHidden();
  await clickById(client, "close-settings");
  await expect(client.el("visualizer")).toBeVisible();
  await expect.poll(() => client.control("captures")).toBeGreaterThan(initialCaptures);
  expect(await client.control("audioContexts")).toBe(initialContexts);
  expect(await client.control("localPaused")).toBe(false);
  await setVisualizerMode(client, "off");
  expect(await client.control("closedContexts")).toBeGreaterThan(0);
  await setVisualizerMode(client, "bars");
  await expect.poll(() => client.control("audioContexts")).toBeGreaterThan(initialContexts);
  await clickById(client, "stop");
  await expect(client.el("visualizer")).toBeHidden();
  expect(await client.control("stoppedCaptures")).toBeGreaterThan(0);
  expect(await client.control("closedContexts")).toBeGreaterThan(1);
});

test("spectrum bars respond to audio and low-frequency-only data", async ({client}) => {
  await client.login();
  await client.selectPlaylist();
  await client.playSelected();
  await waitForLocalPlayback(client);
  await setVisualizerMode(client, "bars");
  expect(await client.page.evaluate(() => getComputedStyle(document.getElementById("visualizer")).filter)).toBe("blur(10px) saturate(1.4)");
  const active = await measureSpectrum(client);
  const silent = await measureSpectrum(client, {level: 0});
  expect(active.total).toBeGreaterThan(0);
  expect(silent.total).toBe(0);
  const bass = await measureSpectrum(client, {low: true});
  expect(bass.leftEdge).toBeGreaterThan(0);
  expect(bass.rightEdge).toBeGreaterThan(0);
});

test("mirrored spectrum is symmetric and radiates from the center", async ({client}) => {
  await client.login();
  await client.selectPlaylist();
  await client.playSelected();
  await waitForLocalPlayback(client);
  await setVisualizerMode(client, "mirrored");
  const active = await measureSpectrum(client);
  expect(active.total).toBeGreaterThan(0);
  expect((await measureSpectrum(client, {level: 0})).total).toBe(0);
  const top = active.quadrants[0] + active.quadrants[1];
  const bottom = active.quadrants[2] + active.quadrants[3];
  expect(Math.abs(top - bottom)).toBeLessThan(active.total * 0.05);
  const bass = await measureSpectrum(client, {descending: true});
  expect(bass.centerLeft).toBeGreaterThan(bass.leftEdge);
  expect(bass.centerRight).toBeGreaterThan(bass.rightEdge);
  expect(bass.leftEdge).toBeGreaterThan(0);
  expect(bass.rightEdge).toBeGreaterThan(0);
});

test("radial spectrum surrounds a clear center", async ({client}) => {
  await client.login();
  await client.selectPlaylist();
  await client.playSelected();
  await waitForLocalPlayback(client);
  await setVisualizerMode(client, "radial");
  const active = await measureSpectrum(client);
  expect(active.total).toBeGreaterThan(0);
  expect((await measureSpectrum(client, {level: 0})).total).toBe(0);
  expect(active.quadrants.every(count => count > 0)).toBe(true);
  expect(active.center).toBe(0);
});

test("turning the visualizer off stops analysis without changing playback", async ({client}) => {
  await client.login();
  await client.selectPlaylist();
  await setVisualizerMode(client, "off");
  const before = await client.page.evaluate(() => window.__harness.requests.filter(request => request.path.endsWith("/audio-proxy")).length);
  await client.playSelected();
  await waitForLocalPlayback(client);
  expect(await client.page.evaluate(() => window.__harness.requests.filter(request => request.path.endsWith("/audio-proxy")).length)).toBe(before);
  expect(await audioSrc(client)).toBe(DIRECT);
  expect(await client.page.evaluate(() => document.getElementById("audio").hasAttribute("crossorigin"))).toBe(false);
  expect(await client.control("localPaused")).toBe(false);
  await expect(client.el("visualizer")).toBeHidden();
  await setVisualizerMode(client, "wave");
  await expect(client.el("visualizer-status")).toContainText("next compatible track");
});

test("unsupported audio capture reports a failure without interrupting playback", async ({client}) => {
  await client.login();
  await client.selectPlaylist();
  await client.page.evaluate(() => window.__harness.setCaptureSupported(false));
  await client.playSelected();
  await waitForLocalPlayback(client);
  await expect(client.el("visualizer-status")).toContainText("not supported");
  expect(await client.control("localPaused")).toBe(false);
});

test("proxy failures fall back to direct playback", async ({client}) => {
  await client.login();
  await client.selectPlaylist();
  await client.controls({mode: "proxy-failed"});
  await client.playSelected();
  await waitForLocalPlayback(client);
  expect(await audioSrc(client)).toBe(DIRECT);
  expect(await client.control("localPaused")).toBe(false);
  await expect(client.el("activity")).toContainText("Could not prepare the audio proxy");
  await expect(client.el("visualizer-status")).toContainText("unavailable");
});

test("invalid and unauthenticated proxy responses are handled safely", async ({client}) => {
  await client.login();
  await client.selectPlaylist();
  await client.controls({mode: "invalid-proxy"});
  await client.playSelected();
  await waitForLocalPlayback(client);
  expect(await audioSrc(client)).toBe(DIRECT);
  await expect(client.el("activity")).toContainText("invalid audio proxy URL");
  expect(await client.control("localPaused")).toBe(false);
  await clickById(client, "stop");
  await client.controls({mode: "proxy-auth"});
  await client.el("play-selected").click();
  await expect(client.el("login-panel")).toBeVisible();
  await expect(client.el("status")).toContainText("Authentication failed");
  expect(await client.control("localPaused")).toBe(true);
});

test("a proxy timeout falls back to direct playback", async ({client}) => {
  await client.login();
  await client.selectPlaylist();
  await client.controls({mode: "proxy-delay"});
  await client.page.evaluate(() => window.__harness.shortenTimeout(5000, 0));
  await client.playSelected();
  await waitForLocalPlayback(client);
  expect(await audioSrc(client)).toBe(DIRECT);
  expect(await client.control("localPaused")).toBe(false);
  await expect(client.el("activity")).toContainText("Request timed out");
});

test("CORS proxy playback failure restores the direct URL and position", async ({client}) => {
  await client.login();
  await client.selectPlaylist();
  await client.playSelected();
  await waitForLocalPlayback(client);
  await client.controls({localTime: 35});
  await client.page.evaluate(() => {
    const audio = document.getElementById("audio");
    window.__harness.controls.localError = {code: 4};
    audio.dispatchEvent(new Event("error"));
    window.__harness.controls.localError = null;
  });
  expect(await audioSrc(client)).toBe(DIRECT);
  expect(await client.page.evaluate(() => document.getElementById("audio").hasAttribute("crossorigin"))).toBe(false);
  await expect(client.el("visualizer-status")).toContainText("unavailable");
  await expect(client.el("activity")).toContainText("Audio proxy playback failed");
  await client.page.evaluate(() => document.getElementById("audio").dispatchEvent(new Event("loadedmetadata")));
  expect(await client.control("localTime")).toBe(35);
});

test("sign-out cancels pending proxy preparation and clears the Media Session", async ({client}) => {
  await client.login();
  await client.selectPlaylist();
  await client.controls({mode: "proxy-delay"});
  await client.playSelected();
  await expect.poll(() => client.control("proxyEntered")).toBe(true);
  await clickById(client, "signout");
  await expect.poll(() => client.control("proxyCancelled")).toBe(true);
  await expect(client.el("status")).toContainText("Signed out");
  await expect(client.el("library")).toBeHidden();
  const media = await mediaSnapshot(client);
  expect(media.metadata).toBe(null);
  expect(media.playbackState).toBe("none");
  expect(media.position).toBe(null);
  expect(Object.values(media.handlers).every(handler => handler === null)).toBe(true);
});

test("play and pause controls update the local player", async ({client}) => {
  await client.login();
  await client.selectPlaylist();
  await client.playSelected();
  await waitForLocalPlayback(client);
  await expect(client.el("play-pause-icon")).toHaveText("pause");
  await clickById(client, "play-pause");
  expect(await client.control("localPaused")).toBe(true);
  await expect(client.el("play-pause-icon")).toHaveText("play_arrow");
  await expect(client.page.locator(".track-button").first()).toHaveAttribute("aria-current", "true");
  await clickById(client, "play-pause");
  expect(await client.control("localPaused")).toBe(false);
  await expect(client.el("play-pause-icon")).toHaveText("pause");
});

test("local seek clamps to the audio duration", async ({client}) => {
  await client.login();
  await client.selectPlaylist();
  await client.playSelected();
  await waitForLocalPlayback(client);
  await client.el("seek").fill("35");
  await client.el("seek").dispatchEvent("change");
  expect(await client.control("localTime")).toBe(35);
  await client.el("seek").fill("500");
  await client.el("seek").dispatchEvent("change");
  expect(await client.control("localTime")).toBe(180);
  await client.el("seek").fill("-5");
  await client.el("seek").dispatchEvent("change");
  expect(await client.control("localTime")).toBe(0);
});

test("volume and mute controls update local audio", async ({client}) => {
  await client.login();
  await client.selectPlaylist();
  await client.playSelected();
  await waitForLocalPlayback(client);
  await client.el("volume").fill("0.4");
  await client.el("volume").dispatchEvent("change");
  expect(await audioProperty(client, "volume")).toBe(0.4);
  await expect(client.el("volume-value")).toHaveText("40%");
  await clickById(client, "mute");
  expect(await audioProperty(client, "muted")).toBe(true);
  expect(await audioProperty(client, "volume")).toBe(0.4);
  await expect(client.el("mute")).toHaveAttribute("aria-label", "Unmute");
  await expect(client.el("mute-icon")).toHaveText("volume_off");
  await clickById(client, "mute");
  expect(await audioProperty(client, "muted")).toBe(false);
  expect(await audioProperty(client, "volume")).toBe(0.4);
  await expect(client.el("mute")).toHaveAttribute("aria-label", "Mute");
});

test("local volume is saved and restored after a reload", async ({client}) => {
  await client.login();
  await client.el("volume").fill("0.35");
  await client.el("volume").dispatchEvent("change");
  await expect.poll(async () => client.page.evaluate(() => localStorage.getItem("bragi.volume"))).toBe("0.35");
  await client.page.reload();
  await expect(client.el("volume")).toHaveValue("0.35");
  await expect(client.el("volume-value")).toHaveText("35%");
  expect(await audioProperty(client, "volume")).toBe(0.35);
});

test("an invalid saved volume falls back to the default", async ({client}) => {
  await client.page.evaluate(() => localStorage.setItem("bragi.volume", "loud"));
  await client.page.reload();
  await expect(client.el("status")).toContainText("The saved volume setting is invalid; the default volume is used.");
  await expect(client.el("volume")).toHaveValue("1");
  expect(await audioProperty(client, "volume")).toBe(1);
});

test("volume storage failures are reported but still change the volume", async ({client}) => {
  await client.login();
  await client.controls({storageFailure: "all"});
  await client.el("volume").fill("0.25");
  await client.el("volume").dispatchEvent("change");
  await expect(client.el("status")).toContainText("Browser storage is unavailable; volume changed for this page but was not saved.");
  expect(await audioProperty(client, "volume")).toBe(0.25);
  expect(await client.page.evaluate(() => localStorage.getItem("bragi.volume"))).toBeNull();
});

test("stop clears the highlight, Media Session, and audio source", async ({client}) => {
  await client.login();
  await client.selectPlaylist();
  await client.playSelected();
  await waitForLocalPlayback(client);
  await clickById(client, "stop");
  await expect(client.page.locator(".track-button[aria-current=true]")).toHaveCount(0);
  const media = await mediaSnapshot(client);
  expect(media.metadata).toBe(null);
  expect(media.playbackState).toBe("none");
  expect(media.position).toBe(null);
  expect(await audioSrc(client)).toBe(null);
});

test("a track that cannot be resolved is skipped after three attempts", async ({client}) => {
  await client.login();
  await client.controls({mode: "proxy-failed"});
  await setQueueIndexes(client, [1, 2]);
  await client.app("localPlayback", "startPlayback", [null, {queueId: "q", index: 0}]);
  await waitForLocalPlayback(client);
  expect(await client.control("badAttempts")).toBe(3);
  await expect(client.el("activity")).toContainText("Skipped “Bad”");
  expect(await client.el("player-title")).toHaveText("One");
  expect(await audioSrc(client)).toBe(DIRECT);
  await expect(client.el("activity")).toContainText("Could not prepare the audio proxy");
});

test("the last queue track disables next in the Media Session", async ({client}) => {
  await client.login();
  await client.selectPlaylist();
  await client.controls({mode: "proxy-failed"});
  await setQueueIndexes(client, [1, 2]);
  await client.app("localPlayback", "startPlayback", [null, {queueId: "q", index: 0}]);
  await waitForLocalPlayback(client);
  const media = await mediaSnapshot(client);
  expect(media.handlers.nexttrack).toBe(null);
  expect(media.handlers.previoustrack).toBe("function");
  expect(media.metadata.artwork).toEqual([]);
  await expect(client.page.locator(".track-button[aria-current=true]")).toHaveCount(1);
  await expect(client.el("activity")).not.toContainText(DIRECT);
});

test("queuing a song from the track menu follows earlier selections", async ({client}) => {
  await client.login();
  await client.selectPlaylist();
  await client.playSelected();
  await waitForLocalPlayback(client);
  await queueSong(client, 2);
  await queueSong(client, 1);
  expect((await client.state()).localQueue.map(video => video.name)).toEqual(["One", "One", "Bad", "Bad", "One"]);
  await clickById(client, "next");
  await waitForLocalPlayback(client);
  await expect(client.el("queue-status")).toContainText("(2 of 5)");
  await queueSong(client, 2);
  expect((await client.state()).localQueue.map(video => video.name)).toEqual(["One", "One", "Bad", "One", "Bad", "One"]);
  await expect(client.el("status")).toContainText("Queued “One”");
});

test("uncertain queue creation reconciles with a GET request", async ({client}) => {
  await client.login();
  await client.selectPlaylist();
  await client.controls({mode: "uncertain"});
  await client.el("play-selected").click();
  await expect(client.el("status")).toContainText("outcome is uncertain");
  await expect(client.el("queue-status")).toContainText("may or may not");
  expect(await client.page.evaluate(() => window.__harness.requests.some(request =>
    request.path.endsWith("/queue") && request.method === "GET"))).toBe(true);
  await waitForIdle(client);
});

test("auto shuffle creates a shuffled server queue", async ({client}) => {
  await client.login();
  await client.selectPlaylist();
  await setAutoShuffle(client, true);
  await client.playSelected();
  await waitForLocalPlayback(client);
  expect(await client.page.evaluate(() => window.__harness.controls.currentQueue.shuffled)).toBe(true);
  expect((await client.state()).lastQueue.shuffled).toBe(true);
  expect((await client.state()).localQueue.map(video => video.name)).toEqual(["Bad", "One", "One"]);
  await setAutoShuffle(client, false);
});

test("selecting a queue track does not replace the queue", async ({client}) => {
  await client.login();
  await client.selectPlaylist();
  await client.playSelected();
  await waitForLocalPlayback(client);
  await clickById(client, "toggle-track-view");
  await expect(client.el("player-title")).toHaveText("One");
  const before = await client.page.evaluate(() => window.__harness.requests.filter(request =>
    request.path.endsWith("/queue") && request.method === "POST").length);
  await client.page.locator("#tracks .track-button").nth(2).evaluate(element => element.click());
  await expect(client.el("queue-status")).toContainText("(3 of 3)");
  await waitForIdle(client);
  expect(await client.page.evaluate(() => window.__harness.requests.filter(request =>
    request.path.endsWith("/queue") && request.method === "POST").length)).toBe(before);
});

test("a changed server queue is detected before playback", async ({client}) => {
  await client.login();
  await client.selectPlaylist();
  await client.playSelected();
  await waitForLocalPlayback(client);
  await clickById(client, "toggle-track-view");
  await client.page.evaluate(() => {
    const harness = window.__harness;
    harness.controls.currentQueue = {...harness.queue, id: "changed"};
  });
  await client.page.locator("#tracks .track-button").first().click();
  await expect(client.el("status")).toContainText("server queue changed");
  await waitForIdle(client);
});

test("an empty playlist cannot be played", async ({client}) => {
  await client.login();
  await client.selectPlaylist("Empty");
  await expect(client.el("play-selected")).toBeDisabled();
  await expect(client.el("tracks-empty")).toContainText("no tracks");
  await expect(client.el("playlist-title")).toContainText("Empty - (0 songs)");
  await expect(client.page.locator(".track-button[aria-current=true]")).toHaveCount(0);
});

test("connecting a Cast session cancels pending browser resolution", async ({client}) => {
  await client.login();
  await client.selectPlaylist();
  await client.installCast();
  await client.setCurrentSession(false);
  await client.updateCast();
  await client.controls({mode: "resolve-delay"});
  await client.el("play-selected").click();
  await expect.poll(() => client.control("resolveEntered")).toBe(true);
  await client.setCurrentSession(true);
  await client.updateCast();
  await expect.poll(() => client.control("cancelled")).toBe(true);
  await expect(client.el("status")).toContainText("preparation cancelled");
});

test("disconnecting a Cast session cancels pending receiver preparation", async ({client}) => {
  await client.login();
  await client.selectPlaylist();
  await client.installCast();
  await client.controls({mode: "cast-delay", allowReplace: true});
  await client.el("play-selected").click();
  await expect.poll(() => client.control("resolveEntered")).toBe(true);
  await client.setCurrentSession(false);
  await client.updateCast();
  await expect.poll(() => client.control("cancelled")).toBe(true);
  await expect(client.el("status")).toContainText("preparation cancelled");
});
