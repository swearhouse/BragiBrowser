import {test, expect} from "./fixtures/client.js";

async function mediaAction(client, action, detail) {
  await client.page.evaluate(async ({action, detail}) => {
    const {artwork} = await window.__harness.app();
    return artwork.mediaActions[action](detail);
  }, {action, detail});
}

async function setMedia(client, values) {
  await client.page.evaluate(values => Object.assign(window.__harness.media, values), values);
}

async function trackAction(client, index, className) {
  const menu = client.page.locator(".track-menu").nth(index);
  await menu.locator("summary").click();
  await menu.locator(`.${className}`).click();
}

async function latestLoad(client) {
  return client.page.evaluate(() => {
    const load = window.__harness.lastLoad;
    return {
      startIndex: load.queueData.startIndex,
      itemCount: load.queueData.items.length,
      url: load.queueData.items[0].media.url,
      index: load.media.customData.bragiBrowser.index,
      queueId: load.media.customData.bragiBrowser.queueId
    };
  });
}

async function requestCounts(client) {
  return client.page.evaluate(() => {
    const requests = window.__harness.requests;
    return {
      resolve: requests.filter(request => request.path.endsWith("/resolve")).length,
      proxy: requests.filter(request => request.path.endsWith("/audio-proxy")).length
    };
  });
}

async function waitForItems(client, count) {
  await expect.poll(() => client.page.evaluate(() => window.__harness.media.items?.length ?? 0)).toBe(count);
}

async function startCast(client, loads) {
  await client.controls({allowReplace: true});
  await client.el("play-selected").click();
  await expect.poll(() => client.control("loads")).toBe(loads);
  await expect(client.el("play-selected")).toBeEnabled();
}

test("a connected receiver is selected automatically and its OS media actions target the receiver", async ({client}) => {
  await client.login();
  await client.selectPlaylist("Mix");
  await client.installCast();

  await expect(client.el("output-status")).toHaveText("Test");
  await expect(client.el("cast-status")).toHaveText("Connected: Test");
  const mediaSession = await client.page.evaluate(() => {
    const session = window.__harness.mediaSession;
    return {
      title: session.metadata && session.metadata.title,
      playbackState: session.playbackState,
      duration: session.position && session.position.duration,
      position: session.position && session.position.position
    };
  });
  expect(mediaSession).toMatchObject({title: "Existing", playbackState: "playing", duration: 200, position: 20});

  await mediaAction(client, "pause");
  await expect.poll(() => client.control("remoteCommand")).toBe("pause");
  expect(await client.control("localPaused")).toBe(true);

  await setMedia(client, {playerState: "PAUSED"});
  await client.updateCast();
  await mediaAction(client, "play");
  await expect.poll(() => client.control("remoteCommand")).toBe("play");

  await mediaAction(client, "nexttrack");
  await expect.poll(() => client.control("remoteCommand")).toBe("next");
  await mediaAction(client, "previoustrack");
  await expect.poll(() => client.control("remoteCommand")).toBe("previous");
  await mediaAction(client, "stop");
  await expect.poll(() => client.control("remoteCommand")).toBe("stop");

  await mediaAction(client, "seekto", {seekTime: 500});
  await expect.poll(() => client.control("remoteTime")).toBe(200);

  await client.setState({auth: null});
  await client.updatePlayer();
  const signedOut = await client.page.evaluate(() => ({
    metadata: window.__harness.mediaSession.metadata,
    playbackState: window.__harness.mediaSession.playbackState,
    handlers: Object.values(window.__harness.mediaHandlers)
  }));
  expect(signedOut.metadata).toBeNull();
  expect(signedOut.playbackState).toBe("none");
  expect(signedOut.handlers.every(handler => handler === null)).toBe(true);
});

test("reconnect refreshes an active Cast receiver without stopping playback", async ({client}) => {
  await client.login();
  await client.selectPlaylist("Mix");
  await client.installCast();
  await startCast(client, 1);
  await client.el("reconnect-cast").click();
  await client.waitForStatus("Cast receiver connection refreshed.");
  await expect(client.el("cast-status")).toHaveText("Connected: Test");
  await expect(client.el("output-status")).toHaveText("Test");
  expect(await client.control("loads")).toBe(1);
  expect(await client.control("remoteCommand")).toBe("");
});

