// @vitest-environment jsdom
/**
 * The agent chat's markdown renderer (`Markdown`, a thin wrapper over Streamdown
 * scoped with the `.agent-md` class). Streamdown owns the GFM → ReactNode parse;
 * these tests pin the rendered DOM for the constructs the chat actually streams
 * (bold, emphasis, inline code, links, lists, headings, fenced code) and that it
 * renders *incomplete* markdown — mid-stream SSE tokens — without throwing.
 *
 * Streamdown tags every node with `data-streamdown="<role>"` rather than always
 * using the semantic element (e.g. bold is a styled <span>, links are <button>s),
 * so the assertions key off those role markers + text content, not tag names.
 */
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { Markdown } from "./AgentPanel";

// Streamdown highlights fenced code asynchronously; unmount after every test so a
// late highlight commit can't fire into a torn-down jsdom (a "window is not
// defined" unhandled error). No global testing-library auto-cleanup is wired up.
afterEach(cleanup);

describe("Markdown — agent chat renderer", () => {
  it("scopes output with the .agent-md class", () => {
    const { container } = render(<Markdown text="hello" />);
    expect(container.querySelector(".agent-md")).not.toBeNull();
    expect(container.textContent).toContain("hello");
  });

  it("renders bold and emphasis", () => {
    const { container } = render(<Markdown text="**bold** then *em*" />);
    const strong = container.querySelector('[data-streamdown="strong"]');
    expect(strong?.textContent).toBe("bold");
    expect(container.querySelector("em")?.textContent).toBe("em");
  });

  it("renders inline code", () => {
    const { container } = render(<Markdown text="use `npm run` here" />);
    const code = container.querySelector('[data-streamdown="inline-code"]');
    expect(code?.textContent).toBe("npm run");
  });

  it("renders links with their label text", () => {
    const { container } = render(<Markdown text="see [the docs](https://example.com)" />);
    const link = container.querySelector('[data-streamdown="link"]');
    expect(link).not.toBeNull();
    expect(link?.textContent).toBe("the docs");
  });

  it("renders unordered list items", () => {
    const { container } = render(<Markdown text={"- one\n- two\n- three"} />);
    const items = container.querySelectorAll('[data-streamdown="list-item"]');
    expect(items).toHaveLength(3);
    expect(Array.from(items).map((li) => li.textContent)).toEqual(["one", "two", "three"]);
  });

  it("renders ordered list items", () => {
    const { container } = render(<Markdown text={"1. first\n2. second"} />);
    expect(container.querySelector('[data-streamdown="ordered-list"]')).not.toBeNull();
    const items = container.querySelectorAll('[data-streamdown="list-item"]');
    expect(Array.from(items).map((li) => li.textContent)).toEqual(["first", "second"]);
  });

  it("renders headings", () => {
    const { container } = render(<Markdown text={"# Title\n\nbody"} />);
    const h1 = container.querySelector('[data-streamdown="heading-1"]');
    expect(h1?.textContent).toBe("Title");
  });

  it("renders fenced code blocks with their contents", () => {
    const { container } = render(<Markdown text={"```js\nconst x = 1;\n```"} />);
    const block = container.querySelector('[data-streamdown="code-block"]');
    expect(block).not.toBeNull();
    expect(block?.getAttribute("data-language")).toBe("js");
    expect(container.textContent).toContain("const x = 1;");
  });

  it("renders incomplete (mid-stream) markdown without throwing", () => {
    // Unterminated bold + a half-written fence — what the SSE token stream looks
    // like before the closing tokens arrive. Must render the text, not crash.
    expect(() =>
      render(<Markdown text={"**partially bold and ```js\nconst y ="} />),
    ).not.toThrow();
  });

  it("renders an empty string as an empty (non-throwing) container", () => {
    const { container } = render(<Markdown text="" />);
    expect(container.querySelector(".agent-md")).not.toBeNull();
    expect(container.textContent).toBe("");
  });
});
