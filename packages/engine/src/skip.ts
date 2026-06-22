// A connector method can SKIP a cell cleanly instead of erroring — when the
// inputs it was given guarantee a failed call (e.g. a required company
// identifier is missing, so the upstream API would answer 4xx). Throwing a
// {@link SkipCellError} from a method's `run` tells the engine to write the cell
// as "empty" with the skip note (like a run-condition gate) rather than as an
// "error": no credits spent, no error-tracking noise, and the grid explains the
// blank instead of showing a failed cell.
//
// The error instance survives the QuickJS sandbox boundary: `runFunction`
// re-throws the ORIGINAL host error object (sandbox.ts), so `instanceof` holds
// when the engine catches it. The `isCellSkip` brand is a belt-and-braces check
// for the (theoretical) case of two engine module copies.

/** Thrown by a connector method to skip the current cell without erroring. */
export class SkipCellError extends Error {
  /** Brand so the skip survives even a duplicated module identity. */
  readonly isCellSkip = true;
  constructor(message: string) {
    super(message);
    this.name = "SkipCellError";
  }
}

/** True when `e` is a {@link SkipCellError} (or a brand-compatible skip). */
export function isSkipCellError(e: unknown): e is SkipCellError {
  return (
    e instanceof Error &&
    (e as { isCellSkip?: unknown }).isCellSkip === true
  );
}