test("reconnect asks for a receiver when none is connected", async ({client}) => {
  await client.login();
  await client.installCast();
  await client.setCurrentSession(false);
  await client.updateCast();
  await expect(client.el("cast-status")).toHaveText("No Cast receiver connected");
  await client.el("reconnect-cast").click();
  await client.waitForStatus("Cast reconnected.");
  await expect(client.el("cast-status")).toHaveText("Connected: Test");
  await expect(client.el("output-status")).toHaveText("Test");
});

test("reconnect reports when a receiver cannot be selected", async ({client}) => {
  await client.login();
  await client.installCast();
  await client.setCurrentSession(false);
  await client.controls({rejectReconnect: true});
  await client.el("reconnect-cast").click();
  await client.waitForStatus("Could not reconnect to a Cast receiver.");
  await expect(client.el("cast-status")).toHaveText("No Cast receiver connected");
});

test("cast mute is pending-aware, reflects external state, handles unknown state, and reports failures", async ({client}) => {
  await client.login();
  await client.selectPlaylist("Mix");
  await client.page.evaluate(() => { document.getElementById("audio").volume = 0.4; });
  await client.installCast();

  await client.controls({delayMute: true});
  await client.el("mute").click();
  await expect.poll(() => client.page.evaluate(() => typeof window.__harness.gates.finishMute)).toBe("function");
  await expect(client.el("mute")).toBeDisabled();
  await expect(client.el("volume")).toBeDisabled();
  await client.release("finishMute");
  await expect.poll(() => client.control("remoteMuted")).toBe(true);
  await expect(client.el("mute")).toBeEnabled();
  expect(await client.control("remoteVolume")).toBe(0.65);
  expect(await client.page.evaluate(() => document.getElementById("audio").volume)).toBe(0.4);
  expect(await client.page.evaluate(() => document.getElementById("audio").muted)).toBe(false);
  await expect(client.el("mute")).toHaveAttribute("aria-label", "Unmute");

  await client.controls({delayMute: false});
  await client.el("mute").click();
  await expect.poll(() => client.control("remoteMuted")).toBe(false);
  await expect(client.el("mute")).toBeEnabled();
  await expect(client.el("mute-icon")).toHaveText("volume_up");

  await client.controls({remoteMuted: true});
  await client.updateCast();
  await expect(client.el("mute")).toHaveAttribute("aria-label", "Unmute");

  await client.controls({remoteMuted: null});
  await client.updateCast();
  await expect(client.el("mute")).toHaveAttribute("aria-label", "Mute unavailable");
  await expect(client.el("mute")).toBeDisabled();
  await expect(client.el("volume")).toBeEnabled();

  await client.controls({remoteMuted: false, rejectMute: true});
  await client.updateCast();
  await client.el("mute").click();
  await client.waitForStatus("Could not change Chromecast mute state");
  expect(await client.control("remoteMuted")).toBe(false);
  await expect(client.el("mute")).toBeEnabled();
  await expect(client.el("mute")).toHaveAttribute("aria-label", "Mute");
});

