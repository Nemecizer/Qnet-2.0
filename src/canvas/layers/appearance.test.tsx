// The on-screen colour set follows Qnet's appearance (theme, Increase Contrast), and the canvas's
// fades stand down under Reduce Motion (ledger CAN-204).
import { act, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { setAppearance } from "../../lib/theme";
import css from "../canvas.css?raw";
import styles from "../../styles.css?raw";
import { canvasColors } from "./colors";
import { useCanvasColors, useReducedMotion } from "./useCanvasColors";

function Probe() {
  const c = useCanvasColors();
  const reduce = useReducedMotion();
  return (
    <p data-testid="probe" data-reduce={String(reduce)} data-hairline={c.hairline}>
      {c.stationFill}
    </p>
  );
}

describe("useCanvasColors", () => {
  it("resolves the light set, then dark, then Increase Contrast, as the appearance changes", () => {
    render(<Probe />);
    const p = screen.getByTestId("probe");
    expect(p).toHaveTextContent(canvasColors("light").stationFill);
    act(() => setAppearance({ theme: "dark" }));
    expect(p).toHaveTextContent(canvasColors("dark").stationFill);
    act(() => setAppearance({ contrast: "more" }));
    expect(p).toHaveTextContent(canvasColors("dark", true).stationFill);
    expect(p).toHaveAttribute("data-hairline", "1.5");
    act(() => setAppearance({ theme: "light", contrast: "system" }));
    expect(p).toHaveTextContent(canvasColors("light").stationFill);
    expect(p).toHaveAttribute("data-hairline", "1");
  });

  it("reports Reduce Motion, and the fades last --dur-1, which is 0 under it", () => {
    render(<Probe />);
    const p = screen.getByTestId("probe");
    expect(p).toHaveAttribute("data-reduce", "false");
    act(() => setAppearance({ motion: "reduce" }));
    expect(p).toHaveAttribute("data-reduce", "true");
    expect(css).toMatch(/\.canvas-fade \{ transition: opacity var\(--dur-1\)/);
    expect(css).toMatch(/:root\[data-motion="reduce"\] \.canvas-fade \{ transition: none; \}/);
    expect(styles).toMatch(/:root\[data-motion="reduce"\] \{ --dur-1: 0ms;/);
    act(() => setAppearance({ motion: "system" }));
  });
});
