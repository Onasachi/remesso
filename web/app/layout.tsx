import type { Metadata, Viewport } from "next";
import { DM_Sans, Fraunces } from "next/font/google";
import "./globals.css";
import { Providers } from "./providers";
import Link from "next/link";
import { AppHeader } from "@/components/AppHeader";
import { Splash } from "@/components/Splash";

/// Both fonts are self-hosted by next/font at build time: nothing is fetched
/// from Google at runtime, so they add no origin to the network manifest
/// MiniPay reviews. Fraunces carries the warmth — headings and hero amounts
/// only. DM Sans does everything else.
const display = Fraunces({
  subsets: ["latin"],
  axes: ["opsz", "SOFT", "WONK"],
  variable: "--font-display",
  display: "swap",
});

const sans = DM_Sans({
  subsets: ["latin"],
  axes: ["opsz"],
  variable: "--font-sans",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Remesso",
  description: "Send money home on a schedule. Set it once, it runs on its own.",
};

/// MiniPay is a mobile in-wallet browser, so the mobile viewport is the primary
/// target rather than a narrowed-down desktop one. `viewportFit: cover` lets
/// the bottom action bar sit under the home indicator instead of above it.
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  viewportFit: "cover",
  // Brand paper. The browser chrome and the page ground are the same material;
  // a few points off reads as a seam at the top of the screen.
  themeColor: "#f3f8f8",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${sans.variable} ${display.variable}`}>
      <body>
        {/* With scripting off nothing would ever take the splash down, so it
            is never put up. The app needs JS regardless; this just fails to
            the page rather than to a teal ring on an empty screen. */}
        <noscript>
          <style>{`.splash{display:none}`}</style>
        </noscript>
        <Splash />
        <Providers>
          <div className="mx-auto flex min-h-[100dvh] w-full max-w-lg flex-col">
            <AppHeader />
            <main className="flex-1 px-4 pb-10">{children}</main>
            <footer className="flex justify-center gap-4 px-4 pb-6 text-[12px] text-ink-3">
              <Link href="/terms">Terms</Link>
              <Link href="/privacy">Privacy</Link>
            </footer>
          </div>
        </Providers>
      </body>
    </html>
  );
}
