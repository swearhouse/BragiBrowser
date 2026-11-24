import {test, expect} from "./fixtures/client.js";

const VIDEO_LINK = "https://youtu.be/abcdefghijk";
const TRACK_LINK = "https://youtu.be/12345678901";
const REPLACEMENT_LINK = "https://youtu.be/zyxwvutsrqp";

async function signedIn(client, playlist = "Mix") {
  await client.login();
  await client.selectPlaylist(playlist);
}

async function search(client, value) {
  await client.el("track-search").fill(value);
}

async function requests(client) {
  return client.page.evaluate(() => window.__harness.requests.map(({path, method, body}) => ({path, method, body})));
}

async function trackRequests(client, method) {
  const all = await requests(client);
  return all.filter(request => request.path.endsWith("/tracks") && (!method || request.method === method));
}

async function playlistRequests(client, method, id = null) {
  const all = await requests(client);
  const suffix = id ? `/playlists/${id}` : "/playlists";
  return all.filter(request => request.path.endsWith(suffix) && request.method === method);
}

async function waitForGate(client, gate) {
  await expect.poll(async () => client.page.evaluate(name => typeof window.__harness.gates[name], gate)).toBe("function");
}

async function cancelPrevented(client, id) {
  return client.el(id).evaluate(dialog => {
    const event = new Event("cancel", {bubbles: true, cancelable: true});
    dialog.dispatchEvent(event);
    return event.defaultPrevented;
  });
}

function menuAt(client, index) {
  return client.page.locator(".track-menu").nth(index);
}

function visibleItem(client, index) {
  return client.page.locator("#tracks li:visible").nth(index);
}

function visibleTracks(client) {
  return client.page.locator("#tracks li:visible .track-button");
}

async function openMenu(client, index) {
  await menuAt(client, index).locator("summary").click();
}

async function openVisibleMenu(client, index) {
  await visibleItem(client, index).locator("summary").click();
}

async function appendHarnessTrack(client, playlistId, video) {
  await client.page.evaluate(({playlistId, video}) => {
    window.__harness.initialPlaylists.find(playlist => playlist.id === playlistId).videos.push(video);
  }, {playlistId, video});
}

test("search before selecting a playlist explains that no playlist is chosen", async ({client}) => {
  await client.login();
  await search(client, "one");
  await expect(client.el("tracks-empty")).toContainText("Choose a playlist from your library.");
  await expect(client.page.locator("#tracks li")).toHaveCount(0);
});

test("selecting an empty playlist reports that it has no tracks", async ({client}) => {
  await client.login();
  await client.selectPlaylist("Empty");
  await expect(client.el("tracks-empty")).toContainText("This playlist has no tracks.");
  await expect(client.el("play-selected")).toBeDisabled();
  await expect(client.el("playlist-title")).toContainText("Empty - (0 songs)");
});

test("a search entered before selecting a playlist is applied to the selection", async ({client}) => {
  await client.login();
  await search(client, "one");
  await client.selectPlaylist("Empty");
  await expect(client.el("tracks-empty")).toContainText("This playlist has no tracks.");
  await client.selectPlaylist("Mix");
  await expect(visibleTracks(client)).toHaveCount(2);
  await expect(client.el("playlist-title")).toContainText("Mix - (3 songs)");
});

test("track filtering ignores case and preserves original track numbers", async ({client}) => {
  await signedIn(client);
  await search(client, "  bAd  ");
  await expect(visibleTracks(client)).toHaveCount(1);
  await expect(visibleTracks(client).first()).toHaveText("Bad");
  const numbers = await client.page.evaluate(() => [...document.querySelectorAll("#tracks li")]
    .filter(item => !item.hidden)
    .map(item => item.querySelector(".track-button").dataset.trackNumber));
  expect(numbers).toEqual(["2"]);
  await expect(client.el("playlist-title")).toContainText("Mix - (3 songs)");
});

