/**
 * Self-host detection.
 *
 * A self-hosted instance runs against the operator's OWN Postgres + backend with
 * no billing backend (Autumn absent → the fake port → no paid plan is ever set,
 * and the cloud-actions limit stays null). The paid cloud-access + cloud-actions
 * quota gates only make sense on the HOSTED product, so when `GTMGRID_SELF_HOST=1`
 * they are bypassed — a self-hoster's workspaces must never lock out or hit a
 * usage cap.
 *
 * Read at call time (not module load) so tests and the same binary can toggle it.
 * The hosted product leaves it unset; see SELF-HOST.md.
 */
export const isSelfHost = (): boolean => process.env.GTMGRID_SELF_HOST === "1";
