import { describe, it, expect } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mapInspection } from "../src/mapInspection";
import { Sources } from "../src/sources";
import type { ElementRef, RuntimeResponse, Snippet } from "../src/types";

describe("components report compositions", () => {
  const files = {
    "index.html": [
      `<html><body>`,
      `<div id="root" data-composition-id="main" data-start="0" data-duration="20">`,
      `<div id="film" data-composition-id="film" data-composition-src="films/a/index.html"`,
      `     data-start="2" data-duration="10"></div>`,
      `</div>`,
      `</body></html>`,
    ],
    "films/a/index.html": [
      `<html><head><style>`,
      `#word{${"color:red;".repeat(40)}}`,
      `</style></head><body>`,
      `<div id="film-root" data-composition-id="film" data-duration="10">`,
      `<!-- <div data-composition-src="films/a/scene.html"> -->`,
      `<div id="sec" data-composition-id="scene" data-composition-src="./films/a/scene.html"`,
      `     data-start="1" data-duration="3"></div>`,
      `</div>`,
      `</body></html>`,
    ],
    "films/a/scene.html": [
      `<template id="scene-template">`,
      `<div id="scene-root" data-composition-id="scene" data-duration="3">`,
      `<p>One<p><span id="word">Hi</span>`,
      `</div>`,
      `</template>`,
    ],
  };
  const ref = (id: string, tag: string): ElementRef => ({
    ref: `hfi:g:${id}`,
    tag,
    id,
    hfId: null,
    classes: [],
    composition: null,
  });

  function inspectIds(
    ids: [string, string][],
    request: Partial<Parameters<typeof mapInspection>[1]>,
  ) {
    const dir = mkdtempSync(join(tmpdir(), "inspect-compositions-"));
    mkdirSync(join(dir, "films/a"), { recursive: true });
    for (const [file, lines] of Object.entries(files))
      writeFileSync(join(dir, file), lines.join("\n"));
    try {
      const sources = new Sources(dir);
      const raw: RuntimeResponse = {
        results: ids.map(([id, tag]) => ({
          target: { selector: `#${id}` },
          status: "found",
          candidates: [ref(id, tag)],
          animations: [],
          elements: [ref(id, tag)],
          css: sources.cssRules.filter((rule) => rule.selector === `#${id}`).map((rule) => rule.id),
          truncated: false,
        })),
        recorded: 0,
        recordLimitReached: false,
        hooked: true,
      };
      return mapInspection(
        raw,
        { targets: ids.map(([id]) => ({ selector: `#${id}` })), ...request },
        {
          sources,
          map: () => [],
          catalog: new Map<string, Snippet>(),
          generation: "g",
          sourceVersion: "v",
          reused: false,
          start: performance.now(),
        },
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  const shown = (report: ReturnType<typeof inspectIds>) =>
    report.snippets.map((s) => [s.id, s.kind.join(",")]).sort();

  it("shows every composition and host that times an element inside a sub-composition", () => {
    const report = inspectIds([["word", "span"]], { maxBytes: 256000 });
    expect(shown(report)).toEqual(
      [
        ["films/a/index.html:2-2", "matched CSS candidate"],
        ["films/a/scene.html:3-3", "html opening tag"],
        ["films/a/index.html:4-4", "composition root"],
        ["films/a/index.html:6-7", "composition host"],
        ["films/a/scene.html:2-2", "composition root"],
        ["index.html:2-4", "composition root,composition host"],
      ].sort(),
    );
  });

  it("shows the root a targeted host mounts and the compositions around the host", () => {
    const report = inspectIds([["sec", "div"]], { maxBytes: 256000 });
    expect(shown(report)).toEqual(
      [
        ["films/a/index.html:6-7", "html opening tag"],
        ["films/a/index.html:4-4", "composition root"],
        ["films/a/scene.html:2-2", "composition root"],
        ["index.html:2-4", "composition root,composition host"],
      ].sort(),
    );
  });

  it("leaves out a composition tag another snippet already shows", () => {
    const report = inspectIds(
      [
        ["word", "span"],
        ["film", "div"],
      ],
      { maxBytes: 256000 },
    );
    const lines = report.snippets.map((s) => `${s.file}:${s.startLine}`);
    expect(new Set(lines).size).toBe(lines.length);
    expect(report.snippets.find((s) => s.id === "index.html:3-4")?.kind).toEqual([
      "html opening tag",
    ]);
    expect(report.snippets.find((s) => s.id === "index.html:2-2")?.kind).toEqual([
      "composition root",
    ]);
  });

  it("omits composition tags before the snippets about the element itself", () => {
    const report = inspectIds([["word", "span"]], { maxBytes: 2700 });
    expect(report.snippets.map((s) => s.kind[0])).toEqual([
      "matched CSS candidate",
      "html opening tag",
    ]);
    expect(report.omitted.map((s) => s.id)).toEqual([
      "films/a/index.html:4-4",
      "films/a/index.html:6-7",
      "films/a/scene.html:2-2",
      "index.html:2-4",
    ]);
    expect(report.nextOffset).toBe(2);
  });
});