test("a search with no matches explains the empty result", async ({client}) => {
  await signedIn(client);
  await search(client, "missing");
  await expect(visibleTracks(client)).toHaveCount(0);
  await expect(client.el("tracks-empty")).toContainText("No songs match your search.");
});

test("clearing the track search restores all saved tracks", async ({client}) => {
  await signedIn(client);
  await search(client, "one");
  await expect(visibleTracks(client)).toHaveCount(2);
  await search(client, "");
  await expect(visibleTracks(client)).toHaveCount(3);
  await expect(client.el("tracks-empty")).toBeHidden();
});

test("track actions are ordered and close on Escape", async ({client}) => {
  await signedIn(client);
  const menu = menuAt(client, 0);
  expect(await menu.locator("button").allTextContents()).toEqual(["Queue", "Open in YouTube", "Edit", "Replace...", "Delete"]);
  await menu.locator("summary").click();
  expect(await menu.evaluate(element => element.open)).toBe(true);
  await client.page.keyboard.press("Escape");
  expect(await menu.evaluate(element => element.open)).toBe(false);
});

test("opening a song in YouTube uses a safe new tab link", async ({client}) => {
  await signedIn(client);
  await client.page.evaluate(() => {
    window.__openedLink = null;
    HTMLAnchorElement.prototype.click = function () {
      window.__openedLink = {href: this.href, target: this.target, rel: this.rel};
    };
  });
  await openMenu(client, 0);
  await menuAt(client, 0).locator(".open-song").click();
  expect(await client.page.evaluate(() => window.__openedLink)).toEqual({
    href: VIDEO_LINK,
    target: "_blank",
    rel: "noopener noreferrer"
  });
});

test("invalid YouTube links are rejected before opening a tab", async ({client}) => {
  await client.login();
  await client.app("playlists", "openYouTube", [{link: "javascript:alert(1)"}]);
  await client.waitForStatus("This song has an invalid YouTube URL.");
});

test("the queue view toggle switches between the server queue and saved playlist", async ({client}) => {
  await signedIn(client);
  await client.playSelected();
  await expect.poll(async () => client.el("queue-status").textContent()).toContain("(1 of 3)");
  await expect(client.el("toggle-track-view")).toBeVisible();
  await expect(client.el("toggle-track-view")).toHaveText("Show playback queue");
  await client.el("toggle-track-view").click();
  await expect(client.el("toggle-track-view")).toHaveText("Show saved playlist");
  await expect(client.el("playlist-title")).toContainText("server queue");
  await expect(client.page.locator(".track-button")).toHaveCount(3);
  await client.el("toggle-track-view").click();
  await expect(client.el("toggle-track-view")).toHaveText("Show playback queue");
  await expect(client.el("playlist-title")).not.toContainText("server queue");
});

test("duplicate tracks are highlighted by occurrence after playback", async ({client}) => {
  await signedIn(client);
  await client.page.locator(".track-button").nth(2).click();
  await expect.poll(async () => client.el("queue-status").textContent()).toContain("(3 of 3)");
  await expect.poll(async () => client.page.locator(".track-button").nth(2).getAttribute("aria-current")).toBe("true");
  expect(await client.page.locator(".track-button").nth(0).getAttribute("aria-current")).toBeNull();
});

test("search filters the playback queue view", async ({client}) => {
  await signedIn(client);
  await client.playSelected();
  await expect.poll(async () => client.el("queue-status").textContent()).toContain("(1 of 3)");
  await client.el("toggle-track-view").click();
  await search(client, "bad");
  await expect(visibleTracks(client)).toHaveCount(1);
  await expect(visibleTracks(client).first()).toHaveText("Bad");
  await expect(client.el("tracks-empty")).toBeHidden();
});

test("creating a playlist with a blank name is rejected", async ({client}) => {
  await client.login();
  await client.el("new-playlist").click();
  await client.el("playlist-name").fill("   ");
  await client.el("playlist-save").click();
  await expect(client.el("playlist-error")).toContainText("Enter a playlist name.");
  expect(await playlistRequests(client, "POST")).toHaveLength(0);
});

