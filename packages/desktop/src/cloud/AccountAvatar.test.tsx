// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { AccountAvatar } from "./AccountBar";

describe("AccountAvatar — profile picture with letter fallback", () => {
  it("renders the profile image (no-referrer) when a URL is provided", () => {
    const { container } = render(
      <AccountAvatar image="https://avatars.example.com/u/1.png" letter="Y" />,
    );
    const img = container.querySelector("img.account-avatar-img");
    expect(img).not.toBeNull();
    expect(img?.getAttribute("src")).toBe("https://avatars.example.com/u/1.png");
    expect(img?.getAttribute("referrerpolicy")).toBe("no-referrer");
  });

  it("renders the initial letter when there is no image", () => {
    const { container } = render(<AccountAvatar image={null} letter="Y" />);
    expect(container.querySelector("img")).toBeNull();
    expect(container.textContent).toContain("Y");
  });

  it("treats an empty-string image as no image (renders the letter)", () => {
    const { container } = render(<AccountAvatar image="" letter="Z" />);
    expect(container.querySelector("img")).toBeNull();
    expect(container.textContent).toContain("Z");
  });
});
