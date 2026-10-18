// @vitest-environment happy-dom

import { act, type ComponentProps } from "react";
import { describe, expect, it, vi } from "vitest";
import { AssetsTab } from "./AssetsTab";
import { createHappyDomRootHarness } from "../../player/components/testRootHarness";

vi.mock("../../utils/studioApiFetch", () => ({
  studioApiFetch: vi.fn(async () => ({ ok: false, text: async () => "" })),
}));

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const { mount } = createHappyDomRootHarness();

function mountAssetsTab(props: Partial<ComponentProps<typeof AssetsTab>> = {}) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = mount(host);
  act(() => {
    root.render(<AssetsTab projectId="demo" assets={[]} onImport={vi.fn()} {...props} />);
  });
  return { host, root };
}

function chooseFilesButton(host: HTMLElement): HTMLButtonElement | undefined {
  return [...host.querySelectorAll("button")].find(
    (button) => button.textContent === "Choose files",
  );
}

describe("AssetsTab empty state", () => {
  it("shows one sentence and a Choose files button that opens the file picker", () => {
    const { host } = mountAssetsTab();
    expect(host.textContent).toContain("Drop media files here or choose files to get started");
    const choose = chooseFilesButton(host);
    expect(choose?.type).toBe("button");
    expect(choose?.tabIndex).toBe(0);

    const click = vi.spyOn(HTMLInputElement.prototype, "click").mockImplementation(() => {});
    act(() => choose?.click());
    expect(click).toHaveBeenCalledTimes(1);
    click.mockRestore();
  });

  it("omits Choose files when onImport is missing", () => {
    const { host } = mountAssetsTab({ onImport: undefined });
    expect(host.textContent).toContain("Drop media files here or choose files to get started");
    expect(chooseFilesButton(host)).toBeUndefined();
  });

  it("keeps Clear search when a query matches nothing", () => {
    const { host } = mountAssetsTab({ assets: ["assets/logo.png"] });
    const search = host.querySelector<HTMLInputElement>('input[aria-label="Search assets"]');
    expect(search).toBeTruthy();
    act(() => {
      if (!search) return;
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(
        search,
        "zzzz",
      );
      search.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(host.textContent).toContain("No assets match");
    expect(host.textContent).toContain("Clear search");
    expect(chooseFilesButton(host)).toBeUndefined();
  });

  it("hides the empty-state guidance after an asset appears", () => {
    const host = document.createElement("div");
    document.body.append(host);
    const root = mount(host);
    const onImport = vi.fn();
    act(() => {
      root.render(<AssetsTab projectId="demo" assets={[]} onImport={onImport} />);
    });
    expect(chooseFilesButton(host)).toBeTruthy();
    act(() => {
      root.render(<AssetsTab projectId="demo" assets={["assets/logo.png"]} onImport={onImport} />);
    });
    expect(chooseFilesButton(host)).toBeUndefined();
    expect(host.textContent).not.toContain("choose files to get started");
  });
});
