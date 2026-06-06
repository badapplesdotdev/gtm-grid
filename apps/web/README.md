# @gtmgrid/web

The **gtm grid** marketing site — a small Next.js (App Router) app for the
local-first, programmable GTM spreadsheet where _every column is a function_.

## Stack

- Next.js 15 (App Router) + React 19
- Plain CSS (no Tailwind). Design tokens live in `app/globals.css`, copied from
  the canonical GTM Grid design system (`tokens/{colors,semantic,typography,
  spacing,effects}.css`) — they mirror `packages/desktop/src/styles.css`.
- Fonts via `next/font/google`: **DM Sans** (UI) + **JetBrains Mono** (the
  shipped stand-in for the licensed Berkeley Mono).

## Develop

```bash
pnpm --filter @gtmgrid/web dev      # next dev   (http://localhost:3000)
pnpm --filter @gtmgrid/web build    # next build
pnpm --filter @gtmgrid/web start    # serve the production build
```

## Scope & isolation

- Imports **no** workspace libraries, so no `transpilePackages` is needed.
- Has its **own** `tsconfig.json` and is typechecked with `next` / `tsc --noEmit`;
  it stays out of the root `tsc -b` project graph and the root Vitest run.
- Bootstrap only — no sign-in or in-app flows live here.

## Brand

Lowercase `gtm grid` wordmark (DM Sans 700, `-0.02em`), a single hot red accent
(`#e60006`) used sparingly, near-white surfaces, hairline borders, and mono for
anything data-shaped. No emoji; icons are line-drawn SVG.
