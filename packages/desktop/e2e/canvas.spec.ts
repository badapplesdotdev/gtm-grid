// Pipeline canvas end-to-end tests — the automation-layer journey against the
// stateful mock cloud: browse the pipeline library, create a pipeline, see its
// starter graph render on the canvas editor, and deploy it to an immutable
// version (asserted through to persisted mock state).

import { test, expect, mockState } from "./fixtures";
import type { Page } from "@playwright/test";

/** Browse → create a pipeline → land in the editor with its canvas rendered. */
async function createPipeline(window: Page) {
  // The app boots into the grid; the sidebar carries the Pipelines section.
  await expect(window.locator(".grid-table")).toBeVisible({ timeout: 20_000 });

  await window.locator(".pipeline-sidebar-section").getByRole("button", { name: "Browse all" }).click();

  // The library (PipelinesHub) is up.
  await expect(window.locator(".pipelines-hub")).toBeVisible();

  // Create from the hub header (scoped so we don't hit the sidebar's own button).
  await window.locator(".pipelines-hub-head").getByRole("button", { name: /new pipeline/i }).click();

  // The editor opens on the new pipeline's canvas.
  await expect(window.locator(".pipeline-editor-shell")).toBeVisible({ timeout: 20_000 });
}

test.describe("Pipeline canvas", () => {
  test("browse → create → the starter graph renders on the canvas", async ({ launchApp }) => {
    const { window } = await launchApp({ signedIn: true, paid: true });
    const before = (await mockState()).pipelines.length;

    await createPipeline(window);

    // The starter graph's nodes are drawn on the canvas (the name lives in the
    // node shell's title, a sibling of the draggable .pipeline-node button).
    await expect(window.locator(".pipeline-node-shell", { hasText: "Record" })).toBeVisible();
    await expect(window.locator(".pipeline-node-shell", { hasText: "Label" })).toBeVisible();
    // …connected by an edge in the SVG edge layer.
    await expect(window.locator(".pipeline-edge-layer path").first()).toBeAttached();

    // The pipeline was persisted server-side with a draft version.
    await expect.poll(async () => (await mockState()).pipelines.length).toBe(before + 1);
    const created = (await mockState()).pipelines.at(-1);
    expect(created.draft).not.toBeNull();
    expect(created.deployed).toBeNull();
  });

  test("deploy promotes the draft to an immutable deployed version", async ({ launchApp }) => {
    const { window } = await launchApp({ signedIn: true, paid: true });
    await createPipeline(window);

    // A draft offers "Deploy version".
    const deploy = window.getByRole("button", { name: /deploy version/i });
    await expect(deploy).toBeVisible();
    await deploy.click();

    // The editor flips to the deployed state (the draft badge becomes v1).
    await expect(window.locator(".pipeline-title-lockup")).toContainText(/Deployed v1/i);
    // …and the deploy affordance is gone (no draft to deploy).
    await expect(deploy).toHaveCount(0);

    // Persisted: a deployed version exists and the draft was cleared.
    await expect.poll(async () => (await mockState()).pipelines.at(-1)?.deployed?.version).toBe(1);
    expect((await mockState()).pipelines.at(-1)?.draft).toBeNull();
  });
});
