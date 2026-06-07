import type { Metadata } from "next";
import { DM_Sans, JetBrains_Mono } from "next/font/google";
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

export const metadata: Metadata = {
  title: "GTM Grid — every column is a function",
  description:
    "A local-first, programmable spreadsheet for go-to-market teams. Every column is a function — a manual value, an AI prompt, or a connector call. Bring your own AI key; execution stays on your machine.",
  applicationName: "GTM Grid",
  metadataBase: new URL("https://gtmgrid.com"),
  icons: {
    icon: "/icon.png",
    shortcut: "/favicon.ico",
    apple: "/apple-icon.png",
  },
  openGraph: {
    title: "GTM Grid — every column is a function",
    description:
      "A local-first, programmable spreadsheet for go-to-market teams. Bring your own key; execution stays local.",
    siteName: "GTM Grid",
    type: "website",
    images: [
      { url: "/brand/og-cover.jpg", width: 1849, height: 618, alt: "GTM Grid" },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "GTM Grid — every column is a function",
    description:
      "A local-first, programmable spreadsheet for go-to-market teams. Bring your own key; execution stays local.",
    images: ["/brand/og-cover.jpg"],
  },
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className={`${dmSans.variable} ${jetbrainsMono.variable}`}>
      <body>{children}</body>
    </html>
  );
}