test("cancelling the new playlist dialog creates nothing", async ({client}) => {
  await client.login();
  await client.el("new-playlist").click();
  await client.el("playlist-name").fill("Cancel me");
  await client.el("playlist-cancel").click();
  await expect(client.el("playlist-dialog")).toBeHidden();
  await expect(client.page.locator(".playlist-button")).toHaveCount(3);
  expect(await playlistRequests(client, "POST")).toHaveLength(0);
});

test("a pending playlist creation blocks cancellation and saves the trimmed name", async ({client}) => {
  await client.controls({mode: "playlist-delay"});
  await client.login();
  await client.el("new-playlist").click();
  await client.el("playlist-name").fill("  My mix  ");
  await client.el("playlist-save").click();
  await waitForGate(client, "finishCreate");
  await expect(client.el("playlist-save")).toBeDisabled();
  await expect(client.el("playlist-cancel")).toBeDisabled();
  await expect(client.el("playlist-delete")).toBeDisabled();
  expect(await cancelPrevented(client, "playlist-dialog")).toBe(true);
  await client.release("finishCreate");
  await expect(client.el("playlist-dialog")).toBeHidden();
  const created = await playlistRequests(client, "POST");
  expect(created).toHaveLength(1);
  expect(JSON.parse(created[0].body).name).toBe("My mix");
  await expect(client.page.locator(".playlist-button")).toHaveCount(4);
  await expect(client.page.getByRole("button", {name: "My mix", exact: true})).toHaveAttribute("aria-current", "true");
  await expect(client.el("playlist-title")).toContainText("My mix - (0 songs)");
});

test("a rejected playlist creation keeps the dialog open with the server error", async ({client}) => {
  await client.controls({mode: "playlist-invalid"});
  await client.login();
  await client.el("new-playlist").click();
  await client.el("playlist-name").fill("Rejected");
  await client.el("playlist-save").click();
  await expect(client.el("playlist-error")).toContainText("rejected");
  await expect(client.el("playlist-dialog")).toBeVisible();
  await expect(client.page.locator(".playlist-button")).toHaveCount(3);
});

test("an uncertain playlist creation reconciles from the playlist list", async ({client}) => {
  await client.controls({mode: "playlist-uncertain"});
  await client.login();
  await client.el("new-playlist").click();
  await client.el("playlist-name").fill("Uncertain");
  await client.el("playlist-save").click();
  await client.waitForStatus("creation outcome is uncertain");
  await expect(client.el("playlist-dialog")).toBeHidden();
  await expect(client.page.locator(".playlist-button")).toHaveCount(3);
  await expect(client.page.getByRole("button", {name: "Uncertain", exact: true})).toHaveCount(0);
});

test("renaming a playlist sends the trimmed name and updates the display", async ({client}) => {
  await signedIn(client);
  await client.el("edit-playlist").click();
  await expect(client.el("playlist-name")).toHaveValue("Mix");
  await client.el("playlist-name").fill("  Renamed mix  ");
  await client.el("playlist-save").click();
  await client.waitForStatus("Playlist renamed.");
  const renamed = await playlistRequests(client, "PATCH", "p");
  expect(renamed).toHaveLength(1);
  expect(JSON.parse(renamed[0].body).name).toBe("Renamed mix");
  await expect(client.page.getByRole("button", {name: "Renamed mix", exact: true})).toHaveCount(1);
  await expect(client.el("playlist-title")).toContainText("Renamed mix - (3 songs)");
  await expect(client.page.locator(".track-button")).toHaveCount(3);
});

test("an uncertain playlist rename reconciles from the playlist list", async ({client}) => {
  await signedIn(client);
  await client.controls({mode: "playlist-uncertain"});
  await client.el("edit-playlist").click();
  await client.el("playlist-name").fill("Recovered");
  await client.el("playlist-save").click();
  await client.waitForStatus("rename outcome is uncertain");
  await expect(client.page.getByRole("button", {name: "Recovered", exact: true})).toHaveCount(1);
  await expect(client.el("playlist-title")).toContainText("Recovered - (3 songs)");
});

