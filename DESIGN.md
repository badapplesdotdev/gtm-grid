---
version: alpha
name: "GTM Grid"
colors:
  primary: "#22C55E"
  dark: "#1F2937"
  white: "#FFFFFF"
  color-800: "#0B411F"
  color-700: "#136D34"
  color-600: "#1A9849"
  color-500: "#22C55E"
  color-400: "#3BDD77"
  color-300: "#67E595"
  color-200: "#92ECB3"
  color-100: "#BEF4D2"
components:
  button-primary:
    backgroundColor: "{colors.color-700}"
    textColor: "{colors.white}"
  button-primary-hover:
    backgroundColor: "{colors.color-800}"
    textColor: "{colors.white}"
  button-secondary:
    backgroundColor: "{colors.white}"
    textColor: "{colors.color-700}"
  button-secondary-hover:
    backgroundColor: "{colors.white}"
    textColor: "{colors.color-800}"
---

## Overview

Brand kit and design tokens for **GTM Grid**. This file follows the [design.md](https://github.com/google-labs-code/design.md) format introduced by Google in 2025. Drop it into your project root alongside the asset files in this ZIP so AI coding agents (Claude Code, Cursor, Cowork, etc.) can generate UI that matches the **GTM Grid** brand.

Designed by [Anymark](https://anymark.co) on 2026-06-07.

## Brand Kit Files

These files ship alongside this `DESIGN.md` in the ZIP. Pick the right asset for the context instead of regenerating logos.

### Master logo

| File | What it is | When to use |
| --- | --- | --- |
| `gtm_grid_logo.svg` | Primary logo, vector, transparent | Default. Any target that supports SVG (web, Figma, modern docs). |
| `gtm_grid_logo.png` | Primary logo, raster, transparent | Raster contexts on light / white backgrounds. |
| `gtm_grid_logo_white.png` | White logo, raster, transparent | Dark backgrounds, photos, or any low-contrast surface. |

### Icon only

| File | What it is | When to use |
| --- | --- | --- |
| `gtm_grid_icon_color.png` | Icon in brand color, transparent | Square slots, inline marks, app tiles. |
| `gtm_grid_icon_white.png` | Icon in white, transparent | Dark or photo backgrounds, mark only. |

### Platform-ready

| File | What it is | When to use |
| --- | --- | --- |
| `gtm_grid_favicon.ico` | ICO favicon | Drop into website root as `/favicon.ico`. |
| `gtm_grid_social_icon.png` | Icon on white background | Profile picture when a light avatar reads best. |
| `gtm_grid_inverse_avatar.png` | Icon on brand-color background | Profile picture when a colored avatar reads best. |

### Social covers

- `social-covers/social-cover1.jpg`, `social-covers/social-cover2.jpg` — general-purpose banners.
- `social-covers/red/social-cover-red1.jpg` through `social-cover-red4.jpg` — banners tuned to the **red** color family.
- `social-covers/blue/social-cover-blue1.jpg` through `social-cover-blue4.jpg` — banners tuned to the **blue** color family.
- `social-covers/orange/social-cover-orange1.jpg` through `social-cover-orange4.jpg` — banners tuned to the **orange** color family.
- `social-covers/green/social-cover-green1.jpg` through `social-cover-green4.jpg` — banners tuned to the **green** color family.
- `social-covers/pink/social-cover-pink1.jpg` through `social-cover-pink4.jpg` — banners tuned to the **pink** color family.
- `social-covers/purple/social-cover-purple1.jpg` through `social-cover-purple4.jpg` — banners tuned to the **purple** color family.
- `social-covers/dark/social-cover-dark1.jpg` through `social-cover-dark4.jpg` — banners tuned to the **dark** color family.

## Colors

### Primary tokens

- **primary** (`#22C55E`) — Primary brand color. CTAs, active states, highlights, key brand moments.
- **dark** (`#1F2937`) — Body text, borders, elements that need maximum readability.
- **white** (`#FFFFFF`) — Backgrounds, negative space, clean minimal layouts.

### Extended palette (generated shades)

- **color-800** (`#0B411F`) — Darkest shade. Emphatic text on light.
- **color-700** (`#136D34`) — Active / pressed states, emphasis.
- **color-600** (`#1A9849`) — Hover state for primary CTAs.
- **color-500** (`#22C55E`) — Mid tone. Generic accents and fills. _(matches `primary` — the brand color)_
- **color-400** (`#3BDD77`) — Secondary accents.
- **color-300** (`#67E595`) — Disabled states, muted accents.
- **color-200** (`#92ECB3`) — Hover on light surfaces, dividers.
- **color-100** (`#BEF4D2`) — Lightest tint. Page backgrounds, subtle surfaces.

### Status badges

Any pairing of two colors from {primary, `color-100`–`color-700`, `#1F2937`, `#FFFFFF`} that reaches a 6:1 contrast ratio works as a badge. Typical pairs:

- Dark pill: background `#1F2937` or `color-800`, text `#FFFFFF` or a light palette tint.
- Tinted pill: background `color-100` / `color-200`, text `color-700` / `color-800`.
- Brand pill: background `primary` (`#22C55E`), text `#FFFFFF`. Only if the pair passes 6:1.

### Contrast note

Check WCAG AA contrast (4.5:1) before you ship. Anymark does not certify specific combinations.

## Components

Buttons are defined as tokens in the frontmatter above (`button-primary`, `button-primary-hover`, `button-secondary`, `button-secondary-hover`). Only `backgroundColor` and `textColor` are specified. Padding, radius, and typography are intentionally left to the consumer's design system.

We pick shades that hit WCAG AA contrast (4.5:1) against their paired text or background color. Verify before use. If the raw `primary` color does not pass 4.5:1 against white, the tokens reference a darker palette shade (`color-600`, `color-700`, or `color-800`) instead.

## Do's and Don'ts

### Do

- Use `gtm_grid_logo.svg` whenever the target supports vector. Fall back to PNG if any issues with SVG are found or if the customer requests it.
- Use `gtm_grid_logo_white.png` on dark or photo backgrounds.
- Keep clear space around the logo equal to at least the height of the icon.
- Reserve the `primary` color for primary CTAs, active states, and brand moments. Primary tokens (`primary`, `dark`, `white`) should cover ~80% of surfaces.
- Verify contrast when combining any two tokens from the extended palette.

### Don't

- Don't rotate the logo.
- Don't stretch, squash, or distort the proportions.
- Don't add gradients, shadows, outlines, or strokes to the logo.
- Don't recolor the logo outside this palette.
- Don't place the logo on low-contrast or visually cluttered backgrounds.
- Don't swap horizontal for vertical layout, or remove the icon.
- Don't use the primary color decoratively. Treat it as a functional accent.
