import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, vi } from "vitest";
import { thumbnailScheduler } from "../../player/lib/thumbnailScheduler";
import { usePlayerStore } from "../../player/store/playerStore";
import { CompositionsTab } from "./CompositionsTab";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
(
  window as unknown as { happyDOM: { settings: { disableIframePageLoading: boolean } } }
).happyDOM.settings.disableIframePageLoading = true;

let root: Root | null = null;

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  thumbnailScheduler.invalidateProject("demo");
  document.body.innerHTML = "";
  usePlayerStore.setState({ thumbnailRevisions: {} });
});

const defaultCompositionsTabProps: Pick<
  ComponentProps<typeof CompositionsTab>,
  "projectId" | "compositions" | "activeComposition"
> = {
  projectId: "demo",
  compositions: ["compositions/headline.html"],
  activeComposition: null,
};

function renderCompositionsTab(props: Partial<ComponentProps<typeof CompositionsTab>> = {}): void {
  act(() => {
    root?.render(
      <CompositionsTab {...defaultCompositionsTabProps} onSelect={vi.fn()} {...props} />,
    );
  });
}

export function mountCompositionsTab(props: Partial<ComponentProps<typeof CompositionsTab>> = {}) {
  if (root) act(() => root?.unmount());
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  renderCompositionsTab(props);
  return host;
}

export function rerenderCompositionsTab(
  props: Partial<ComponentProps<typeof CompositionsTab>> = {},
): void {
  if (!root) throw new Error("mountCompositionsTab first");
  renderCompositionsTab(props);
}