test("playlist deletion requires confirmation before removing the playlist", async ({client}) => {
  await signedIn(client);
  await client.controls({allowReplace: false});
  await client.el("edit-playlist").click();
  await client.el("playlist-delete").click();
  await expect(client.el("playlist-dialog")).toBeVisible();
  expect(await playlistRequests(client, "DELETE", "p")).toHaveLength(0);
  await client.controls({allowReplace: true});
  await client.el("playlist-delete").click();
  await client.waitForStatus("Playlist deleted.");
  await expect(client.page.locator(".playlist-button")).toHaveCount(2);
  await expect(client.page.getByRole("button", {name: "Mix", exact: true})).toHaveCount(0);
  await expect(client.el("edit-playlist")).toBeDisabled();
  await expect(client.el("playlist-title")).toContainText("No playlist selected");
});

test("an uncertain playlist deletion reconciles and clears the selection", async ({client}) => {
  await signedIn(client);
  await client.controls({allowReplace: true, mode: "playlist-uncertain"});
  await client.el("edit-playlist").click();
  await client.el("playlist-delete").click();
  await client.waitForStatus("deletion outcome is uncertain");
  await expect(client.el("playlist-dialog")).toBeHidden();
  await expect(client.page.locator(".playlist-button")).toHaveCount(2);
  await expect(client.el("playlist-title")).toContainText("No playlist selected");
  await expect(client.el("add-song")).toBeDisabled();
});

test("failed rename and deletion preserve the existing playlist", async ({client}) => {
  await signedIn(client);
  await client.controls({allowReplace: true, mode: "playlist-invalid"});
  await client.el("edit-playlist").click();
  await client.el("playlist-name").fill("Rejected rename");
  await client.el("playlist-save").click();
  await expect(client.el("playlist-error")).toContainText("rejected");
  await expect(client.page.getByRole("button", {name: "Mix", exact: true})).toHaveCount(1);
  await client.el("playlist-delete").click();
  await expect(client.el("playlist-error")).toContainText("rejected");
  await expect(client.el("playlist-dialog")).toBeVisible();
  await expect(client.page.getByRole("button", {name: "Rejected rename", exact: true})).toHaveCount(0);
  await expect(client.page.getByRole("button", {name: "Mix", exact: true})).toHaveCount(1);
});

test("adding a song requires a URL", async ({client}) => {
  await signedIn(client, "Empty");
  await client.el("add-song").click();
  await client.el("song-form").evaluate(form => form.dispatchEvent(new Event("submit", {bubbles: true, cancelable: true})));
  await expect(client.el("song-error")).toContainText("Enter a YouTube video URL.");
  expect(await trackRequests(client, "POST")).toHaveLength(0);
});

test("add song maps server errors to specific messages", async ({client}) => {
  await signedIn(client);
  await client.el("add-song").click();
  await client.controls({mode: "song-invalid"});
  await client.el("song-url").fill("https://evil.example/12345678901");
  await client.el("song-save").click();
  await expect(client.el("song-error")).toContainText("valid HTTPS YouTube");
  await client.controls({mode: "song-title-failed"});
  await client.el("song-url").fill(TRACK_LINK);
  await client.el("song-save").click();
  await expect(client.el("song-error")).toContainText("title");
  await client.controls({mode: "song-full"});
  await client.el("song-save").click();
  await expect(client.el("song-error")).toContainText("5,000");
  expect(await trackRequests(client, "POST")).toHaveLength(3);
});

test("a pending add song locks the dialog until the request completes", async ({client}) => {
  await client.controls({mode: "song-delay"});
  await signedIn(client);
  await client.el("add-song").click();
  await client.el("song-url").fill(TRACK_LINK);
  await client.el("song-save").click();
  await waitForGate(client, "finishAddSong");
  await expect(client.el("song-save")).toBeDisabled();
  await expect(client.el("song-cancel")).toBeDisabled();
  expect(await cancelPrevented(client, "song-dialog")).toBe(true);
  await client.release("finishAddSong");
  await expect(client.el("song-dialog")).toBeHidden();
  await expect(client.page.locator("#tracks li")).toHaveCount(4);
});

