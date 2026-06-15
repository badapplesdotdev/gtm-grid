// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { useState } from "react";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Sheet, SheetContent } from "./sheet";

afterEach(cleanup);

function Harness({ onOpenChange }: { onOpenChange: (o: boolean) => void }) {
  const [open, setOpen] = useState(true);
  return (
    <Sheet
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        onOpenChange(o);
      }}
    >
      <SheetContent className="cell-details" srTitle="Cell details">
        <div>Panel body</div>
      </SheetContent>
    </Sheet>
  );
}

describe("Sheet primitive", () => {
  it("renders an accessible side panel", () => {
    render(<Harness onOpenChange={vi.fn()} />);
    expect(screen.getByRole("dialog", { name: "Cell details" })).toBeTruthy();
    expect(screen.getByText("Panel body")).toBeTruthy();
  });

  it("closes on Escape via onOpenChange", async () => {
    const onOpenChange = vi.fn();
    const user = userEvent.setup();
    render(<Harness onOpenChange={onOpenChange} />);
    await user.keyboard("{Escape}");
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(screen.queryByText("Panel body")).toBeNull();
  });
});
