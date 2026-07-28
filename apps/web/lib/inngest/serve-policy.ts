/**
 * Preview branches share no trusted worker boundary with production. Returning
 * 404 from their serve endpoint prevents a preview deployment carrying a copied
 * signing key from replacing the production app URL in Inngest.
 *
 * Custom environments (notably `staging`) stay enabled.
 */
export function shouldServeInngest(
  vercelTargetEnv: string | undefined,
  vercelEnv?: string,
): boolean {
  const targetEnv = vercelTargetEnv || vercelEnv;
  return targetEnv !== "preview";
}
