/**
 * The shared presence store for the cloud multiplayer grid.
 *
 * Exactly one cloud table is open at a time, so a single module-level store
 * (mirroring `activeWorkspaceStore` in `auth.ts`) is the right scope: the
 * realtime hook (`useCloudGrid`) feeds the inbound roster in via {@link setRoster}
 * and registers its `updatePresence` publisher via {@link setPublisher}; the
 * `CloudGrid` UI reads the roster with {@link useGridPresenceRoster} and pushes
 * the local user's cursor/identity out with {@link updateLocal}.
 *
 * Publish discipline: nothing is sent until BOTH an identity (`userId`) and a
 * publisher are present. Cursor moves are trailing-throttled (a dragged
 * selection mustn't flood the socket); identity and editing changes flush
 * immediately so "X is editing" feels instant.
 */

import { useSyncExternalStore } from "react";
import type { GridPresenceState } from "@gtmgrid/services/realtime";

/** How long to coalesce a burst of cursor moves before publishing (ms). */
const CURSOR_THROTTLE_MS = 120;

/** Publishes the local presence state up to the party (the hook's `updatePresence`). */
type PresencePublisher = (state: GridPresenceState) => void;

/**
 * A trailing throttle: `schedule()` guarantees `fn` runs once within `ms` of the
 * first call in a burst, coalescing everything in between. `flush()` runs a
 * pending call immediately; `cancel()` drops it. Pure + exported for testing.
 */
export const createTrailingThrottle = (
  ms: number,
  fn: () => void,
): { schedule: () => void; flush: () => void; cancel: () => void } => {
  let handle: ReturnType<typeof setTimeout> | null = null;
  const fire = () => {
    handle = null;
    fn();
  };
  return {
    schedule: () => {
      if (handle !== null) return;
      handle = setTimeout(fire, ms);
    },
    flush: () => {
      if (handle === null) return;
      clearTimeout(handle);
      fire();
    },
    cancel: () => {
      if (handle === null) return;
      clearTimeout(handle);
      handle = null;
    },
  };
};

const createPresenceStore = () => {
  const listeners = new Set<() => void>();
  let roster: readonly GridPresenceState[] = [];
  let publisher: PresencePublisher | null = null;
  // The local user's state, assembled incrementally from identity + cursor edits.
  let local: GridPresenceState | null = null;

  const emit = () => {
    for (const listener of listeners) listener();
  };

  /** Send `local` up to the party, if we have both identity and a publisher. */
  const publish = () => {
    if (publisher === null || local === null) return;
    publisher(local);
  };

  const cursorThrottle = createTrailingThrottle(CURSOR_THROTTLE_MS, publish);

  return {
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getSnapshot(): readonly GridPresenceState[] {
      return roster;
    },
    /** Inbound: the party broadcast a new roster. */
    setRoster(states: readonly GridPresenceState[]): void {
      roster = states;
      emit();
    },
    /**
     * Register (or clear) the publisher. Registering immediately flushes any
     * local state we already have so a late-connecting socket still announces us.
     */
    setPublisher(publish: PresencePublisher | null): void {
      publisher = publish;
      if (publisher !== null) {
        cursorThrottle.flush();
        // publish current local state right away on (re)connect.
        if (local !== null) publisher(local);
      }
    },
    /**
     * Merge a patch into the local state and publish. Cursor-only changes are
     * trailing-throttled; identity (`userId`/`name`/`image`) and `editing`
     * changes flush immediately.
     */
    updateLocal(patch: Partial<GridPresenceState>): void {
      const userId = patch.userId ?? local?.userId;
      if (userId === undefined) return; // no identity yet — nothing to publish
      local = { ...local, ...patch, userId };
      const immediate =
        "userId" in patch ||
        "name" in patch ||
        "image" in patch ||
        "editing" in patch;
      if (immediate) {
        cursorThrottle.flush();
        publish();
      } else {
        cursorThrottle.schedule();
      }
    },
    /** Teardown: drop the publisher, pending publish, roster, and local state. */
    clear(): void {
      cursorThrottle.cancel();
      publisher = null;
      local = null;
      roster = [];
      emit();
    },
  };
};

/** The single shared presence store (one cloud table open at a time). */
export const gridPresenceStore = createPresenceStore();

/** React binding: subscribe to the live presence roster. */
export const useGridPresenceRoster = (): readonly GridPresenceState[] =>
  useSyncExternalStore(
    gridPresenceStore.subscribe,
    gridPresenceStore.getSnapshot,
    gridPresenceStore.getSnapshot,
  );
