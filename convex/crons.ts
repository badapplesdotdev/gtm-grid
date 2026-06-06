/**
 * Convex cron schedule (C26).
 *
 * Periodically batch-flushes the CLOUD-actions meter: billable CLOUD mutations
 * increment a cheap per-workspace pending counter
 * (`workspaces.cloudActionsPending`) because mutations CANNOT make outbound
 * HTTP; this cron drives the internal ACTION (convex/usage.ts
 * `flushCloudActions`) that tracks those pending counts to Autumn and snapshots
 * each workspace's live usage for the `me` query.
 *
 * A 1-minute cadence keeps surfaced usage near-realtime while batching many
 * cloud ops into one Autumn `track` per workspace (instead of one HTTP per op,
 * which mutations cannot do anyway). The action is a no-op when nothing is
 * pending — and a LOCAL-only workspace never has anything pending, since local
 * operations never reach a Convex mutation (local is unlimited and unmetered).
 */

import { cronJobs } from "convex/server";
import { internal } from "./_generated/api.js";

const crons = cronJobs();

crons.interval(
  "flush cloud-actions meter to Autumn",
  { minutes: 1 },
  internal.usage.flushCloudActions,
  {},
);

export default crons;
