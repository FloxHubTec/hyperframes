import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const html = await readFile(new URL("./echo-smear.html", import.meta.url), "utf8");
const library = html.match(/<script>([\s\S]*?)<\/script>/i)[1];

// The snippet only touches window, document and gsap inside attachEchoSmear; the pure seams
// (count, lerpTrack, measurePoint) are reachable without a page.
function load() {
  const window = {};
  vm.runInNewContext(library, { window, document: {}, gsap: {}, Element: class {}, console });
  return window.__echoSmear;
}

const defaults = { threshold: 40, length: 100, countMult: 1, maxEchoes: 60, edgeSpacing: 1.5 };
const exact = { ...defaults, edgeSpacing: 0 };

test("count is zero below the half-frame threshold and rounds above it", () => {
  const { count } = load();
  assert.equal(count(19.9, 0, exact), 0);
  assert.equal(count(20.5, 0, exact), 21);
});

test("count scales with smear length", () => {
  const { count } = load();
  assert.equal(count(30, 0, { ...exact, length: 50 }), 15);
});

test("count is raised until the edge moves at most edgeSpacing per copy, then capped", () => {
  const { count } = load();
  assert.equal(count(30, 300, { ...defaults, maxEchoes: 400 }), 200);
  assert.equal(count(30, 300, defaults), 60);
});

test("the edge raise never turns a smear on by itself", () => {
  const { count } = load();
  assert.equal(count(10, 300, defaults), 0);
});

test("measurePoint offsets a box fraction by the element's rotation", () => {
  const { measurePoint } = load();
  const [x, y] = measurePoint([100, 100], [0, 0, 90, 1, 1, 1], [40, 20], [0, 0.5]);
  assert.ok(Math.abs(x - 100) < 1e-9, `x ${x}`);
  assert.ok(Math.abs(y - 80) < 1e-9, `y ${y}`);
});

test("lerpTrack interpolates opacity and clamps before the start", () => {
  const { lerpTrack } = load();
  const track = [
    [0, 0, 0, 1, 1, 0],
    [0, 0, 0, 1, 1, 1],
  ];
  assert.equal(lerpTrack(track, 1, 0.5, [])[5], 0.5);
  assert.equal(lerpTrack(track, 1, -3, [])[5], 0);
});
