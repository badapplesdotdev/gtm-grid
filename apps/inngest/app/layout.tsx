import type { ReactNode } from "react";

/**
 * Minimal root layout. This app is a headless worker (webhook receiver +
 * Inngest serve endpoint); it renders no real UI, but the App Router requires a
 * root layout to build.
 */
export const metadata = {
  title: "GTM Grid Webhooks",
  description: "Webhook receiver and durable enrichment worker.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
