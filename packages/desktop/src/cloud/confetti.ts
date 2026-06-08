/**
 * Celebratory confetti burst (canvas-confetti). Best-effort + self-contained: a
 * failure (e.g. no canvas in a test/SSR context) is swallowed so it can never
 * break the flow that triggered it. Used when a user joins a workspace.
 */
import confetti from "canvas-confetti";

export function fireConfetti(): void {
  try {
    const fire = (ratio: number, opts: confetti.Options) => {
      void confetti({
        origin: { y: 0.7 },
        particleCount: Math.floor(200 * ratio),
        ...opts,
      });
    };
    fire(0.25, { spread: 26, startVelocity: 55 });
    fire(0.2, { spread: 60 });
    fire(0.35, { spread: 100, decay: 0.91, scalar: 0.8 });
    fire(0.1, { spread: 120, startVelocity: 25, decay: 0.92, scalar: 1.2 });
    fire(0.1, { spread: 120, startVelocity: 45 });
  } catch {
    /* confetti is purely cosmetic — never let it throw into the caller */
  }
}
