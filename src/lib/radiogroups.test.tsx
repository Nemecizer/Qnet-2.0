// Every segmented control answers the radiogroup keys (ledger WF-609).
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { installRadioGroups } from "./radiogroups";

function Group({ disabled = "" }: { disabled?: string }) {
  const [v, setV] = useState("b");
  return (
    <>
      <button type="button">before</button>
      <div role="radiogroup" aria-label="Mode">
        {["a", "b", "c", "d"].map((o) => (
          <button key={o} type="button" role="radio" aria-checked={v === o} disabled={o === disabled} onClick={() => setV(o)}>
            {o}
          </button>
        ))}
      </div>
      <button type="button">after</button>
    </>
  );
}

let stop = () => {};
beforeEach(() => void (stop = installRadioGroups(document)));
afterEach(() => stop());

const radio = (name: string) => screen.getByRole("radio", { name });
const checked = () => screen.getAllByRole("radio").find((r) => r.getAttribute("aria-checked") === "true")!.textContent;

describe("radiogroup keys", () => {
  it("arrows move and choose, wrapping; Home and End jump; a disabled choice is skipped", () => {
    render(<Group disabled="c" />);
    radio("b").focus();
    fireEvent.keyDown(radio("b"), { key: "ArrowRight" });
    expect(radio("d")).toHaveFocus();
    expect(checked()).toBe("d");
    fireEvent.keyDown(radio("d"), { key: "ArrowDown" });
    expect(checked()).toBe("a");
    fireEvent.keyDown(radio("a"), { key: "ArrowLeft" });
    expect(checked()).toBe("d");
    fireEvent.keyDown(radio("d"), { key: "Home" });
    expect(checked()).toBe("a");
    fireEvent.keyDown(radio("a"), { key: "End" });
    expect(radio("d")).toHaveFocus();
  });

  it("leaves other keys, and keys with a modifier, alone", () => {
    render(<Group />);
    radio("b").focus();
    expect(fireEvent.keyDown(radio("b"), { key: "ArrowRight", metaKey: true })).toBe(true);
    expect(fireEvent.keyDown(radio("b"), { key: "x" })).toBe(true);
    expect(checked()).toBe("b");
  });

  it("is one Tab stop: Tab skips the other choices, and focus arriving from outside goes to the chosen one", async () => {
    render(<Group />);
    radio("b").focus();
    fireEvent.keyDown(radio("b"), { key: "Tab" });
    expect(screen.getAllByRole("radio").map((r) => r.tabIndex)).toEqual([-1, 0, -1, -1]);
    await act(async () => void (await new Promise((r) => setTimeout(r, 5))));
    expect(screen.getAllByRole("radio").map((r) => r.getAttribute("tabindex"))).toEqual([null, null, null, null]);
    // Tab from "before" lands on the first radio; the chosen one takes it.
    screen.getByRole("button", { name: "before" }).focus();
    radio("a").focus();
    expect(radio("b")).toHaveFocus();
    // Shift-Tab from "after" lands on the last.
    screen.getByRole("button", { name: "after" }).focus();
    radio("d").focus();
    expect(radio("b")).toHaveFocus();
  });

  it("stops when removed", () => {
    render(<Group />);
    stop();
    radio("b").focus();
    fireEvent.keyDown(radio("b"), { key: "ArrowRight" });
    expect(checked()).toBe("b");
  });
});
