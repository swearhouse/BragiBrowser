import { test as base, expect } from "@playwright/test";
import { fileURLToPath } from "node:url";

const harnessScript = fileURLToPath(new URL("./harness-browser.js", import.meta.url));

class Client {
  constructor(page) {
    this.page = page;
  }

  el(id) { return this.page.locator(`#${id}`); }

  async controls(values) {
    await this.page.evaluate(values => Object.assign(window.__harness.controls, values), values);
  }

  async control(name) {
    return this.page.evaluate(name => window.__harness.controls[name], name);
  }

  async release(gate, ...args) {
    await this.page.evaluate(({gate, args}) => {
      const fn = window.__harness.gates[gate];
      if (!fn) throw new Error(`Gate ${gate} was not reached`);
      fn(...args);
      delete window.__harness.gates[gate];
    }, {gate, args});
  }

  async app(name, method, args = []) {
    return this.page.evaluate(({name, method, args}) => window.__harness.call(name, method, args), {name, method, args});
  }

  async state() {
    return this.page.evaluate(async () => {
      const {stateObject} = await window.__harness.app();
      return JSON.parse(JSON.stringify(stateObject, (key, value) =>
        ["controller", "playlistController", "castContext", "castSession", "castMedia", "localPrefetch"].includes(key) ? undefined : value));
    });
  }

  async setState(values) {
    await this.page.evaluate(async values => {
      const {stateObject} = await window.__harness.app();
      Object.assign(stateObject, values);
    }, values);
  }

  async updatePlayer() { await this.page.evaluate(() => window.__harness.updatePlayer()); }
  async updateCast() { await this.page.evaluate(() => window.__harness.updateCast()); }
  async resetMediaSessionCache() { await this.page.evaluate(() => window.__harness.resetMediaSessionCache()); }
  async installCast() { await this.page.evaluate(() => window.__harness.installCast()); }
  async setCurrentSession(value) {
    await this.page.evaluate(value => { window.currentSession = value ? window.testSession : null; }, value);
  }

  async login(username = "alice", password = "secret") {
    await this.el("username").fill(username);
    await this.el("password").fill(password);
    await this.el("login-button").click();
    await expect(this.el("library")).toBeVisible();
  }

  async selectPlaylist(name = "Mix") {
    await this.page.getByRole("button", {name, exact: true}).click();
  }

  async playSelected() {
    await this.el("play-selected").click();
    await expect.poll(async () => (await this.state()).localQueue.length).toBeGreaterThan(0);
  }

  async waitForStatus(text) {
    await expect(this.el("status")).toContainText(text);
  }

  async log() {
    return this.page.locator("#activity li").allTextContents();
  }
}

export const test = base.extend({
  client: async ({page}, use) => {
    await page.route("https://fonts.googleapis.com/**", route => route.abort());
    await page.route("https://fonts.gstatic.com/**", route => route.abort());
    await page.route("https://www.gstatic.com/**", route => route.fulfill({status: 200, contentType: "application/javascript", body: ""}));
    await page.addInitScript({path: harnessScript});
    await page.goto("/index.html");
    await page.waitForFunction(() => !!window.__harness);
    await page.evaluate(async () => {
      await window.__harness.resetMediaSessionCache();
      await window.__harness.updatePlayer();
    });
    await use(new Client(page));
  }
});

export {expect};