test("a successful add updates the saved playlist silently", async ({client}) => {
  await signedIn(client);
  await client.el("add-song").click();
  await client.el("song-url").fill(TRACK_LINK);
  await client.el("song-save").click();
  await expect(client.el("song-dialog")).toBeHidden();
  await expect(client.page.locator("#tracks li")).toHaveCount(4);
  await expect(client.page.locator(".track-button").last()).toHaveText("Fetched title");
  await expect.poll(async () => client.el("status").textContent()).toBe("");
});

test("an uncertain add song reconciles from the playlist list", async ({client}) => {
  await signedIn(client);
  await client.controls({mode: "song-uncertain"});
  await client.el("add-song").click();
  await client.el("song-url").fill(TRACK_LINK);
  await client.el("song-save").click();
  await client.waitForStatus("Adding the song may still complete");
  await expect(client.el("song-dialog")).toBeHidden();
  await expect(client.page.locator("#tracks li")).toHaveCount(4);
  expect(await trackRequests(client, "POST")).toHaveLength(1);
});

test("a malformed add song response reconciles from the playlist list", async ({client}) => {
  await signedIn(client);
  await client.controls({mode: "song-malformed"});
  await client.el("add-song").click();
  await client.el("song-url").fill(TRACK_LINK);
  await client.el("song-save").click();
  await expect(client.el("song-dialog")).toBeHidden();
  await client.waitForStatus("Adding the song may still complete");
  await expect(client.page.locator("#tracks li")).toHaveCount(4);
  expect(await trackRequests(client, "POST")).toHaveLength(1);
});

test("song removal requires menu and dialog confirmation", async ({client}) => {
  await signedIn(client);
  await client.controls({allowReplace: false});
  await openMenu(client, 0);
  await menuAt(client, 0).locator(".delete-song").click();
  expect(await trackRequests(client, "DELETE")).toHaveLength(0);
  await openMenu(client, 0);
  await menuAt(client, 0).locator(".edit-song").click();
  await expect(client.el("edit-song-dialog")).toBeVisible();
  await client.el("edit-song-delete").click();
  await expect(client.el("edit-song-dialog")).toBeVisible();
  expect(await trackRequests(client, "DELETE")).toHaveLength(0);
});

test("a pending removal locks the editor and deletes the filtered duplicate", async ({client}) => {
  await signedIn(client);
  await client.controls({allowReplace: true, mode: "remove-delay"});
  await search(client, "one");
  await expect(visibleTracks(client)).toHaveCount(2);
  await openVisibleMenu(client, 1);
  await visibleItem(client, 1).locator(".delete-song").click();
  await waitForGate(client, "finishRemoveSong");
  await expect(client.el("edit-song-save")).toBeDisabled();
  await expect(client.el("edit-song-delete")).toBeDisabled();
  await expect(client.el("edit-song-cancel")).toBeDisabled();
  await expect(client.page.locator(".edit-song").first()).toBeDisabled();
  await expect(client.page.locator(".delete-song").first()).toBeDisabled();
  expect(await cancelPrevented(client, "edit-song-dialog")).toBe(true);
  await client.release("finishRemoveSong");
  await client.waitForStatus("Song removed.");
  const removed = await trackRequests(client, "DELETE");
  expect(removed).toHaveLength(1);
  expect(JSON.parse(removed[0].body).index).toBe(2);
  await expect(client.page.locator("#tracks li")).toHaveCount(2);
  await expect(visibleTracks(client)).toHaveCount(1);
});