test("casting suppresses the visualizer, keeps browser stop control, and follows receiver artwork without stale accents", async ({client}) => {
  await client.login();
  await client.selectPlaylist("Mix");
  await client.playSelected();
  await client.installCast();

  await expect(client.el("visualizer")).toBeHidden();
  await expect(client.el("visualizer-status")).toContainText("while casting");
  await expect(client.el("stop-browser")).toBeVisible();
  await expect(client.el("play-pause-icon")).toHaveText("pause");
  await expect(client.el("player-title")).toHaveText("Existing");
  await expect(client.page.locator('.track-button[aria-current="true"]')).toHaveCount(0);
  expect(await client.el("player-artwork").getAttribute("src")).toBeNull();

  await client.page.evaluate(() => {
    window.__harness.media.media.metadata.images = [{url: "https://artwork.example/receiver.png"}];
  });
  await client.updateCast();
  await expect(client.el("player-artwork")).toHaveAttribute("src", "https://artwork.example/receiver.png");
  expect(await client.page.evaluate(() => window.__harness.mediaSession.metadata.artwork[0].src)).toBe("https://artwork.example/receiver.png");
  const background = await client.page.evaluate(() => {
    document.getElementById("player-artwork").dispatchEvent(new Event("load"));
    document.getElementById("player-background").dispatchEvent(new Event("load"));
    const element = document.getElementById("player-background");
    return {src: element.getAttribute("src"), hidden: element.hidden};
  });
  expect(background.src).toBe("https://artwork.example/receiver.png");
  expect(background.hidden).toBe(false);
  await client.page.evaluate(() => {
    window.__harness.previousAccent = window.__harness.paletteRequests[window.__harness.paletteRequests.length - 1];
  });

  await client.page.evaluate(() => {
    window.__harness.media.media.metadata.images = [{url: "https://artwork.example/next.png"}];
  });
  await client.updateCast();
  await expect(client.el("player-artwork")).toHaveAttribute("src", "https://artwork.example/next.png");
  await expect(client.el("player-background")).toBeHidden();
  expect(await client.el("player-background").getAttribute("src")).toBeNull();

  await client.page.evaluate(() => window.__harness.previousAccent.onload());
  expect(await client.page.evaluate(() => document.documentElement.style.getPropertyValue("--accent"))).toBe("");

  await client.page.evaluate(() => document.getElementById("player-artwork").dispatchEvent(new Event("load")));
  await client.page.evaluate(() => {
    const request = window.__harness.paletteRequests[window.__harness.paletteRequests.length - 1];
    request.onerror();
  });
  expect((await client.log()).join(" ")).toContain("Could not sample artwork");
  expect(await client.page.evaluate(() => document.documentElement.style.getPropertyValue("--accent"))).toBe("");

  await client.page.evaluate(() => document.getElementById("player-artwork").dispatchEvent(new Event("load")));
  await client.page.evaluate(() => {
    const request = window.__harness.paletteRequests[window.__harness.paletteRequests.length - 1];
    const context = request.getContext("2d");
    context.fillStyle = "#0000ff";
    context.fillRect(0, 0, 4, 4);
    request.onload();
  });
  expect(await client.page.evaluate(() => document.documentElement.style.getPropertyValue("--accent"))).toBe("hsl(240 55% 80%)");
});

test("cast time and volume controls, receiver commands, seek protection, and local volume restore work", async ({client}) => {
  await client.login();
  await client.selectPlaylist("Mix");
  await client.playSelected();
  await client.page.evaluate(() => { document.getElementById("audio").volume = 0.4; });
  await client.installCast();

  await expect(client.el("seek")).toHaveValue("20");
  await expect(client.el("seek-duration")).toHaveText("3:20");
  await expect(client.el("volume-value")).toHaveText("65%");

  await setMedia(client, {playerState: "PAUSED"});
  await client.updateCast();
  await expect(client.el("play-pause-icon")).toHaveText("play_arrow");
  await client.el("play-pause").click();
  await expect.poll(() => client.control("remoteCommand")).toBe("play");
  await client.el("next").click();
  await expect.poll(() => client.control("remoteCommand")).toBe("next");
  await client.el("previous").click();
  await expect.poll(() => client.control("remoteCommand")).toBe("previous");
  await client.el("stop").click();
  await expect.poll(() => client.control("remoteCommand")).toBe("stop");

  await client.page.evaluate(() => {
    const seek = document.getElementById("seek");
    seek.value = "50";
    seek.dispatchEvent(new Event("input"));
  });
  await client.updateCast();
  await expect(client.el("seek")).toHaveValue("50");
  await client.page.evaluate(() => document.getElementById("seek").dispatchEvent(new Event("change")));
  await expect.poll(() => client.control("remoteTime")).toBe(50);

  await client.page.evaluate(() => {
    const volume = document.getElementById("volume");
    volume.value = "0.3";
    volume.dispatchEvent(new Event("input"));
    volume.dispatchEvent(new Event("change"));
  });
  await expect.poll(() => client.control("remoteVolume")).toBe(0.3);
  await expect(client.el("volume")).toBeEnabled();

  await client.controls({remoteVolume: 0.75});
  await client.updateCast();
  await expect(client.el("volume-value")).toHaveText("75%");

  await client.controls({seekSupported: false});
  await client.updateCast();
  await expect(client.el("seek")).toBeDisabled();
  const unsupported = await client.page.evaluate(() => ({
    handler: window.__harness.mediaHandlers.seekto,
    position: window.__harness.mediaSession.position
  }));
  expect(unsupported.handler).toBeNull();
  expect(unsupported.position).toBeNull();

  await client.controls({seekSupported: true, rejectSeek: true});
  await client.updateCast();
  await mediaAction(client, "seekto", {seekTime: 80});
  await client.waitForStatus("did not confirm the seek");
  expect(await client.control("remoteTime")).toBe(50);

  await client.controls({rejectSeek: false, rejectVolume: true});
  await client.page.evaluate(() => {
    const volume = document.getElementById("volume");
    volume.value = "0.2";
    volume.dispatchEvent(new Event("input"));
    volume.dispatchEvent(new Event("change"));
  });
  await client.waitForStatus("Could not change Chromecast volume");
  expect(await client.control("remoteVolume")).toBe(0.75);

  await client.setCurrentSession(false);
  await client.updateCast();
  await expect(client.el("volume-value")).toHaveText("40%");
  await expect(client.el("output-status")).toHaveText("This browser");
  await expect(client.el("player-title")).toHaveText("One");
  expect(await client.control("localPaused")).toBe(false);
  await expect(client.page.locator(".track-button").first()).toHaveAttribute("aria-current", "true");
  await expect(client.el("player-artwork")).toHaveAttribute("src", "https://artwork.example/cover.png");
});

