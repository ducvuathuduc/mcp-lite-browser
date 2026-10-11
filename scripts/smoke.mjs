// Browser smoke test: drives the playground in headless Chromium against both the in-page demo server and the
// SDK server over real HTTP. Usage: CHROME_PATH=/usr/bin/chromium node scripts/smoke.mjs [outDir]
import { spawn } from "node:child_process";
import puppeteer from "puppeteer-core";

const out = process.argv[2] || "/tmp/shots";
const PORT = 5199;
const srv = spawn(process.execPath, ["scripts/demo-server.mjs"], { env: { ...process.env, PORT: String(PORT) }, stdio: ["ignore", "pipe", "inherit"] });
await new Promise((r) => srv.stdout.once("data", r));
const browser = await puppeteer.launch({ executablePath: process.env.CHROME_PATH || "/usr/bin/chromium", headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
const errors = [];
try {
  const page = await browser.newPage();
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });
  await page.goto(`http://localhost:${PORT}/`, { waitUntil: "networkidle0" });
  await page.click("#demo");
  await page.waitForSelector("#run");
  await page.click("#run");
  const frame = await (await page.waitForSelector("iframe.app-frame")).contentFrame();
  await frame.waitForFunction(() => document.getElementById("t").textContent.includes("°C"), { timeout: 5000 });
  await new Promise((r) => setTimeout(r, 400));
  await page.screenshot({ path: `${out}/demo-weather.png` });
  console.log("demo: MCP App rendered:", await frame.$eval("#t", (e) => e.textContent));

  // Real HTTP: the SDK server through the dev server's /mcp endpoint.
  await page.goto(`http://localhost:${PORT}/?url=http://localhost:${PORT}/mcp`, { waitUntil: "networkidle0" });
  await page.waitForFunction(() => document.querySelector("#status").textContent.includes("sdk-conformance-server"), { timeout: 5000 });
  const tools = await page.$$eval("#items li .name", (els) => els.map((e) => e.textContent));
  console.log("sdk server tools:", tools.join(", "));
  await page.evaluate(() => [...document.querySelectorAll("#items li")].find((li) => li.textContent.startsWith("counter") && !li.textContent.includes("increment")).click());
  await page.click("#run");
  const f2 = await (await page.waitForSelector("iframe.app-frame")).contentFrame();
  await f2.waitForFunction(() => document.getElementById("n").textContent !== "–", { timeout: 5000 });
  await f2.click("#b");
  await f2.waitForFunction(() => document.getElementById("n").textContent === "1", { timeout: 5000 });
  console.log("sdk server: counter app incremented via app-only tool from inside the sandboxed iframe");
  await page.screenshot({ path: `${out}/sdk-counter.png` });
  const n = await page.$eval("#n-msgs", (e) => e.textContent);
  console.log("traffic:", n);
} finally {
  await browser.close();
  srv.kill();
}
if (errors.length) { console.error("page errors:\n" + errors.join("\n")); process.exit(1); }
console.log("smoke OK");
