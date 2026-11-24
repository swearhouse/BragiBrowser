import {test, expect} from "./fixtures/client.js";

test("fresh client starts with default settings and login view", async ({client}) => {
  await expect(client.el("login-panel")).toBeVisible();
  await expect(client.el("library")).toBeHidden();
  await expect(client.el("settings-panel")).toBeHidden();
  await expect(client.el("username")).toBeEditable();
  await expect(client.el("auto-shuffle")).not.toBeChecked();
  await expect(client.el("visualizer-mode")).toHaveValue("bars");
  await expect(client.el("youtube-search-instance")).toHaveValue("https://yt.chocolatemoo53.com");
  await expect(client.el("password")).toHaveValue("");
  expect(await client.page.evaluate(() => window.__harness.requests.length)).toBe(0);
});

test("settings opened from login save preferences and return to login", async ({client}) => {
  await client.el("open-settings").click();
  await expect(client.el("settings-panel")).toBeVisible();
  await expect(client.el("login-panel")).toBeHidden();
  await expect(client.el("library")).toBeHidden();
  await client.el("visualizer-mode").selectOption("wave");
  await expect.poll(async () => client.page.evaluate(() => localStorage.getItem("bragi.visualizer"))).toBe("wave");
  await client.el("auto-shuffle").check();
  await expect.poll(async () => client.page.evaluate(() => localStorage.getItem("bragi.autoShuffle"))).toBe("true");
  await client.el("close-settings").click();
  await expect(client.el("login-panel")).toBeVisible();
  await expect(client.el("settings-panel")).toBeHidden();
  await expect(client.el("library")).toBeHidden();
});

test("settings opened from library save preferences and return to library", async ({client}) => {
  await client.login();
  await client.el("open-settings").click();
  await expect(client.el("settings-panel")).toBeVisible();
  await expect(client.el("library")).toBeHidden();
  await client.el("auto-shuffle").check();
  await expect.poll(async () => client.page.evaluate(() => localStorage.getItem("bragi.autoShuffle"))).toBe("true");
  await client.el("auto-shuffle").uncheck();
  await expect.poll(async () => client.page.evaluate(() => localStorage.getItem("bragi.autoShuffle"))).toBe("false");
  await client.el("visualizer-mode").selectOption("radial");
  await expect.poll(async () => client.page.evaluate(() => localStorage.getItem("bragi.visualizer"))).toBe("radial");
  await client.el("youtube-search-instance").fill("https://invidious.example.com/");
  await client.el("youtube-search-instance").press("Tab");
  await expect.poll(async () => client.page.evaluate(() => localStorage.getItem("bragi.youtubeSearchInstance"))).toBe("https://invidious.example.com");
  await client.el("close-settings").click();
  await expect(client.el("library")).toBeVisible();
  await expect(client.el("settings-panel")).toBeHidden();
  await client.page.reload();
  await expect(client.el("username")).toHaveValue("alice");
  await expect(client.el("auto-shuffle")).not.toBeChecked();
  await expect(client.el("visualizer-mode")).toHaveValue("radial");
  await expect(client.el("youtube-search-instance")).toHaveValue("https://invidious.example.com");
});

test("preseeded settings are restored on a fresh page", async ({client}) => {
  await client.page.evaluate(() => {
    localStorage.setItem("bragi.username", "previous-user");
    localStorage.setItem("bragi.autoShuffle", "true");
    localStorage.setItem("bragi.visualizer", "wave");
  });
  await client.page.reload();
  await expect(client.el("username")).toHaveValue("previous-user");
  await expect(client.el("username")).toBeEditable();
  await expect(client.el("password")).toHaveValue("");
  await expect(client.el("auto-shuffle")).toBeChecked();
  await expect(client.el("visualizer-mode")).toHaveValue("wave");
  await expect(client.el("library")).toBeHidden();
  await client.el("username").fill("another-user");
  await expect.poll(async () => client.page.evaluate(() => localStorage.getItem("bragi.username"))).toBe("another-user");
});

test("invalid saved settings fall back with status messages", async ({client}) => {
  await client.page.evaluate(() => localStorage.setItem("bragi.autoShuffle", "sometimes"));
  await client.page.reload();
  await expect(client.el("status")).toContainText("The saved auto shuffle setting is invalid; auto shuffle is off.");
  await expect(client.el("auto-shuffle")).not.toBeChecked();
  await client.page.evaluate(() => {
    localStorage.setItem("bragi.autoShuffle", "false");
    localStorage.setItem("bragi.visualizer", "neon");
  });
  await client.page.reload();
  await expect(client.el("status")).toContainText("The saved visualizer setting is invalid; spectrum bars are selected.");
  await expect(client.el("visualizer-mode")).toHaveValue("bars");
  await expect(client.el("auto-shuffle")).not.toBeChecked();
});