test("stop browser only stops local audio and disconnect/reconnect restores browser controls", async ({client}) => {
  await client.login();
  await client.selectPlaylist("Mix");
  await client.playSelected();
  await client.installCast();

  await client.controls({remoteCommand: "unchanged"});
  await client.el("stop-browser").click();
  expect(await client.control("localPaused")).toBe(true);
  await expect(client.el("stop-browser")).toBeHidden();
  expect(await client.control("remoteCommand")).toBe("unchanged");

  await client.page.evaluate(() => {
    const seek = document.getElementById("seek");
    seek.value = "90";
    seek.dispatchEvent(new Event("input"));
  });
  await setMedia(client, {currentItemId: 2});
  await client.updateCast();
  await client.page.evaluate(() => document.getElementById("seek").dispatchEvent(new Event("change")));
  expect(await client.control("remoteTime")).toBe(20);

  await client.setCurrentSession(false);
  await client.updateCast();
  await expect(client.el("seek")).toBeDisabled();
  await expect(client.el("volume")).toBeEnabled();
  await expect(client.el("play-pause")).toBeDisabled();
  expect(await client.control("localPaused")).toBe(true);
  expect(await client.control("loads")).toBe(0);

  await client.setCurrentSession(true);
  await client.updateCast();
  expect(await client.control("loads")).toBe(0);
  await expect(client.el("seek")).toBeEnabled();
  await expect(client.el("volume")).toBeEnabled();
  await expect(client.el("play-pause")).toBeEnabled();
});

