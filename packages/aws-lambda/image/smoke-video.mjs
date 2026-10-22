// Runs inside the video image, mounted into /var/task: the bundled ffmpeg answers and the arm64 Chrome
// renders a page, launched the way src/chromium.ts launches it.
import { execFileSync } from "node:child_process";
import chromium from "@sparticuz/chromium";
import puppeteer from "puppeteer-core";

const ffmpeg = execFileSync("/var/task/bin/ffmpeg", ["-hide_banner", "-version"], {
  encoding: "utf-8",
});
console.log(ffmpeg.split("\n")[0]);
const browser = await puppeteer.launch({
  executablePath: await chromium.executablePath(),
  args: chromium.args,
});
try {
  const page = await browser.newPage();
  await page.setContent("<div style='width:64px;height:64px;background:#0a0'></div>");
  const shot = await page.screenshot({ clip: { x: 0, y: 0, width: 64, height: 64 } });
  console.log(`${await browser.version()} on ${process.arch}: ${shot.length} byte screenshot`);
} finally {
  await browser.close();
}
