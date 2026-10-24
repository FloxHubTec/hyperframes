import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openProjectHistory, type ProjectHistory } from "./projectHistory";
import type { HistoryWho } from "./historyLog";

const you: HistoryWho = { kind: "person", name: "You" };
const MiB = 1024 ** 2;
const cleanup: Array<() => unknown> = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step();
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

async function open(projectDir: string, historyRoot: string) {
  const history = await openProjectHistory({ projectDir, historyRoot, quietMs: 30 });
  cleanup.push(() => history.close());
  return history;
}

async function change(history: ProjectHistory, label: string, writes: () => void) {
  const window = await history.beginWindow(you, label);
  writes();
  const entry = await window.close();
  if (!entry) throw new Error("the window recorded nothing");
  return entry;
}

async function project() {
  const projectDir = tempDir("hf-undo-media-project-");
  const historyRoot = tempDir("hf-undo-media-root-");
  writeFileSync(join(projectDir, "index.html"), "A");
  const history = await open(projectDir, historyRoot);
  const media = join(projectDir, "join.mp4");
  return { projectDir, historyRoot, history, media };
}

describe("undoing a change that made or replaced media", () => {
  it("keeps the made file's bytes, so redo brings the same file back", async () => {
    const { history, media } = await project();
    const bytes = Buffer.alloc(2 * MiB, 7);
    const made = await change(history, "Place join", () => writeFileSync(media, bytes));

    const undone = await history.undo(made.id, { who: you });
    expect(existsSync(media)).toBe(false);

    const redone = await history.undo(undone.ok ? undone.entry!.id : "", { who: you });
    expect(redone).toMatchObject({ ok: true });
    expect(readFileSync(media).equals(bytes)).toBe(true);
  });

  it("still brings the file back after the history is closed and opened again", async () => {
    const { history, media, projectDir, historyRoot } = await project();
    const bytes = Buffer.alloc(2 * MiB, 9);
    const made = await change(history, "Place join", () => writeFileSync(media, bytes));
    const undone = await history.undo(made.id, { who: you });
    await history.close();

    const reopened = await open(projectDir, historyRoot);
    const redone = await reopened.undo(undone.ok ? undone.entry!.id : "", { who: you });
    expect(redone).toMatchObject({ ok: true });
    expect(readFileSync(media).equals(bytes)).toBe(true);
  });

  it("keeps the bytes a restore overwrites, so undoing the restore returns them", async () => {
    const { history, media, projectDir } = await project();
    const first = Buffer.alloc(2 * MiB, 1);
    const second = Buffer.alloc(2 * MiB, 2);
    const made = await change(history, "Place join", () => writeFileSync(media, first));
    await history.undo(made.id, { who: you });
    await change(history, "New join", () => writeFileSync(media, second));
    mkdirSync(join(projectDir, "x"), { recursive: true });

    const restored = await history.restore(made.id, you);
    expect(readFileSync(media).equals(first)).toBe(true);

    const back = await history.undo(restored!.id, { who: you });
    expect(back).toMatchObject({ ok: true });
    expect(readFileSync(media).equals(second)).toBe(true);
  });
});