test("a stale removal refresh explains the playlist changed", async ({client}) => {
  await signedIn(client);
  await client.controls({allowReplace: true, mode: "normal"});
  await appendHarnessTrack(client, "p", {name: "Concurrent", link: VIDEO_LINK});
  await openMenu(client, 0);
  await menuAt(client, 0).locator(".delete-song").click();
  await client.waitForStatus("The playlist changed");
  await expect(client.page.locator("#tracks li")).toHaveCount(4);
  await expect(client.el("tracks")).toContainText("Concurrent");
  expect(await trackRequests(client, "DELETE")).toHaveLength(1);
});

test("an uncertain removal reconciles from the playlist list", async ({client}) => {
  await signedIn(client);
  await client.controls({allowReplace: true, mode: "remove-uncertain"});
  await openMenu(client, 0);
  await menuAt(client, 0).locator(".delete-song").click();
  await client.waitForStatus("Removing the song may still complete");
  await expect(client.page.locator("#tracks li")).toHaveCount(2);
  expect(await trackRequests(client, "DELETE")).toHaveLength(1);
});

test("replacing a song validates the URL", async ({client}) => {
  await signedIn(client);
  await openMenu(client, 0);
  await menuAt(client, 0).locator(".edit-song").click();
  await expect(client.el("edit-song-dialog")).toBeVisible();
  await client.el("edit-song-url").fill("");
  await client.el("edit-song-form").evaluate(form => form.dispatchEvent(new Event("submit", {bubbles: true, cancelable: true})));
  await expect(client.el("edit-song-error")).toContainText("Enter a YouTube video URL.");
  await client.controls({mode: "song-invalid"});
  await client.el("edit-song-url").fill("https://evil.example/12345678901");
  await client.el("edit-song-save").click();
  await expect(client.el("edit-song-error")).toContainText("valid HTTPS YouTube");
  await client.controls({mode: "song-title-failed"});
  await client.el("edit-song-url").fill(REPLACEMENT_LINK);
  await client.el("edit-song-save").click();
  await expect(client.el("edit-song-error")).toContainText("title");
  expect(await trackRequests(client, "PATCH")).toHaveLength(2);
});

test("a pending replacement locks the dialog and edits the filtered duplicate", async ({client}) => {
  await signedIn(client);
  await client.controls({mode: "replace-delay"});
  await search(client, "one");
  await expect(visibleTracks(client)).toHaveCount(2);
  await openVisibleMenu(client, 1);
  await visibleItem(client, 1).locator(".edit-song").click();
  await expect(client.el("edit-song-name")).toHaveText("One");
  await client.el("edit-song-url").fill(REPLACEMENT_LINK);
  await client.el("edit-song-save").click();
  await waitForGate(client, "finishReplaceSong");
  await expect(client.el("edit-song-save")).toBeDisabled();
  await expect(client.el("edit-song-delete")).toBeDisabled();
  await expect(client.el("edit-song-cancel")).toBeDisabled();
  await expect(client.page.locator(".edit-song").first()).toBeDisabled();
  expect(await cancelPrevented(client, "edit-song-dialog")).toBe(true);
  await client.release("finishReplaceSong");
  await client.waitForStatus("Song updated.");
  const replaced = await trackRequests(client, "PATCH");
  expect(replaced).toHaveLength(1);
  expect(JSON.parse(replaced[0].body).index).toBe(2);
  expect(JSON.parse(replaced[0].body).url).toBe(REPLACEMENT_LINK);
  await expect(client.page.locator(".track-button").nth(2)).toHaveText("Replacement title");
  await expect(visibleTracks(client)).toHaveCount(1);
});

test("a stale replacement refresh explains the playlist changed", async ({client}) => {
  await signedIn(client);
  await client.controls({mode: "normal"});
  await appendHarnessTrack(client, "p", {name: "Concurrent", link: VIDEO_LINK});
  await openMenu(client, 0);
  await menuAt(client, 0).locator(".edit-song").click();
  await client.el("edit-song-url").fill(REPLACEMENT_LINK);
  await client.el("edit-song-save").click();
  await client.waitForStatus("The playlist changed");
  await expect(client.el("edit-song-dialog")).toBeHidden();
  await expect(client.page.locator("#tracks li")).toHaveCount(4);
  await expect(client.el("tracks")).toContainText("Concurrent");
  expect(await trackRequests(client, "PATCH")).toHaveLength(1);
});

