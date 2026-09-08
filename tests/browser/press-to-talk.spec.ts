import { expect, test, type Page, type TestInfo } from "@playwright/test";

async function hold(page: Page, info: TestInfo, selector = ".evi-ptt-hold") {
  const box = (await page.locator(selector).boundingBox())!;
  const x = box.x + box.width / 2, y = box.y + box.height / 2;
  if (info.project.name === "touch") {
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y, id: 1 }] });
    return {
      move: (offset: number) => cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x, y: y + offset, id: 1 }] }),
      up: async () => { await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] }); await cdp.detach(); }
    };
  }
  await page.mouse.move(x, y); await page.mouse.down();
  return { move: (offset: number) => page.mouse.move(x, y + offset), up: () => page.mouse.up() };
}

test.beforeEach(async ({ page }) => {
  await page.route("**/api/transcribe", (route) => route.fulfill({ json: { text: "Synthetic transcript" } }));
  await page.goto("/");
});

test("real MediaRecorder release sends one playable audio message with text", async ({ page }, info) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  let requests = 0;
  page.on("request", (request) => { if (request.url().endsWith("/api/transcribe")) requests++; });
  const gesture = await hold(page, info);
  await expect(page.locator(".evi-ptt-hold")).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("status")).toHaveText("1s");
  await gesture.up();
  await expect(page.locator(".example-message")).toHaveCount(1);
  await expect(page.getByText("Synthetic transcript")).toBeVisible();
  await expect.poll(() => page.locator("audio").evaluate((element: HTMLAudioElement) => element.readyState)).toBeGreaterThan(0);
  expect(requests).toBe(1);
  expect(errors).toEqual([]);
  await page.screenshot({ path: info.outputPath("voice-message.png"), fullPage: true });
});

test("upward slide cancels and compatibility click cannot restart capture", async ({ page }, info) => {
  let requests = 0;
  page.on("request", (request) => { if (request.url().endsWith("/api/transcribe")) requests++; });
  const gesture = await hold(page, info);
  await expect(page.locator(".evi-ptt-hold")).toHaveAttribute("aria-pressed", "true");
  await gesture.move(-100);
  await expect(page.getByText("Release to cancel", { exact: true })).toBeVisible();
  await gesture.up();
  await expect(page.locator(".evi-ptt-hold")).toHaveAttribute("aria-pressed", "false");
  expect(requests).toBe(0);
  await expect(page.locator(".example-message")).toHaveCount(0);
});

test("keyboard start, repeat suppression, Escape and explicit stop", async ({ page }) => {
  const button = page.locator(".evi-ptt-hold");
  await button.focus();
  await page.keyboard.down("Enter"); await page.keyboard.down("Enter");
  await page.keyboard.up("Enter");
  await expect(button).toHaveAttribute("aria-pressed", "true");
  await page.keyboard.press("Escape");
  await expect(button).toHaveAttribute("aria-pressed", "false");
  await page.keyboard.press("Space");
  await expect(button).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("status")).toHaveText("1s");
  await page.keyboard.press("Space");
  await expect(page.locator(".example-message")).toHaveCount(1);
});

test("click dictation preserves edits and never auto-sends", async ({ page }, info) => {
  await page.getByRole("button", { name: "Edit text", exact: true }).click();
  await page.getByRole("button", { name: "Dictate text", exact: true }).click();
  await expect(page.getByRole("status")).toHaveText("1s");
  await page.getByRole("textbox").fill("Edited synthetic draft");
  await page.getByRole("button", { name: "Stop dictation", exact: true }).click();
  await expect(page.locator("summary")).toHaveText("Transcript");
  await expect(page.getByRole("textbox")).toHaveValue("Edited synthetic draft");
  await expect(page.locator(".example-message")).toHaveCount(0);
  await page.locator("summary").click();
  await page.screenshot({ path: info.outputPath("editable-draft.png"), fullPage: true });
  await page.getByRole("button", { name: "Send text", exact: true }).click();
  await expect(page.locator(".example-message")).toHaveCount(1);
  await expect(page.locator("audio")).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test("pagehide during a held recording prevents release send", async ({ page }, info) => {
  let requests = 0;
  page.on("request", (request) => { if (request.url().endsWith("/api/transcribe")) requests++; });
  const gesture = await hold(page, info);
  await expect(page.locator(".evi-ptt-hold")).toHaveAttribute("aria-pressed", "true");
  await page.evaluate(() => window.dispatchEvent(new Event("pagehide")));
  await gesture.up();
  await expect(page.locator(".evi-ptt-hold")).toHaveAttribute("aria-pressed", "false");
  expect(requests).toBe(0);
});

test("standalone vanilla IIFE uses the same release contract", async ({ page }, info) => {
  await page.goto("http://127.0.0.1:5188/examples/vanilla/index.html");
  const gesture = await hold(page, info, "#hold");
  await expect(page.locator("#hold")).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("status")).toHaveText("1s");
  await gesture.up();
  await expect(page.locator("#messages article")).toHaveCount(1);
  await expect(page.locator("#messages audio")).toHaveCount(1);
  await expect(page.locator("#messages p")).toHaveText("Synthetic transcript");
  await page.screenshot({ path: info.outputPath("vanilla.png"), fullPage: true });
});