test("starting a playlist on a receiver confirms replacement and sends ordered cast queues without premature resolution", async ({client}) => {
  await client.login();
  await client.selectPlaylist("Mix");
  await client.installCast();
  await client.controls({allowReplace: false});

  await client.el("play-selected").click();
  await client.waitForStatus("Receiver queue was not changed.");
  expect(await client.control("loads")).toBe(0);
  await expect(client.el("play-selected")).toBeEnabled();

  const before = await requestCounts(client);
  await startCast(client, 1);
  await waitForItems(client, 3);
  const load = await latestLoad(client);
  expect(load.startIndex).toBe(0);
  expect(load.itemCount).toBe(1);
  expect(load.index).toBe(0);
  expect(load.url).toContain("/api/v1/cast-stream/0?token=");
  const afterLoad = await requestCounts(client);
  expect(afterLoad.resolve).toBe(before.resolve);
  expect(afterLoad.proxy).toBe(before.proxy);

  await expect(client.page.locator(".edit-song")).toHaveCount(3);
  await trackAction(client, 0, "edit-song");
  expect(await client.page.evaluate(() => document.getElementById("edit-song-dialog").open)).toBe(true);
  await waitForItems(client, 3);
  await client.el("edit-song-cancel").click();

  await client.page.evaluate(() => {
    window.__harness.castOriginal = window.__harness.media.items.slice();
    window.__harness.castOriginalId = window.__harness.media.currentItemId;
  });
  await trackAction(client, 1, "queue-song");
  await waitForItems(client, 4);
  await expect(client.el("play-selected")).toBeEnabled();
  await trackAction(client, 2, "queue-song");
  await waitForItems(client, 5);
  await expect(client.el("play-selected")).toBeEnabled();
  const fifo = await client.page.evaluate(() => window.__harness.media.items.map(item => item.media.customData.bragiBrowser.index).join(","));
  expect(fifo).toBe("0,1,0,1,2");
  expect((await requestCounts(client)).resolve).toBe(before.resolve);

  await client.page.evaluate(async () => {
    const {stateObject, playlists} = await window.__harness.app();
    const media = window.__harness.media;
    media.currentItemId = media.items[1].itemId;
    media.media = media.items[1].media;
    stateObject.playlists[0].videos.push({name: "Outside", link: "https://youtu.be/zyxwvutsrqp"});
    playlists.showTracks(stateObject.playlists[0]);
  });
  await trackAction(client, 3, "queue-song");
  await waitForItems(client, 6);
  await expect(client.el("play-selected")).toBeEnabled();
  const outside = await client.page.evaluate(() => ({
    url: window.__harness.media.items[3].media.url,
    next: window.__harness.media.items[4] === window.__harness.castOriginal[1]
  }));
  expect(outside.url).toBe("https://media.example/signed-secret");
  expect(outside.next).toBe(true);
  await client.waitForStatus("may expire");

  await client.page.evaluate(async () => {
    const {playlists, stateObject} = await window.__harness.app();
    const media = window.__harness.media;
    media.items = window.__harness.castOriginal;
    media.currentItemId = window.__harness.castOriginalId;
    media.media = media.items[0].media;
    window.__harness.controls.mode = "queue-resolve-delay";
    playlists.showTracks(stateObject.playlists[0]);
  });
  await client.updateCast();
  await trackAction(client, 3, "queue-song");
  await expect.poll(() => client.page.evaluate(() => typeof window.__harness.gates.finishQueueResolve)).toBe("function");
  await setMedia(client, {currentItemId: 2});
  await client.release("finishQueueResolve");
  await expect(client.el("play-selected")).toBeEnabled();
  await client.waitForStatus("playback changed");
  await waitForItems(client, 3);

  await client.page.evaluate(() => {
    window.__harness.media.currentItemId = window.__harness.castOriginalId;
    window.__harness.media.media = window.__harness.castOriginal[0].media;
  });
  await client.controls({mode: "insert-fail"});
  await client.updateCast();
  await trackAction(client, 1, "queue-song");
  await expect(client.el("play-selected")).toBeEnabled();
  await client.waitForStatus("did not confirm the insertion");
  await waitForItems(client, 3);
});

