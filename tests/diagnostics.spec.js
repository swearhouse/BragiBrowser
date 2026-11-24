import {test, expect} from "./fixtures/client.js";

test("diagnostics opens from the header and returns to the previous view", async ({client}) => {
  await expect(client.el("login-panel")).toBeVisible();
  await client.el("open-diagnostics").click();
  await expect(client.el("diagnostics-panel")).toBeVisible();
  await expect(client.el("login-panel")).toBeHidden();
  await expect(client.el("library")).toBeHidden();
  await expect(client.el("settings-panel")).toBeHidden();
  await expect(client.el("diag-account")).toHaveText("Signed out");
  await expect(client.el("diag-server-api")).toHaveText("Not checked");
  await expect(client.el("diag-search-check")).toHaveText("Not checked");
  await expect(client.el("diagnostics-activity-empty")).toBeVisible();
  await client.el("close-diagnostics").click();
  await expect(client.el("diagnostics-panel")).toBeHidden();
  await expect(client.el("login-panel")).toBeVisible();
  await expect(client.el("library")).toBeHidden();
});

test("diagnostics checks server and search connectivity when signed in", async ({client}) => {
  await client.login();
  await client.el("open-diagnostics").click();
  await expect(client.el("diag-account")).toContainText("Signed in as alice");
  await client.controls({mode: "login-delay"});
  const before = await client.page.evaluate(() => window.__harness.requests.length);
  await client.el("diagnostics-run").click();
  await expect(client.el("diagnostics-status")).toHaveText("Running checks…");
  await expect(client.el("diagnostics-run")).toBeDisabled();
  await client.release("finishLogin");
  await expect(client.el("diag-server-api")).toContainText("Reachable · 3 playlists");
  await expect(client.el("diag-search-check")).toContainText("Reachable (HTTP 200)");
  await expect(client.el("diagnostics-status")).toHaveText("Checks complete.");
  await expect(client.el("diagnostics-run")).toBeEnabled();
  const requests = await client.page.evaluate(count => window.__harness.requests.slice(count), before);
  expect(requests.some(request => request.path === "/api/v1/playlists")).toBe(true);
  expect(requests.some(request => request.path === "/api/v1/search")).toBe(true);
});

test("diagnostics reads configuration but skips the API when signed out", async ({client}) => {
  await client.el("open-diagnostics").click();
  const before = await client.page.evaluate(() => window.__harness.requests.length);
  await client.el("diagnostics-run").click();
  await expect(client.el("diag-server-config")).toContainText("Configured: https://server.example");
  await expect(client.el("diag-server-api")).toHaveText("Sign in to check the server API.");
  await expect(client.el("diag-search-check")).toContainText("Reachable (HTTP 200)");
  const requests = await client.page.evaluate(count => window.__harness.requests.slice(count), before);
  expect(requests.some(request => request.path.endsWith("/server-url.txt"))).toBe(true);
  expect(requests.some(request => request.path === "/api/v1/playlists")).toBe(false);
});

test("diagnostics report redacts credentials and URL secrets", async ({client}) => {
  await client.login();
  await client.el("open-diagnostics").click();
  await client.page.evaluate(async () => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {writeText: async text => { window.__copiedReport = text; }}
    });
    const {stateObject} = await window.__harness.app();
    document.getElementById("audio").src = `${stateObject.auth.base}/api/v1/audio-stream?token=proxy-secret`;
    const item = document.createElement("li");
    item.textContent = "Playback failed https://media.example/audio?token=stream-secret&x=1";
    document.getElementById("activity").prepend(item);
  });
  await client.el("close-diagnostics").click();
  await client.el("open-diagnostics").click();
  await expect(client.el("diag-audio-source")).toHaveText("Bragi audio proxy (URL hidden)");
  await client.el("diagnostics-copy").click();
  await expect(client.el("diagnostics-status")).toContainText("copied to clipboard");
  const report = await client.page.evaluate(() => window.__copiedReport);
  expect(report).toContain("Bragi Browser diagnostics");
  expect(report).toContain("Signed in as alice");
  expect(report).not.toContain("Basic ");
  expect(report).not.toContain("proxy-secret");
  expect(report).not.toContain("stream-secret");
  expect(report).not.toContain("/api/v1/audio-stream?");
});

test("diagnostics values are color coded by status", async ({client}) => {
  await client.el("open-diagnostics").click();
  await expect(client.el("diag-account")).toHaveAttribute("data-tone", "warn");
  await expect(client.el("diag-credentials")).toHaveAttribute("data-tone", "ok");
  await expect(client.el("diag-cast-session")).toHaveAttribute("data-tone", "warn");
  await expect(client.el("diag-queue")).toHaveAttribute("data-tone", "warn");
  await client.el("diagnostics-run").click();
  await expect(client.el("diag-search-check")).toHaveAttribute("data-tone", "ok");
  await expect(client.el("diagnostics-status")).toHaveAttribute("data-tone", "warn");
  await client.controls({searchError: 503});
  await client.el("diagnostics-run").click();
  await expect(client.el("diag-search-check")).toHaveAttribute("data-tone", "error");
  await expect(client.el("diagnostics-status")).toHaveAttribute("data-tone", "error");
});

test("diagnostics closes on sign out and on a delayed login", async ({client}) => {
  await client.controls({mode: "login-delay"});
  await client.el("username").fill("alice");
  await client.el("password").fill("secret");
  await client.el("login-button").click();
  await client.el("open-diagnostics").click();
  await expect(client.el("diagnostics-panel")).toBeVisible();
  await client.release("finishLogin");
  await expect(client.el("library")).toBeVisible();
  await expect(client.el("diagnostics-panel")).toBeHidden();
  await client.el("open-diagnostics").click();
  await expect(client.el("diagnostics-panel")).toBeVisible();
  await client.el("signout").click();
  await expect(client.el("diagnostics-panel")).toBeHidden();
  await expect(client.el("login-panel")).toBeVisible();
  await client.el("open-settings").click();
  await expect(client.el("settings-panel")).toBeVisible();
  await expect(client.el("diagnostics-panel")).toBeHidden();
});
