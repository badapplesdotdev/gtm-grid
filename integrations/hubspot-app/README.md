# GTM Grid — HubSpot public app (developer projects)

The HubSpot app definition for GTM Grid's CRM sync, built on HubSpot's
**developer projects** platform (platformVersion 2025.2) — apps are defined in
config files and created/deployed with the HubSpot CLI, not the legacy
developer-account UI.

The app is OAuth-only and strictly **read-only**: the scopes cover contacts,
companies, lists, and owners; there are no write scopes and no server-side
components (the OAuth handshake + syncing live in `apps/web` / Inngest).

## One-time setup (creates the app)

```bash
npm i -g @hubspot/cli        # or: npx @hubspot/cli@latest …
cd integrations/hubspot-app
hs init                      # authenticate; pick your DEVELOPER account
hs project upload            # creates the project + the app on first upload
```

After the upload, open the developer account → the `gtm-grid` project → the
app's **Auth** tab for the **Client ID** and **Client secret**, then set them
in Vercel (production) on `gtm-grid-web`:

- `HUBSPOT_CLIENT_ID`
- `HUBSPOT_CLIENT_SECRET`

and redeploy. State signing reuses `BETTER_AUTH_SECRET` (already set).

## Changing scopes / redirect URLs

Edit `src/app/app-hsmeta.json` and run `hs project upload` again. Keep
`requiredScopes` in lockstep with `HUBSPOT_SCOPES` in
`packages/services/src/services/hubspot-auth.ts` — HubSpot rejects an
authorize URL whose `scope` param doesn't cover the app's required scopes.

## Installing into a portal (before marketplace listing)

Unlisted apps install into any portal through the normal OAuth flow — no
review needed. Marketplace listing (`distribution: "marketplace"`) is a
separate submission later.