test("username is saved in browser storage as it is typed", async ({client}) => {
  await client.el("username").fill("alice");
  await expect.poll(async () => client.page.evaluate(() => localStorage.getItem("bragi.username"))).toBe("alice");
  await client.el("username").fill("");
  await expect.poll(async () => client.page.evaluate(() => localStorage.getItem("bragi.username"))).toBe("");
  await client.el("username").fill("alice");
  await expect.poll(async () => client.page.evaluate(() => localStorage.getItem("bragi.username"))).toBe("alice");
});

test("missing and unreachable configuration block login without API calls", async ({client}) => {
  await client.controls({configFailure: "missing"});
  await client.el("username").fill("alice");
  await client.el("password").fill("secret");
  await client.el("login-button").click();
  await client.waitForStatus("Could not load the BragiServer configuration");
  await expect(client.el("login-button")).toBeEnabled();
  let count = await client.page.evaluate(() => window.__harness.requests.length);
  await client.controls({configFailure: "network"});
  await client.el("login-button").click();
  await expect.poll(async () => client.page.evaluate(() => window.__harness.requests.length)).toBeGreaterThan(count);
  await client.waitForStatus("Could not load the BragiServer configuration");
  await expect(client.el("login-button")).toBeEnabled();
  const paths = await client.page.evaluate(() => window.__harness.requests.map(request => request.path));
  expect(paths.some(path => path.endsWith("/server-url.txt"))).toBe(true);
  expect(paths.some(path => path.startsWith("/api/v1"))).toBe(false);
  await expect(client.el("library")).toBeHidden();
});

test("invalid configured server URLs are rejected before any API call", async ({client}) => {
  const cases = [
    ["ftp://server.example", "Invalid BragiServer configuration"],
    ["https://user:secret@server.example", "without credentials"],
    ["https://server.example?", "without credentials"],
    ["https://server.example/#fragment", "without credentials"],
    ["", "Invalid BragiServer configuration"]
  ];
  await client.el("username").fill("alice");
  await client.el("password").fill("secret");
  for (const [configuredServerUrl, status] of cases) {
    const count = await client.page.evaluate(() => window.__harness.requests.length);
    await client.controls({configuredServerUrl});
    await client.el("login-button").click();
    await expect.poll(async () => client.page.evaluate(() => window.__harness.requests.length)).toBeGreaterThan(count);
    await client.waitForStatus(status);
    await expect(client.el("login-button")).toBeEnabled();
    await expect(client.el("library")).toBeHidden();
  }
  const paths = await client.page.evaluate(() => window.__harness.requests.map(request => request.path));
  expect(paths.some(path => path.startsWith("/api/v1"))).toBe(false);
});

test("invalid credentials keep the library hidden and preserve the username", async ({client}) => {
  await client.controls({mode: "invalid"});
  await client.el("username").fill("alice");
  await client.el("password").fill("secret");
  await client.el("login-button").click();
  await client.waitForStatus("Authentication failed");
  await expect(client.el("library")).toBeHidden();
  await expect(client.el("login-panel")).toBeVisible();
  await expect(client.el("login-button")).toBeEnabled();
  expect(await client.page.evaluate(() => localStorage.getItem("bragi.username"))).toBe("alice");
});

test("delayed login preserves a username edited while connecting and keeps settings usable", async ({client}) => {
  await client.controls({mode: "login-delay", configuredServerUrl: "http://server.example:8000"});
  await client.el("username").fill("alice");
  await client.el("password").fill("secret");
  await client.el("login-button").click();
  await expect.poll(async () => client.page.evaluate(() => typeof window.__harness.gates.finishLogin)).toBe("function");
  await expect(client.el("library")).toBeHidden();
  await client.el("open-settings").click();
  await expect(client.el("settings-panel")).toBeVisible();
  await client.el("close-settings").click();
  await expect(client.el("login-panel")).toBeVisible();
  await expect(client.el("library")).toBeHidden();
  await client.el("open-settings").click();
  await client.el("username").evaluate((input, value) => {
    input.value = value;
    input.dispatchEvent(new Event("input", {bubbles: true}));
  }, "later-user");
  await expect.poll(async () => client.page.evaluate(() => localStorage.getItem("bragi.username"))).toBe("later-user");
  await client.release("finishLogin");
  await expect(client.el("signout")).toBeVisible();
  await expect(client.el("settings-panel")).toBeVisible();
  await expect(client.el("library")).toBeHidden();
  expect(await client.page.evaluate(() => localStorage.getItem("bragi.username"))).toBe("later-user");
  await client.el("username").evaluate((input, value) => {
    input.value = value;
    input.dispatchEvent(new Event("input", {bubbles: true}));
  }, "alice");
  await client.el("close-settings").click();
  await expect(client.el("library")).toBeVisible();
  await expect(client.el("settings-panel")).toBeHidden();
  expect(await client.page.evaluate(() => localStorage.getItem("bragi.username"))).toBe("alice");
  const paths = await client.page.evaluate(() => window.__harness.requests.map(request => request.url));
  expect(paths).toContain("http://server.example:8000/api/v1/playlists");
});

