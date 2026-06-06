/**
 * Convex Auth provider config (T3).
 *
 * Declares this deployment as a trusted JWT issuer for Convex Auth. The
 * `CONVEX_SITE_URL` env var is set automatically on every Convex deployment;
 * `applicationID: "convex"` is the fixed audience Convex Auth uses. This is the
 * standard manual-setup config from the Convex Auth docs.
 */
export default {
  providers: [
    {
      domain: process.env.CONVEX_SITE_URL,
      applicationID: "convex",
    },
  ],
};
