// @vitest-environment happy-dom

import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useDockLayoutStore } from "../dock/dockLayoutStore";
import { mountCompositionsTab, rerenderCompositionsTab } from "./compositionsTabTestUtils";

function browseButton(host: HTMLElement): HTMLButtonElement | undefined {
  return [...host.querySelectorAll("button")].find((button) =>
    button.textContent?.includes("Browse starter scenes"),
  );
}

describe("CompositionsTab empty onboarding", () => {
  afterEach(() => {
    useDockLayoutStore.setState({ pendingActivation: null, controller: null });
    vi.restoreAllMocks();
  });

  it("shows one sentence and a keyboard-accessible action that opens the catalog", () => {
    const activatePanel = vi.spyOn(useDockLayoutStore.getState(), "activatePanel");
    const host = mountCompositionsTab({ compositions: [] });

    expect(host.textContent).toContain("Add a scene from the catalog to get started.");
    const button = browseButton(host);
    expect(button?.type).toBe("button");
    expect(button?.tabIndex).toBe(0);
    expect(button?.disabled).toBe(false);

    act(() => {
      button?.click();
    });
    expect(activatePanel).toHaveBeenCalledWith("catalog");
  });

  it("queues catalog when the dock has not attached yet", () => {
    useDockLayoutStore.setState({ controller: null, pendingActivation: null });
    const host = mountCompositionsTab({ compositions: ["index.html"] });
    act(() => {
      browseButton(host)?.click();
    });
    expect(useDockLayoutStore.getState().pendingActivation).toBe("catalog");
  });

  it("shows guidance under the only composition card", () => {
    const activatePanel = vi.spyOn(useDockLayoutStore.getState(), "activatePanel");
    const host = mountCompositionsTab({ compositions: ["index.html"] });

    expect(host.querySelectorAll('[draggable="true"]')).toHaveLength(1);
    expect(host.textContent).toContain("Add another scene from the catalog.");
    const browse = browseButton(host);
    expect(browse).toBeTruthy();

    act(() => {
      browse?.click();
    });
    expect(activatePanel).toHaveBeenCalledWith("catalog");
  });

  it("shows the same one-composition guidance for a scene that is not index.html", () => {
    const host = mountCompositionsTab({ compositions: ["compositions/hero.html"] });
    expect(host.querySelectorAll('[draggable="true"]')).toHaveLength(1);
    expect(host.textContent).toContain("Add another scene from the catalog.");
    expect(browseButton(host)).toBeTruthy();
  });

  it("keeps the composition card selectable when guidance is shown", () => {
    const onSelect = vi.fn();
    const host = mountCompositionsTab({ compositions: ["index.html"], onSelect });
    const card = host.querySelector<HTMLElement>('[draggable="true"]');
    expect(card).toBeTruthy();
    act(() => {
      card?.click();
    });
    expect(onSelect).toHaveBeenCalledWith("index.html");
  });

  it("hides guidance when a second composition appears", () => {
    const host = mountCompositionsTab({ compositions: ["index.html"] });
    expect(host.textContent).toContain("Add another scene from the catalog.");

    rerenderCompositionsTab({
      compositions: ["index.html", "compositions/headline.html"],
    });
    expect(host.textContent).not.toContain("Add another scene from the catalog.");
    expect(host.querySelectorAll('[draggable="true"]')).toHaveLength(2);
  });

  it("lists multiple compositions without onboarding", () => {
    const host = mountCompositionsTab({
      compositions: ["index.html", "compositions/headline.html"],
    });
    expect(host.querySelectorAll('[draggable="true"]')).toHaveLength(2);
    expect(host.textContent).not.toContain("Add a scene from the catalog to get started.");
    expect(host.textContent).not.toContain("Add another scene from the catalog.");
    expect(host.textContent).not.toContain("Browse starter scenes");
  });
});