test("post-login UI shows playlists and sidebar toggling does not disturb playback", async ({client}) => {
  await client.login();
  await expect(client.el("password")).toHaveValue("");
  await expect(client.el("signout")).toBeVisible();
  await expect(client.page.locator(".playlist-button")).toHaveCount(3);
  await client.selectPlaylist("Mix");
  await client.playSelected();
  await expect.poll(async () => client.el("audio").getAttribute("src")).toBeTruthy();
  await expect.poll(async () => client.control("localPaused")).toBe(false);
  const source = await client.el("audio").getAttribute("src");
  await client.el("toggle-sidebar").click();
  await expect(client.el("playlist-sidebar")).toBeHidden();
  await expect(client.el("library")).toHaveClass(/sidebar-hidden/);
  await expect(client.el("toggle-sidebar")).toHaveAttribute("aria-expanded", "false");
  await expect(client.el("toggle-sidebar")).toHaveAttribute("aria-label", "Bragi: Show playlist sidebar");
  expect(await client.el("audio").getAttribute("src")).toBe(source);
  expect(await client.control("localPaused")).toBe(false);
  await client.el("toggle-sidebar").click();
  await expect(client.el("playlist-sidebar")).toBeVisible();
  await expect(client.el("library")).not.toHaveClass(/sidebar-hidden/);
  await expect(client.el("toggle-sidebar")).toHaveAttribute("aria-expanded", "true");
  await expect(client.el("toggle-sidebar")).toHaveAttribute("aria-label", "Bragi: Hide playlist sidebar");
  expect(await client.el("audio").getAttribute("src")).toBe(source);
  expect(await client.control("localPaused")).toBe(false);
});

test("sign out clears playlists, queue, password, and media session", async ({client}) => {
  await client.el("auto-shuffle").evaluate(input => {
    input.checked = true;
    input.dispatchEvent(new Event("change", {bubbles: true}));
  });
  await client.login();
  await client.selectPlaylist("Mix");
  await client.playSelected();
  await expect.poll(async () => client.el("audio").getAttribute("src")).toBeTruthy();
  await expect.poll(async () => client.page.evaluate(() => window.__harness.mediaSession.playbackState)).toBe("playing");
  await client.el("signout").click();
  await expect(client.el("login-panel")).toBeVisible();
  await expect(client.el("library")).toBeHidden();
  await expect(client.el("signout")).toBeHidden();
  await expect(client.el("password")).toHaveValue("");
  await expect(client.el("status")).toContainText("Signed out");
  await expect(client.page.locator(".playlist-button")).toHaveCount(0);
  await expect(client.page.locator("#tracks li")).toHaveCount(0);
  await expect(client.el("queue-status")).toHaveText("No playback started.");
  await expect(client.el("track-search")).toHaveValue("");
  await expect.poll(async () => client.page.evaluate(() => window.__harness.mediaSession.playbackState)).toBe("none");
  const media = await client.page.evaluate(() => ({
    metadata: window.__harness.mediaSession.metadata,
    position: window.__harness.mediaSession.position
  }));
  expect(media.metadata).toBeNull();
  expect(media.position).toBeNull();
  expect(await client.page.evaluate(() => localStorage.getItem("bragi.username"))).toBe("alice");
  expect(await client.page.evaluate(() => localStorage.getItem("bragi.autoShuffle"))).toBe("true");
});

