import { spawnSync } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Browser } from "puppeteer-core";
import { resolveHeadlessShellPath } from "./browserManager.js";
import { queryElementStacking } from "./videoFrameInjector.js";
import { applyDomLayerMask, removeDomLayerMask } from "./screenshotService.js";
import { groupIntoLayers } from "../utils/layerCompositor.js";
import { closeTestChrome, launchTestChrome } from "./__fixtures__/loopback.js";

const chromePath = resolveHeadlessShellPath();
const hasBrowser = chromePath !== undefined && spawnSync(chromePath, ["--version"]).status === 0;

function composition(nestedComposition = false, words = 0): string {
  return `<body style="margin:0">
    <div id="root" data-composition-id="main" data-start="0" style="position:relative;width:240px;height:240px">
      <div style="position:absolute;z-index:2"><video id="plate" data-start="0" style="width:120px;height:120px"></video></div>
      <div id="lower" ${nestedComposition ? 'data-composition-id="sub" data-start="0"' : ""} style="position:absolute;z-index:1">
        <div><span id="badge" style="position:absolute;z-index:3">lower third</span></div>
      </div>
      <div id="caps" style="position:absolute;z-index:4;opacity:0.5">
        <span id="label" style="visibility:visible!important">caption</span>
        <svg><path id="shape"></path></svg>
        <div id="kept"><span>separate layer</span></div>
        ${"<span>word</span>".repeat(words)}
      </div>
    </div>
  </body>`;
}

describe.skipIf(!hasBrowser)("HDR overlay layers in Chrome", () => {
  let browser: Browser;
  beforeAll(async () => {
    browser = await launchTestChrome(chromePath);
  });
  afterAll(() => closeTestChrome(browser));

  it.each([false, true])("keeps a badge below HDR with composition host=%s", async (nested) => {
    const page = await browser.newPage();
    try {
      await page.setContent(composition(nested));
      const stacking = await queryElementStacking(page, new Set(["plate"]));
      expect(stacking.map((entry) => entry.id)).not.toContain("badge");
      const layers = groupIntoLayers(stacking);
      expect(layers.at(-1)).toEqual({ type: "dom", elementIds: ["caps"] });
      expect(layers[0]?.elementIds).toContain("lower");
    } finally {
      await page.close();
    }
  });

  it("hides overlay children from the root layer and restores authored visibility", async () => {
    const page = await browser.newPage();
    try {
      await page.setContent(composition());
      await applyDomLayerMask(page, ["root", "kept"], ["caps"]);
      const visibility = await page.evaluate(() =>
        ["label", "shape", "kept"].map((id) => {
          const node = document.getElementById(id);
          if (!node) throw new Error(`Missing fixture node: ${id}`);
          return getComputedStyle(node).visibility;
        }),
      );
      expect(visibility).toEqual(["hidden", "hidden", "visible"]);
      await removeDomLayerMask(page, []);
      expect(await page.$eval("#label", (node) => node.style.getPropertyValue("visibility"))).toBe(
        "visible",
      );
      expect(
        await page.$eval("#label", (node) => node.style.getPropertyPriority("visibility")),
      ).toBe("important");
      expect(await page.$eval("#caps", (node) => getComputedStyle(node).opacity)).toBe("0.5");
    } finally {
      await page.close();
    }
  });

  it("records stacking-query cost on a 2000-word caption", async () => {
    const page = await browser.newPage();
    try {
      await page.setContent(composition(false, 2000));
      const durations: number[] = [];
      for (let frame = 0; frame < 30; frame++) {
        const start = performance.now();
        const stacking = await queryElementStacking(page, new Set(["plate"]));
        durations.push(performance.now() - start);
        expect(stacking.map((entry) => entry.id)).toContain("caps");
      }
      durations.sort((a, b) => a - b);
      console.info("HDR stacking query (2000 caption words, including CDP round trip)", {
        samples: durations.length,
        medianMs: durations[15],
        p95Ms: durations[28],
      });
    } finally {
      await page.close();
    }
  });
});
