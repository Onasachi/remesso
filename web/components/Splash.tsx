"use client";

import { useEffect, useState } from "react";
import { Mark } from "./Mark";

/// The boot screen: one lap of the mark over paper, until the app is ready.
///
/// It is rendered on the server, so it is in the first HTML the webview paints
/// — that is the point. Without it MiniPay shows a white rectangle for however
/// long the bundle takes on a mid-range Android, and a white flash reads as a
/// broken page rather than a loading one.
///
/// Three things it must never do, in order of how much they would cost:
///
///   1. **Get stuck.** `useEffect` runs once React has hydrated, which is the
///      moment the first screen can draw. If React never gets that far the
///      CSS backstop in globals.css hides it anyway, and with scripting off
///      the `<noscript>` rule means it is never shown at all.
///   2. **Come back.** It lives in the layout and latches `gone`, so a move
///      between screens never replays it. Only a full page load does.
///   3. **Outstay.** `FLOOR` is the whole of its life: not a minimum to sit
///      through, just long enough that a warm load does not flicker.
///
/// The mark alone, never the wordmark — at this size the brand says the
/// lockup is below its minimum width and the mark stands on its own.
const FLOOR = 450;
const FADE = 320;

export function Splash() {
  const [state, setState] = useState<"in" | "out" | "gone">("in");

  useEffect(() => {
    const out = setTimeout(() => setState("out"), FLOOR);
    const gone = setTimeout(() => setState("gone"), FLOOR + FADE);
    return () => {
      clearTimeout(out);
      clearTimeout(gone);
    };
  }, []);

  if (state === "gone") return null;

  return (
    <div
      className={`splash ${state === "out" ? "splash-out" : ""}`}
      // Decorative: the screen behind it announces itself once it arrives, and
      // a live region here would make a screen reader wait for a logo.
      aria-hidden
    >
      <Mark className="h-16 w-16 text-clay" motion="loop" />
    </div>
  );
}
