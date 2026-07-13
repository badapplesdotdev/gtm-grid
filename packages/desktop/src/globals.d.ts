/** Build-time constant injected by Vite `define` — the shipped app version. */
declare const __APP_VERSION__: string;

/** Vite `?raw` imports — bundle a file's text content (e.g. CHANGELOG.md). */
declare module "*?raw" {
  const content: string;
  export default content;
}
