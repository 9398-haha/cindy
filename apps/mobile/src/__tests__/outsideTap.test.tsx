// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { OutsideTapProvider, useOutsideTap } from "@/platform/OutsideTap";

const harness = vi.hoisted(() => ({
  root: {} as Record<string, (event: any) => void>,
}));
vi.mock("react-native", () => ({
  View: (props: any) => {
    harness.root = props;
    return createElement("div", {}, props.children);
  },
}));

let root: Root;
const onOutsideTap = vi.fn();
function Floating({ active }: { active: boolean }) {
  // The floating card occupies x/y 100..200.
  useOutsideTap(
    active,
    (x, y) => x >= 100 && x <= 200 && y >= 100 && y <= 200,
    onOutsideTap,
  );
  return null;
}
const render = (active = true) =>
  act(async () =>
    root.render(
      createElement(
        OutsideTapProvider,
        null,
        createElement(Floating, { active }),
      ),
    ),
  );
const touch = (
  name: "onTouchStart" | "onTouchMove" | "onTouchEnd" | "onTouchCancel",
  pageX = 0,
  pageY = 0,
  fingers = name === "onTouchEnd" || name === "onTouchCancel" ? 0 : 1,
) =>
  harness.root[name]({
    nativeEvent: { pageX, pageY, touches: Array.from({ length: fingers }) },
  });
const tap = (x: number, y: number) => {
  touch("onTouchStart", x, y);
  touch("onTouchEnd", x, y);
};

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  onOutsideTap.mockReset();
  root = createRoot(document.createElement("div"));
});
afterEach(async () => {
  await act(async () => root.unmount());
});

it("reports taps outside the floating area and ignores taps inside it", async () => {
  await render();
  tap(150, 150);
  expect(onOutsideTap).not.toHaveBeenCalled();
  tap(20, 400);
  expect(onOutsideTap).toHaveBeenCalledTimes(1);
});

it("lets scrolls, drags, pinches and cancelled touches pass without closing", async () => {
  await render();
  // Scroll the conversation underneath.
  touch("onTouchStart", 20, 400);
  touch("onTouchMove", 20, 300);
  touch("onTouchEnd", 20, 300);
  // A native scroll view taking over the gesture.
  touch("onTouchStart", 20, 400);
  touch("onTouchCancel");
  touch("onTouchEnd", 20, 400);
  // Two-finger gesture.
  touch("onTouchStart", 20, 400);
  touch("onTouchStart", 60, 400, 2);
  touch("onTouchEnd", 60, 400, 1);
  touch("onTouchEnd", 20, 400);
  expect(onOutsideTap).not.toHaveBeenCalled();
  // Small jitter still counts as a tap.
  touch("onTouchStart", 20, 400);
  touch("onTouchMove", 24, 403);
  touch("onTouchEnd", 24, 403);
  expect(onOutsideTap).toHaveBeenCalledTimes(1);
});

it("stops listening once the floating area closes", async () => {
  await render(false);
  tap(20, 400);
  await render(true);
  await render(false);
  tap(20, 400);
  expect(onOutsideTap).not.toHaveBeenCalled();
});