test("fallback receiver discovery, delayed status, highlights, duplicates, shuffles, and tail-bad queues work", async ({client}) => {
  await client.login();
  await client.selectPlaylist("Mix");
  await client.installCast();
  await startCast(client, 1);

  await client.page.evaluate(() => {
    const media = window.__harness.media;
    document.getElementById("tracks").style.maxHeight = "70px";
    document.getElementById("tracks").scrollTop = 0;
    media.currentItemId = media.items[1].itemId;
    media.media = media.items[1].media;
    media.media.duration = 200;
  });
  await client.controls({frameworkMediaAvailable: false, otherMediaSessions: [{playerState: "IDLE"}]});
  await client.updateCast();
  await expect(client.el("player-title")).toHaveText("Bad");
  await expect(client.el("play-pause")).toBeEnabled();
  await expect(client.el("next")).toBeEnabled();
  await expect(client.page.locator(".track-button").nth(1)).toHaveAttribute("aria-current", "true");
  const centered = await client.page.evaluate(() => {
    const track = document.querySelectorAll(".track-button")[1].getBoundingClientRect();
    const list = document.getElementById("tracks").getBoundingClientRect();
    return Math.abs((track.top + track.bottom) / 2 - (list.top + list.bottom) / 2);
  });
  expect(centered).toBeLessThanOrEqual(1);
  await client.page.evaluate(() => {
    document.getElementById("tracks").style.maxHeight = "";
  });

  await client.el("play-pause").click();
  await expect.poll(() => client.control("remoteCommand")).toBe("pause");
  await client.el("next").click();
  await expect.poll(() => client.control("remoteCommand")).toBe("next");
  await client.page.evaluate(() => {
    const seek = document.getElementById("seek");
    seek.value = "35";
    seek.dispatchEvent(new Event("input"));
    seek.dispatchEvent(new Event("change"));
  });
  await expect.poll(() => client.control("remoteTime")).toBe(35);

  await client.controls({allowReplace: false});
  await client.el("play-selected").click();
  await client.waitForStatus("Receiver queue was not changed.");
  expect(await client.control("loads")).toBe(1);
  await expect(client.el("play-selected")).toBeEnabled();

  await client.page.evaluate(() => {
    window.__harness.controls.otherMediaSessions.push({playerState: "PLAYING"});
  });
  await client.updateCast();
  await expect(client.el("play-pause")).toBeDisabled();
  await client.el("play-selected").click();
  await client.waitForStatus("Receiver queue was not changed.");
  expect(await client.control("loads")).toBe(1);
  await expect(client.el("play-selected")).toBeEnabled();

  await setMedia(client, {playerState: "IDLE"});
  await client.controls({otherMediaSessions: []});
  await client.updateCast();
  await expect(client.el("play-pause")).toBeDisabled();
  await setMedia(client, {playerState: "PLAYING"});
  await client.controls({frameworkMediaAvailable: true, allowReplace: true});
  await client.updateCast();

  await client.page.evaluate(() => {
    const queue = window.__harness.queue;
    window.__harness.controls.currentQueue = {...queue, id: "delayed-status"};
    window.__harness.controls.mode = "load-status-delay";
  });
  await client.el("play-selected").click();
  await expect.poll(() => client.control("loads")).toBe(2);
  await expect.poll(() => client.page.evaluate(() => typeof window.__harness.gates.finishMediaUpdate)).toBe("function");
  await expect(client.el("play-selected")).toBeDisabled();
  await client.release("finishMediaUpdate");
  await client.waitForStatus("Sent 3 tracks to the receiver");
  await expect(client.el("play-selected")).toBeEnabled();
  await waitForItems(client, 3);
  await client.controls({mode: "normal"});
  await client.page.evaluate(() => {
    window.__harness.controls.currentQueue = window.__harness.queue;
  });

  await expect(client.page.locator(".track-button").first()).toHaveAttribute("aria-current", "true");
  const artwork = await client.page.evaluate(() => window.__harness.media.items.map(item => item.media.metadata.images?.[0]?.url ?? null));
  expect(artwork[0]).toBe("https://artwork.example/cover.png");
  expect(artwork[2]).toBeNull();

  await client.page.evaluate(() => {
    const media = window.__harness.media;
    media.currentItemId = media.items[2].itemId;
  });
  await client.updateCast();
  await expect(client.page.locator(".track-button").nth(2)).toHaveAttribute("aria-current", "true");
  await client.page.evaluate(() => {
    const media = window.__harness.media;
    media.media = media.items[2].media;
    media.items = null;
  });
  await client.updateCast();
  await expect(client.page.locator(".track-button").nth(2)).toHaveAttribute("aria-current", "true");
  await setMedia(client, {playerState: "IDLE"});
  await client.updateCast();
  await expect(client.page.locator('.track-button[aria-current="true"]')).toHaveCount(0);
  await setMedia(client, {playerState: "PLAYING"});
  await client.updateCast();
  await expect(client.page.locator(".track-button").nth(2)).toHaveAttribute("aria-current", "true");

  await client.el("toggle-track-view").click();
  await expect(client.page.locator(".track-button").nth(2)).toHaveAttribute("aria-current", "true");
  await client.el("toggle-track-view").click();
  await expect(client.page.locator(".track-button").nth(2)).toHaveAttribute("aria-current", "true");

  await client.selectPlaylist("Mix");
  await expect(client.page.locator(".track-button").nth(2)).toHaveAttribute("aria-current", "true");
  await client.page.locator(".track-button").nth(2).click();
  await expect.poll(() => client.control("loads")).toBe(3);
  await expect(client.el("play-selected")).toBeEnabled();
  const duplicate = await latestLoad(client);
  expect(duplicate.startIndex).toBe(0);
  expect(duplicate.index).toBe(2);
  expect(await client.page.evaluate(() => window.__harness.media.items.map(item => item.media.customData.bragiBrowser.index).join(","))).toBe("0,1,2");

  await client.selectPlaylist("Mix");
  await client.page.locator(".track-button").nth(1).click();
  await expect.poll(() => client.control("loads")).toBe(4);
  await expect(client.el("play-selected")).toBeEnabled();
  expect((await latestLoad(client)).index).toBe(1);

  await client.selectPlaylist("Mix");
  await client.el("open-settings").click();
  await client.el("auto-shuffle").check();
  await client.el("close-settings").click();
  await client.page.locator(".track-button").nth(2).click();
  await expect.poll(() => client.control("loads")).toBe(5);
  await expect(client.el("play-selected")).toBeEnabled();
  expect((await latestLoad(client)).index).toBe(2);

  await client.controls({mode: "tail-bad"});
  await client.selectPlaylist("Mix");
  await client.page.locator(".track-button").nth(1).click();
  await expect.poll(() => client.control("loads")).toBe(6);
  await expect(client.el("play-selected")).toBeEnabled();
  expect((await latestLoad(client)).index).toBe(2);
});

