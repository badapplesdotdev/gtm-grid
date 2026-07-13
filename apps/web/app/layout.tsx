import type { Metadata } from "next";
import { DM_Sans, JetBrains_Mono, Newsreader } from "next/font/google";
import "./globals.css";

// DM Sans is the UI sans (300–700; wordmark is 700, -0.02em tracking).
const dmSans = DM_Sans({
  subsets: ["latin"],
  weight: ["300", "400", "500", "600", "700"],
  variable: "--font-dm-sans",
  display: "swap",
});

// Berkeley Mono is the licensed product mono; JetBrains Mono stands in as the
// shipped fallback (same fixed-width rhythm). Used for anything data-shaped.
const jetbrainsMono = JetBrains_Mono({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-jetbrains-mono",
  display: "swap",
});

// Newsreader is the editorial display serif used by the marketing homepage
// (the headless-engine redesign). Self-hosted via next/font so it satisfies the
// app CSP (no Google-Fonts @import). Exposed as --font-newsreader.
const newsreader = Newsreader({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  variable: "--font-newsreader",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Grid — the headless GTM engine",
  description:
    "Grid is the headless GTM engine that runs your go-to-market programmatically. Enrich, score, route, and sync every record from Claude Code, MCP, the CLI, or a REST call — with a live grid so you always see what's running.",
  applicationName: "Grid",
  metadataBase: new URL("https://gtmgrid.com"),
  icons: {
    icon: "/icon.png",
    shortcut: "/favicon.ico",
    apple: "/apple-icon.png",
  },
  openGraph: {
    title: "Grid — the headless GTM engine",
    description:
      "The headless GTM engine — programmable, source-available, every column a function. Drive it from Claude Code, MCP, the CLI, or a REST call.",
    siteName: "Grid",
    type: "website",
    images: [
      { url: "/brand/og-cover.jpg", width: 1849, height: 618, alt: "Grid" },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "Grid — the headless GTM engine",
    description:
      "The headless GTM engine — programmable, source-available, every column a function. Drive it from Claude Code, MCP, the CLI, or a REST call.",
    images: ["/brand/og-cover.jpg"],
  },
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className={`${dmSans.variable} ${jetbrainsMono.variable} ${newsreader.variable}`}>
      <body>{children}</body>
    </html>
  );
}
