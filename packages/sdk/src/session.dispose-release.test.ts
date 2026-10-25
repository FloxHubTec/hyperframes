import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { openComposition } from "./index.js";

setFlagsFromString("--expose-gc");
const gc = runInNewContext("gc") as () => void;

const HTML = `
<div data-hf-id="hf-stage" data-hf-root style="width: 320px; height: 180px" data-duration="1">
  <h1 data-hf-id="hf-title">Owned title</h1>
</div>
`.trim();

const SWAPS = 10;

describe("session disposal releases the parsed film", () => {
  it("keeps no parsed document alive for a disposed session that is still referenced", async () => {
    // Studio's closures and React fibers keep replaced sessions reachable, so the
    // sessions stay referenced here and only their documents may be freed.
    const stale = [];
    const films: WeakRef<object>[] = [];
    for (let i = 0; i < SWAPS; i++) {
      const comp = await openComposition(HTML, { history: false });
      films.push(
        new WeakRef((comp as unknown as { parsed: { document: object } }).parsed.document),
      );
      comp.dispose();
      stale.push(comp);
    }
    // A WeakRef target survives the job that created or read it.
    await Promise.resolve();
    await new Promise<void>((resolve) => setImmediate(resolve));
    gc();
    await new Promise<void>((resolve) => setImmediate(resolve));
    gc();
    expect(stale).toHaveLength(SWAPS);
    expect(films.filter((film) => film.deref() !== undefined)).toHaveLength(0);
  });
});
