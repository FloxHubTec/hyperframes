import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import { Window } from "happy-dom";

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

// Fixes after the final review: mutation-resistant seam cases.
test("count rounds the half-frame travel to the nearest copy, and the edge raise rounds up", () => {
  const { count } = load();
  assert.equal(count(20.4, 0, exact), 20);
  assert.equal(count(20.6, 0, exact), 21);
  assert.equal(count(30, 300.3, { ...defaults, maxEchoes: 400 }), 201);
});

test("count needs travel strictly above half the threshold", () => {
  const { count } = load();
  assert.equal(count(20, 0, exact), 0);
});

test("measurePoint scales the box fraction by the element's scale", () => {
  const { measurePoint } = load();
  const [x, y] = measurePoint([100, 100], [0, 0, 90, 2, 1, 1], [40, 20], [0, 0.5]);
  assert.ok(Math.abs(x - 100) < 1e-9, `x ${x}`);
  assert.ok(Math.abs(y - 60) < 1e-9, `y ${y}`);
});

test("lerpTrack clamps after the end of the record", () => {
  const { lerpTrack } = load();
  const track = [
    [0, 0, 0, 1, 1, 0],
    [0, 0, 0, 1, 1, 1],
  ];
  assert.equal(lerpTrack(track, 1, 5, [])[5], 1);
});

// A page: happy-dom for the tree, a fake gsap and timeline so the snippet's own logic (the recording
// sweep, the copy poses, visibility, selection) runs without a browser. The fake timeline drives
// `pose(t)` for each target on every seek, then fires the proxy tween's onUpdate, as the runtime does.
function page(poseOf) {
  const win = new Window({ url: "http://localhost/" });
  const props = new WeakMap();
  const calls = { set: 0 };
  const warnings = [];
  const read = (el) => {
    if (!props.has(el))
      props.set(el, { x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1, opacity: 1 });
    return props.get(el);
  };
  const gsap = {
    getProperty: (el, p) => read(el)[p],
    set: (el, vars) => {
      calls.set++;
      const { visibility, ...rest } = vars;
      Object.assign(read(el), rest);
      if (visibility !== undefined) el.style.visibility = visibility;
    },
  };
  win.HTMLElement.prototype.getBoundingClientRect = function () {
    if (this.hasAttribute("data-composition-id"))
      return { left: 0, top: 0, width: 800, height: 450 };
    const p = read(this);
    return { left: p.x, top: p.y, width: 20, height: 20 };
  };
  const updates = [];
  const tl = {
    t: 0,
    time() {
      return this.t;
    },
    duration() {
      return 1;
    },
    seek(t) {
      this.t = t;
      for (const [el, fn] of poseOf) Object.assign(read(el), fn(t));
      updates.forEach((u) => u());
    },
    to(_t, vars) {
      updates.push(vars.onUpdate);
    },
  };
  const con = { warn: (m) => warnings.push(String(m)), log() {}, error() {} };
  vm.runInNewContext(library, {
    window: win,
    document: win.document,
    gsap,
    Element: win.Element,
    getComputedStyle: (e) => win.getComputedStyle(e),
    console: con,
  });
  return { win, gsap, tl, read, calls, warnings, attach: win.attachEchoSmear };
}

const MOVER =
  '<div id="root" data-composition-id="c" data-fps="30"><div class="card" id="a" style="position:absolute" data-start="0" data-duration="1"></div></div>';

test("copies use visibility inherit, so a hidden scene hides them too", () => {
  const poseOf = new Map();
  const pg = page(poseOf);
  pg.win.document.body.innerHTML = MOVER;
  const a = pg.win.document.getElementById("a");
  poseOf.set(a, (t) => ({ x: 600 * t }));
  pg.attach("#a", pg.tl, { threshold: 10, edgeSpacing: 0 });
  pg.tl.seek(0.5);
  const shown = [...pg.win.document.querySelectorAll(".es-clone")].filter(
    (c) => c.style.visibility !== "hidden",
  );
  assert.ok(shown.length > 0, "a fast mover has copies");
  assert.ok(
    shown.every((c) => c.style.visibility === "inherit"),
    "no copy forces visibility: visible",
  );
});

