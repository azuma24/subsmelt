const { chromium } = require("/Users/richard/.claude/skills/gstack/node_modules/playwright-core");
const OUT = process.argv[2];
const exe = "/Users/richard/Library/Caches/ms-playwright/chromium-1208/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing";
const pages = [["dashboard", "/"], ["translations", "/translations"], ["whisper", "/whisper"], ["convert", "/convert"], ["settings", "/settings"], ["logs", "/logs"]];
(async () => {
  const browser = await chromium.launch({ executablePath: exe, headless: true });
  for (const [w, h, tag] of [[390, 844, "m"], [1280, 800, "d"]]) {
    const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 1, colorScheme: "dark" });
    const page = await ctx.newPage();
    const errors = [];
    page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
    for (const [name, path] of pages) {
      await page.goto("http://localhost:5174" + path, { waitUntil: "load" });
      await page.waitForTimeout(1800);
      await page.screenshot({ path: `${OUT}/${tag}-${name}.png`, fullPage: true });
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      console.log(tag, name, "h-overflow:", overflow);
    }
    if (errors.length) console.log(tag, "console errors:", errors.slice(0, 3));
    await ctx.close();
  }
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