test("an uncertain replacement reconciles from the playlist list", async ({client}) => {
  await signedIn(client);
  await client.controls({mode: "replace-uncertain"});
  await openMenu(client, 0);
  await menuAt(client, 0).locator(".edit-song").click();
  await client.el("edit-song-url").fill(REPLACEMENT_LINK);
  await client.el("edit-song-save").click();
  await client.waitForStatus("Updating the song may still complete");
  await expect(client.el("edit-song-dialog")).toBeHidden();
  await expect(client.page.locator(".track-button").first()).toHaveText("Replacement title");
  expect(await trackRequests(client, "PATCH")).toHaveLength(1);
});

test("a malformed replacement reconciles from the playlist list", async ({client}) => {
  await signedIn(client);
  await client.controls({mode: "replace-malformed"});
  await openMenu(client, 0);
  await menuAt(client, 0).locator(".edit-song").click();
  await client.el("edit-song-url").fill(TRACK_LINK);
  await client.el("edit-song-save").click();
  await expect(client.el("edit-song-dialog")).toBeHidden();
  await client.waitForStatus("Updating the song may still complete");
  expect(await trackRequests(client, "PATCH")).toHaveLength(1);
});

test("queuing before playback explains that playback must start first", async ({client}) => {
  await signedIn(client);
  await openMenu(client, 0);
  await menuAt(client, 0).locator(".queue-song").click();
  await client.waitForStatus("Start browser playback before queuing a song.");
});

test("queuing after playback inserts the song into the browser queue", async ({client}) => {
  await signedIn(client);
  await client.playSelected();
  await expect.poll(async () => client.el("queue-status").textContent()).toContain("(1 of 3)");
  await openMenu(client, 0);
  await menuAt(client, 0).locator(".queue-song").click();
  await client.waitForStatus("Queued “One” to play next in this browser.");
  const state = await client.state();
  expect(state.localQueue.map(video => video.name)).toEqual(["One", "One", "Bad", "One"]);
});

test("replace song searches YouTube and previews before replacing", async ({client}) => {
  await signedIn(client);
  await client.controls({searchResults: Array.from({length: 10}, (_, index) => ({
    type: "video", videoId: `abcde${index}fghij`.slice(0, 11), title: `Result ${index + 1}`, author: `Channel ${index + 1}`
  }))});
  await openMenu(client, 0);
  await menuAt(client, 0).locator(".replace-song").click();
  await expect(client.el("replace-song-dialog")).toBeVisible();
  await expect(client.el("replace-song-query")).toHaveValue("One");
  await expect(client.page.locator(".replace-result")).toHaveCount(10);
  await client.page.locator(".replace-result").nth(1).locator(".preview-replace-song").click();
  await expect(client.el("replace-song-preview")).toBeVisible();
  await expect(client.el("replace-song-audio")).toHaveAttribute("src", /\/api\/v1\/audio-stream\?token=proxy-secret/);
  await client.page.locator(".replace-result").nth(1).locator(".use-replace-song").click();
  await expect(client.el("replace-song-dialog")).toBeHidden();
  const patch = (await trackRequests(client, "PATCH")).at(-1);
  expect(patch.body).toContain('"url":"https://youtu.be/abcde1fghij"');
  await expect(client.page.locator(".track-button").first()).toContainText("Replacement title");
});

test("replace song shows search errors", async ({client}) => {
  await signedIn(client);
  await client.controls({searchError: 503});
  await openMenu(client, 0);
  await menuAt(client, 0).locator(".replace-song").click();
  await expect(client.el("replace-song-error")).toContainText("Search failed (503)");
  await expect(client.page.locator(".replace-result")).toHaveCount(0);
});
