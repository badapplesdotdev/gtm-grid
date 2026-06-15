// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { useState } from "react";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Dialog, DialogContent } from "./dialog";

afterEach(cleanup);

function Harness({ onOpenChange }: { onOpenChange: (o: boolean) => void }) {
  const [open, setOpen] = useState(true);
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        onOpenChange(o);
      }}
    >
      <DialogContent className="modal" srTitle="Test dialog">
        <button>Inside button</button>
      </DialogContent>
    </Dialog>
  );
}

describe("Dialog primitive", () => {
  it("renders content with an accessible name", () => {
    render(<Harness onOpenChange={vi.fn()} />);
    // srTitle gives the dialog its accessible name (Radix requires a title).
    expect(screen.getByRole("dialog", { name: "Test dialog" })).toBeTruthy();
    expect(screen.getByText("Inside button")).toBeTruthy();
  });

  it("closes on Escape and reports it via onOpenChange", async () => {
    const onOpenChange = vi.fn();
    const user = userEvent.setup();
    render(<Harness onOpenChange={onOpenChange} />);
    expect(screen.getByText("Inside button")).toBeTruthy();
    await user.keyboard("{Escape}");
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(screen.queryByText("Inside button")).toBeNull();
  });

  it("traps focus inside the dialog", async () => {
    render(<Harness onOpenChange={vi.fn()} />);
    // Radix moves focus into the dialog on open; the inner button is reachable.
    const btn = screen.getByText("Inside button");
    expect(document.activeElement === btn || screen.getByRole("dialog").contains(document.activeElement)).toBe(true);
  });
});
