// Route-level Suspense fallback for the whole app — Next.js renders this during
// navigation and while server components stream. Uses the canonical branded
// full-page loader so every full-page load looks the same.
import { AppLoader } from "./AppLoader";

export default function Loading() {
  return <AppLoader />;
}