test("large receiver queues are batched safely and insertion or configuration failures are reported", async ({client}) => {
  await client.login();
  await client.selectPlaylist("Mix");
  await client.installCast();
  await client.controls({allowReplace: true});
  const before = await requestCounts(client);

  await client.page.evaluate(() => {
    const controls = window.__harness.controls;
    controls.currentQueue = {
      id: "large", playlist_id: "p", name: "Mix", shuffled: false,
      videos: Array.from({length: 900}, (_, index) => ({name: `Song ${index + 1}`, link: "https://youtu.be/abcdefghijk"}))
    };
    controls.castBatchSize = 5000;
    window.__harness.insertCounts.length = 0;
    window.__harness.insertSizes.length = 0;
  });
  await client.app("localPlayback", "startPlayback", [null, {queueId: "large", index: 450}]);
  await expect(client.el("play-selected")).toBeEnabled();
  expect(await client.control("loads")).toBe(1);
  await waitForItems(client, 900);
  const largeBatch = await client.page.evaluate(() => ({
    counts: window.__harness.insertCounts.slice(),
    sizes: window.__harness.insertSizes.slice(),
    indexes: window.__harness.media.items.map(item => item.media.customData.bragiBrowser.index),
    start: window.__harness.lastLoad.media.customData.bragiBrowser.index
  }));
  expect(largeBatch.counts.reduce((sum, count) => sum + count, 0)).toBe(899);
  expect(largeBatch.counts.every(count => count <= 5000)).toBe(true);
  expect(largeBatch.sizes.length).toBeGreaterThan(1);
  expect(largeBatch.sizes.every(size => size <= 32000)).toBe(true);
  expect(largeBatch.indexes.every((index, position) => index === position)).toBe(true);
  expect(largeBatch.start).toBe(450);

  await client.page.evaluate(() => {
    window.__harness.controls.castBatchSize = 7;
    window.__harness.insertCounts.length = 0;
    window.__harness.insertSizes.length = 0;
  });
  await client.app("localPlayback", "startPlayback", [null, {queueId: "large", index: 450}]);
  await expect(client.el("play-selected")).toBeEnabled();
  expect(await client.control("loads")).toBe(2);
  await waitForItems(client, 900);
  const smallBatch = await client.page.evaluate(() => ({
    counts: window.__harness.insertCounts.slice(),
    sizes: window.__harness.insertSizes.slice(),
    indexes: window.__harness.media.items.map(item => item.media.customData.bragiBrowser.index)
  }));
  expect(smallBatch.counts.some(count => count === 7)).toBe(true);
  expect(smallBatch.counts.every(count => count <= 7)).toBe(true);
  expect(smallBatch.sizes.length).toBeGreaterThan(1);
  expect(smallBatch.sizes.every(size => size <= 32000)).toBe(true);
  expect(smallBatch.indexes.every((index, position) => index === position)).toBe(true);

  await client.page.evaluate(() => {
    const controls = window.__harness.controls;
    controls.castBatchSize = 16;
    controls.currentQueue = {
      id: "wide", playlist_id: "p", name: "Mix", shuffled: false,
      videos: Array.from({length: 40}, (_, index) => ({name: `${index}-${"x".repeat(3000)}`, link: "https://youtu.be/abcdefghijk"}))
    };
    window.__harness.insertCounts.length = 0;
    window.__harness.insertSizes.length = 0;
  });
  await client.app("localPlayback", "startPlayback", [null, {queueId: "wide", index: 20}]);
  await expect(client.el("play-selected")).toBeEnabled();
  expect(await client.control("loads")).toBe(3);
  await waitForItems(client, 40);
  const wideBatch = await client.page.evaluate(() => ({
    counts: window.__harness.insertCounts.slice(),
    sizes: window.__harness.insertSizes.slice(),
    indexes: window.__harness.media.items.map(item => item.media.customData.bragiBrowser.index)
  }));
  expect(wideBatch.sizes.length).toBeGreaterThan(3);
  expect(wideBatch.sizes.every(size => size <= 32000)).toBe(true);
  expect(wideBatch.counts.every(count => count <= 16)).toBe(true);
  expect(wideBatch.indexes.every((index, position) => index === position)).toBe(true);
  expect((await requestCounts(client)).resolve).toBe(before.resolve);

  await client.controls({castBatchSize: 0});
  await client.app("localPlayback", "startPlayback", [null, {queueId: "wide", index: 20}]);
  await client.waitForStatus("invalid Cast queue");
  expect(await client.control("loads")).toBe(3);

  await client.page.evaluate(() => {
    const controls = window.__harness.controls;
    controls.castBatchSize = 16;
    controls.mode = "insert-fail";
    controls.currentQueue = {
      id: "large", playlist_id: "p", name: "Mix", shuffled: false,
      videos: Array.from({length: 900}, (_, index) => ({name: `Song ${index + 1}`, link: "https://youtu.be/abcdefghijk"}))
    };
    window.__harness.insertSizes.length = 0;
  });
  await client.app("localPlayback", "startPlayback", [null, {queueId: "large", index: 450}]);
  await client.waitForStatus("did not confirm the entire queue");
  expect(await client.control("loads")).toBe(4);
  await waitForItems(client, 1);
  expect(await client.page.evaluate(() => window.__harness.insertSizes.length)).toBe(1);
});

test("a session change during a deferred load is reported and every request uses safe fetch options", async ({client}) => {
  await client.login();
  await client.selectPlaylist("Mix");
  await client.playSelected();
  await client.installCast();
  await client.controls({mode: "load-delay", allowReplace: true});

  await client.el("play-selected").click();
  await expect.poll(() => client.control("loads")).toBe(1);
  await expect.poll(() => client.page.evaluate(() => typeof window.__harness.gates.finishLoad)).toBe("function");
  await client.setCurrentSession(false);
  await client.updateCast();
  await client.setCurrentSession(true);
  await client.updateCast();
  await client.release("finishLoad");
  await expect(client.el("play-selected")).toBeEnabled();
  await client.waitForStatus("session changed during loading");
  expect(await client.control("localPaused")).toBe(false);

  const requests = await client.page.evaluate(() => window.__harness.requests.map(request => ({
    redirect: request.redirect, credentials: request.credentials, referrerPolicy: request.referrerPolicy
  })));
  expect(requests.length).toBeGreaterThan(0);
  expect(requests.every(request => request.redirect === "error" && request.credentials === "omit" && request.referrerPolicy === "no-referrer")).toBe(true);
});
