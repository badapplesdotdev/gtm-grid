/**
 * Route-scoped React Query provider.
 *
 * SCOPED TO THIS ROUTE, not hoisted to the root layout, because `apps/web` is
 * otherwise a static marketing site plus API handlers — this is its only
 * client-side data-fetching page. A provider in the root layout would force
 * every marketing route to ship and mount the query client for nothing.
 *
 * The client is created inside `useState` rather than at module scope: a
 * module-level client is shared across every request the server process
 * handles, which leaks one user's cached picker config (including an access
 * token) into the next user's render.
 */

"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";

export default function GooglePickerLayout({ children }: { children: React.ReactNode }) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            // The picker config carries a short-lived access token and is
            // fetched once per visit — refetching it on window focus would
            // silently swap the token mid-picker.
            refetchOnWindowFocus: false,
            staleTime: Infinity,
          },
        },
      }),
  );

  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}
