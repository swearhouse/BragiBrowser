import {test, expect} from "./fixtures/client.js";

test("client boots with mocked APIs and can sign in", async ({client}) => {
  await expect(client.el("login-panel")).toBeVisible();
  await expect(client.el("visualizer-mode")).toHaveValue("bars");
  await client.login();
  await expect(client.el("signout")).toBeVisible();
  await expect(client.page.locator(".playlist-button")).toHaveCount(3);
  await expect(client.el("status")).toContainText("Connected");
  const state = await client.state();
  expect(state.auth.base).toBe("https://server.example");
});
