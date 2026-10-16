// fallow-ignore-file unused-file
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import puppeteer from "puppeteer-core";
import { testProcessIsAlive, testProcessDescendants } from "./processTestUtils.js";

// Diagnostic only: timing marks for the Windows flake, written to HF_DIAG_MARKS.
const T0 = Date.now();
const mark = (event: string) => {
  const file = process.env.HF_DIAG_MARKS;
  if (file) appendFileSync(file, `${String(Date.now() - T0).padStart(6)} ${event}\n`);
};
mark(`fixture-start epoch=${T0}`);
{
  const { Server } = await import("node:http");
  const emit = Server.prototype.emit;
  Server.prototype.emit = function (this: InstanceType<typeof Server>, event: string, ...rest: unknown[]) {
    if (event === "connection") mark("server connection");
    if (event === "request") mark(`server request ${(rest[0] as { url?: string }).url}`);
    return emit.call(this, event, ...rest);
  } as typeof emit;
  let last = Date.now();
  setInterval(() => {
    const now = Date.now();
    if (now - last > 300) mark(`event-loop-lag ${now - last - 100}`);
    last = now;
  }, 100).unref();
}

// Accelerate the hang after the independent authored marker confirms browser startup.
// Production still budgets startup; the unit test verifies that shared deadline.
const realSetTimeout = globalThis.setTimeout;
let armDeadline: (() => void) | undefined;
globalThis.setTimeout = ((
  callback: (...args: unknown[]) => void,
  delay?: number,
  ...args: unknown[]
) => {
  const timer = realSetTimeout(callback, delay, ...args);
  if (delay === 120_000) {
    mark("deadline-started-120s");
    armDeadline = () => {
      clearTimeout(timer);
      mark("deadline-armed-4s");
      realSetTimeout(
        (...a: unknown[]) => {
          mark("deadline-expired");
          callback(...a);
        },
        4_000,
        ...args,
      );
      armDeadline = undefined;
    };
  }
  return timer;
}) as typeof setTimeout;
const pidFile = process.env.HF_TEST_BROWSER_PID_FILE;
if (!pidFile) throw new Error("Missing browser PID file");
// Observe cleanup when the command presents its report, before any exit hook runs.
const log = console.log.bind(console);
console.log = (...args: unknown[]) => {
  const [message] = args;
  if (typeof message === "string" && message.startsWith('{\n  "ok"')) mark("report-printed");
  if (typeof message === "string" && message.startsWith('{\n  "ok"') && existsSync(pidFile)) {
    const pid = Number(readFileSync(pidFile, "utf8"));
    writeFileSync(`${pidFile}.report-browser-alive`, String(testProcessIsAlive(pid)));
  }
  log(...args);
};
const launch = puppeteer.launch.bind(puppeteer);
puppeteer.launch = async (options) => {
  mark("launch-start");
  const browser = await launch(options);
  mark(`launch-end pid=${browser.process()?.pid}`);
  const browserProcess = browser.process();
  const profile = browserProcess?.spawnargs.find((arg) => arg.startsWith("--user-data-dir="));
  if (!profile) throw new Error("Browser did not expose its profile");
  writeFileSync(`${pidFile}.profile`, profile.slice("--user-data-dir=".length));
  const pid = browserProcess?.pid;
  if (!pid) throw new Error("Browser did not expose its process");
  writeFileSync(pidFile, String(pid));
  const newPage = browser.newPage.bind(browser);
  browser.newPage = async () => {
    const page = await newPage();
    mark("newpage");
    const goto = page.goto.bind(page);
    page.goto = (async (...a: Parameters<typeof goto>) => {
      mark(`goto-start ${JSON.stringify(a[1] ?? {})}`);
      try {
        const response = await goto(...a);
        mark(`goto-end status=${response?.status()}`);
        return response;
      } catch (error) {
        mark(`goto-error ${String(error).slice(0, 160)}`);
        throw error;
      }
    }) as typeof page.goto;
    const cdp = await page.createCDPSession();
    await cdp.send("Page.enable");
    await cdp.send("Page.setLifecycleEventsEnabled", { enabled: true });
    cdp.on("Page.lifecycleEvent", (e) => mark(`lifecycle ${e.name}`));
    cdp.on("Inspector.targetCrashed", () => mark("renderer-crashed"));
    page.on("request", (r) => mark(`request ${r.resourceType()} ${r.url().slice(0, 100)}`));
    page.on("response", (r) => mark(`response ${r.status()} ${r.url().slice(0, 100)} timing=${JSON.stringify(r.timing())}`));
    page.on("requestfailed", (r) => mark(`requestfailed ${r.failure()?.errorText} ${r.url().slice(0, 100)}`));
    page.on("domcontentloaded", () => mark("event domcontentloaded"));
    page.on("load", () => mark("event load"));
    page.on("error", (e) => mark(`page-error ${String(e).slice(0, 160)}`));
    page.on("pageerror", (e) => mark(`pageerror ${String(e).slice(0, 160)}`));
    page.on("close", () => mark("page-close"));
    page.on("console", (m) => mark(`console ${m.type()} ${m.text().slice(0, 120)}`));
    page.on("console", (message) => {
      if (message.text() === "HF_TEST_SCRIPT_START") {
        writeFileSync(`${pidFile}.script`, "started");
        if (process.platform === "linux") {
          writeFileSync(
            `${pidFile}.tree`,
            JSON.stringify({
              pid,
              alive: testProcessIsAlive(pid),
              descendants: testProcessDescendants(pid),
            }),
          );
        }
        armDeadline?.();
      }
    });
    return page;
  };
  return browser;
};
if (process.env.HF_TEST_DISTINCT_PROFILES === "1") {
  const { ensureBrowser } = await import("../browser/manager.js");
  const { launchManagedBrowser, closeManagedBrowser } = await import("../browser/launch.js");
  const { executablePath } = await ensureBrowser();
  const options = {
    executablePath,
    headless: true,
    args: ["--no-sandbox"],
  } as const;
  const first = await launchManagedBrowser(puppeteer, {
    ...options,
    args: [...options.args],
  });
  try {
    const firstProfile = readFileSync(`${pidFile}.profile`, "utf8");
    const firstPid = first.process()?.pid;
    if (!firstPid) throw new Error("First browser has no process");
    const second = await launchManagedBrowser(puppeteer, {
      ...options,
      args: [...options.args],
    });
    try {
      writeFileSync(`${pidFile}.first-alive`, String(testProcessIsAlive(firstPid)));
      writeFileSync(
        `${pidFile}.profiles`,
        JSON.stringify([firstProfile, readFileSync(`${pidFile}.profile`, "utf8")]),
      );
    } finally {
      await closeManagedBrowser(second);
    }
  } finally {
    await closeManagedBrowser(first);
  }
}
mark("cli-import");
await import("../cli.js");