test("copy i shows the pose from i copy-intervals earlier", () => {
  const poseOf = new Map();
  const pg = page(poseOf);
  pg.win.document.body.innerHTML = MOVER;
  const a = pg.win.document.getElementById("a");
  poseOf.set(a, (t) => ({ x: 600 * t }));
  pg.attach("#a", pg.tl, { threshold: 10, edgeSpacing: 0 });
  pg.tl.seek(0.5);
  const shown = [...pg.win.document.querySelectorAll(".es-clone")].filter(
    (c) => c.style.visibility !== "hidden",
  );
  // 600 px/s over a half frame (1/60 s) = 10 px, so n = 10 copies spaced fd/10 apart.
  assert.equal(shown.length, 10);
  const xs = shown.map((c) => pg.read(c).x).sort((p, q) => q - p);
  assert.ok(Math.abs(xs[0] - 600 * (0.5 - 1 / 300)) < 0.5, `nearest copy ${xs[0]}`);
  assert.ok(Math.abs(xs[9] - 600 * (0.5 - 10 / 300)) < 0.5, `farthest copy ${xs[9]}`);
});

test("an element already attached is not attached again, and copies lose timing attributes", () => {
  const poseOf = new Map();
  const pg = page(poseOf);
  pg.win.document.body.innerHTML = MOVER;
  const a = pg.win.document.getElementById("a");
  poseOf.set(a, (t) => ({ x: 600 * t }));
  pg.attach(".card", pg.tl, { threshold: 10, edgeSpacing: 0, maxEchoes: 20 });
  pg.attach(".card", pg.tl, { threshold: 10, edgeSpacing: 0, maxEchoes: 20 });
  assert.equal(
    pg.win.document.querySelectorAll(".card").length,
    1 + 20,
    "one original plus one set of 20 copies: the second call attaches nothing",
  );
  assert.equal(pg.win.document.querySelectorAll(".es-clone[data-start]").length, 0);
  assert.equal(pg.win.document.querySelectorAll(".es-clone[data-duration]").length, 0);
});

test("a later attach does not redraw earlier copies while it records", () => {
  const poseOf = new Map();
  const pg = page(poseOf);
  pg.win.document.body.innerHTML = MOVER.replace(
    "</div></div>",
    '</div><div class="other" id="b" style="position:absolute"></div></div>',
  );
  poseOf.set(pg.win.document.getElementById("a"), (t) => ({ x: 600 * t }));
  pg.attach("#a", pg.tl, { threshold: 10, edgeSpacing: 0 });
  pg.calls.set = 0;
  pg.attach("#b", pg.tl, {});
  assert.ok(pg.calls.set <= 5, `later attach made ${pg.calls.set} writes`);
});

test("the group takes the target's z-index, so the wrapped target keeps its place in the stack", () => {
  const poseOf = new Map();
  const pg = page(poseOf);
  pg.win.document.body.innerHTML =
    '<div id="root" data-composition-id="c" data-fps="30"><div id="a" style="position:absolute;z-index:7"></div></div>';
  poseOf.set(pg.win.document.getElementById("a"), (t) => ({ x: 600 * t }));
  pg.attach("#a", pg.tl, { threshold: 10 });
  assert.equal(pg.win.document.querySelector("[data-hf-echo-group]").style.zIndex, "7");
});

// Task 1 of the review-fix plan: the copy layer is a sibling group, like registry motion-blur.
function fastMover(html) {
  const poseOf = new Map();
  const pg = page(poseOf);
  pg.win.document.body.innerHTML = html;
  return { pg, poseOf, doc: pg.win.document };
}
const ROOT = (inner) => `<div id="root" data-composition-id="c" data-fps="30">${inner}</div>`;