test("sign out cancels pending proxy preparation and a later login still works", async ({client}) => {
  await client.controls({mode: "proxy-delay"});
  await client.login();
  await client.selectPlaylist("Mix");
  await client.playSelected();
  await expect.poll(async () => client.control("proxyEntered")).toBe(true);
  await client.el("signout").click();
  await expect.poll(async () => client.control("proxyCancelled")).toBe(true);
  await expect(client.el("status")).toContainText("Signed out");
  await expect(client.el("library")).toBeHidden();
  await expect(client.el("login-panel")).toBeVisible();
  await expect.poll(async () => client.page.evaluate(() => window.__harness.mediaSession.playbackState)).toBe("none");
  await client.controls({mode: "normal"});
  await client.el("password").fill("secret");
  await client.el("login-button").click();
  await expect(client.el("library")).toBeVisible();
  await expect(client.el("signout")).toBeVisible();
  await expect(client.page.locator(".playlist-button")).toHaveCount(3);
});

test("username storage failures are reported but still allow login", async ({client}) => {
  await client.controls({storageFailure: "username"});
  await client.el("username").fill("bob");
  await client.waitForStatus("Browser storage is unavailable; the username cannot be remembered.");
  await client.el("password").fill("secret");
  await client.el("login-button").click();
  await expect(client.el("library")).toBeVisible();
  await client.waitForStatus("Connected, but the username could not be saved in browser storage.");
  await expect(client.el("password")).toHaveValue("");
  await expect(client.el("signout")).toBeVisible();
});

test("all storage failures are reported for settings and login", async ({client}) => {
  await client.controls({storageFailure: "all"});
  await client.el("open-settings").click();
  await client.el("auto-shuffle").check();
  await client.waitForStatus("Browser storage is unavailable; auto shuffle changed for this page but was not saved.");
  await client.el("visualizer-mode").selectOption("wave");
  await client.waitForStatus("Browser storage is unavailable; the visualizer changed for this page but was not saved.");
  await expect(client.el("auto-shuffle")).toBeChecked();
  await expect(client.el("visualizer-mode")).toHaveValue("wave");
  await client.el("close-settings").click();
  await client.el("username").fill("alice");
  await client.el("password").fill("secret");
  await client.el("login-button").click();
  await expect(client.el("library")).toBeVisible();
  await client.waitForStatus("Connected, but the username could not be saved in browser storage.");
  expect(await client.page.evaluate(() => [
    localStorage.getItem("bragi.username"),
    localStorage.getItem("bragi.autoShuffle"),
    localStorage.getItem("bragi.visualizer")
  ])).toEqual([null, null, null]);
});

test("proxy authentication failure signs out and clears playback", async ({client}) => {
  await client.controls({mode: "proxy-auth"});
  await client.login();
  await client.selectPlaylist("Mix");
  await client.el("play-selected").click();
  await expect(client.el("login-panel")).toBeVisible();
  await client.waitForStatus("Authentication failed");
  await expect(client.el("library")).toBeHidden();
  await expect(client.el("password")).toHaveValue("");
  await expect(client.page.locator(".playlist-button")).toHaveCount(0);
  await expect.poll(async () => client.control("localPaused")).toBe(true);
  await expect.poll(async () => client.page.evaluate(() => window.__harness.mediaSession.playbackState)).toBe("none");
});

test("sign out during a pending song replacement ignores the late response", async ({client}) => {
  await client.controls({mode: "replace-delay"});
  await client.login();
  await client.selectPlaylist("Mix");
  await expect(client.page.locator("#tracks li")).toHaveCount(3);
  await client.page.locator(".track-menu").first().locator("summary").click();
  await client.page.locator(".edit-song").first().click();
  await expect(client.page.locator("#edit-song-dialog")).toBeVisible();
  await client.el("edit-song-url").fill("https://youtu.be/zyxwvutsrqp");
  await client.el("edit-song-save").click();
  await expect.poll(async () => client.page.evaluate(() => typeof window.__harness.gates.finishReplaceSong)).toBe("function");
  await client.el("signout").evaluate(button => button.click());
  await expect.poll(async () => client.page.evaluate(() => document.getElementById("edit-song-dialog").open)).toBe(false);
  await expect(client.el("status")).toContainText("playlist change may have completed");
  await expect(client.el("login-panel")).toBeVisible();
  await expect(client.el("library")).toBeHidden();
  await expect(client.page.locator(".playlist-button")).toHaveCount(0);
  await client.release("finishReplaceSong");
  await expect(client.el("login-panel")).toBeVisible();
  await expect(client.el("status")).toContainText("playlist change may have completed");
  await expect(client.page.locator(".playlist-button")).toHaveCount(0);
  await expect(client.page.locator("#tracks li")).toHaveCount(0);
});
