/**
 * Branded-id shim for the desktop UI.
 *
 * The Convex backend used to export a branded `Id<"table">` type from
 * `convex/_generated/dataModel`. After the cutover to the tRPC/Postgres tier
 * every cloud id is a plain string (Postgres UUID), so this module provides a
 * drop-in `Id<T>` alias that keeps the UI's existing `Id<"workspaces">`-style
 * annotations compiling while erasing the brand. The phantom `T` parameter is
 * retained purely so call sites stay self-documenting; it has no runtime or
 * structural effect (every `Id<…>` is just `string`).
 */

// eslint-disable-next-line @typescript-eslint/no-unused-vars -- phantom doc-only param.
export type Id<T extends string = string> = string;