test("the target is not re-parented or restyled", () => {
  const { pg, poseOf, doc } = fastMover(ROOT('<div id="a" style="position:absolute"></div>'));
  const a = doc.getElementById("a");
  const parent = a.parentNode;
  poseOf.set(a, (t) => ({ x: 600 * t }));
  pg.attach("#a", pg.tl, { threshold: 10, edgeSpacing: 0 });
  assert.ok(a.parentNode === parent, "same parent"); // not assert.equal: a failing diff of DOM nodes never finishes
  assert.equal(a.style.mixBlendMode, "");
  assert.equal(a.style.pointerEvents, "");
  assert.ok(
    a.previousElementSibling && a.previousElementSibling.hasAttribute("data-hf-echo-group"),
    "the group sits just before it",
  );
});

test("a statically positioned target smears in place", () => {
  const { pg, poseOf, doc } = fastMover(ROOT('<div id="a"></div><div id="after"></div>'));
  const a = doc.getElementById("a");
  poseOf.set(a, (t) => ({ x: 600 * t }));
  pg.attach("#a", pg.tl, { threshold: 10, edgeSpacing: 0 });
  pg.tl.seek(0.5);
  const shown = [...doc.querySelectorAll(".es-clone")].filter(
    (c) => c.style.visibility !== "hidden",
  );
  assert.ok(shown.length > 0, "copies show");
  assert.ok(
    shown.every((c) => c.style.position === "absolute"),
    "copies are out of flow",
  );
  assert.ok(doc.getElementById("after").previousElementSibling === a, "the layout is untouched");
});

test("the group mirrors the target's own visibility", () => {
  const { pg, poseOf, doc } = fastMover(ROOT('<div id="a" style="position:absolute"></div>'));
  const a = doc.getElementById("a");
  poseOf.set(a, (t) => ({ x: 600 * t }));
  pg.attach("#a", pg.tl, { threshold: 10, edgeSpacing: 0 });
  const group = a.previousElementSibling;
  pg.tl.seek(0.5);
  assert.equal(group.style.visibility, "", "visible target: the group follows its parent");
  a.style.visibility = "hidden";
  pg.tl.seek(0.5);
  assert.equal(group.style.visibility, "hidden");
});

test("copies of copies are never targets, and an element is attached once", () => {
  const { pg, poseOf, doc } = fastMover(
    ROOT(
      '<div class="word" id="w" style="position:absolute"><span class="char" id="c1"></span></div>',
    ),
  );
  poseOf.set(doc.getElementById("w"), (t) => ({ x: 600 * t }));
  poseOf.set(doc.getElementById("c1"), (t) => ({ x: 300 * t }));
  pg.attach(".word", pg.tl, { threshold: 10, edgeSpacing: 0, maxEchoes: 5 });
  pg.attach(".word .char", pg.tl, { threshold: 10, edgeSpacing: 0, maxEchoes: 5 });
  assert.equal(
    doc.querySelectorAll("[data-hf-echo-group]").length,
    2,
    "one group for .word, one for the original .char",
  );
  pg.attach(".word .char", pg.tl, { threshold: 10, edgeSpacing: 0, maxEchoes: 5 });
  assert.equal(
    doc.querySelectorAll("[data-hf-echo-group]").length,
    2,
    "attaching it again adds nothing",
  );
});

test("media inside a target is not cloned live", () => {
  const { pg, poseOf, doc } = fastMover(
    ROOT(
      '<div id="a" style="position:absolute"><video poster="p.png"></video><audio></audio></div>',
    ),
  );
  poseOf.set(doc.getElementById("a"), (t) => ({ x: 600 * t }));
  pg.attach("#a", pg.tl, { threshold: 10, edgeSpacing: 0, maxEchoes: 4 });
  assert.equal(
    doc.querySelectorAll(".es-clone video, .es-clone audio, .es-clone iframe").length,
    0,
  );
  assert.equal(doc.querySelectorAll("#a video").length, 1, "the original keeps its video");
});
