import type { Config } from "tailwindcss";

/// Every colour is a CSS variable holding OKLCH channels (see globals.css), so
/// `bg-ink/60` still works via <alpha-value> and the palette can be tuned in
/// one place. Names describe the role, not the hue — "clay" is the accent
/// whatever shade it ends up as.
const c = (name: string) => `oklch(var(--${name}) / <alpha-value>)`;

export default {
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        paper: c("paper"),
        surface: c("surface"),
        sand: c("sand"),
        line: c("line"),
        ink: c("ink"),
        "ink-2": c("ink-2"),
        "ink-3": c("ink-3"),
        clay: c("clay"),
        "clay-deep": c("clay-deep"),
        "clay-soft": c("clay-soft"),
        "clay-light": c("clay-light"),
        marigold: c("marigold"),
        naira: c("naira"),
        "naira-soft": c("naira-soft"),
        amber: c("amber"),
        "amber-soft": c("amber-soft"),
        danger: c("danger"),
        "danger-soft": c("danger-soft"),
      },
      fontFamily: {
        sans: ["var(--font-sans)", "system-ui", "sans-serif"],
        display: ["var(--font-display)", "Georgia", "serif"],
      },
      borderRadius: {
        "2xl": "1.25rem",
        "3xl": "1.75rem",
      },
      boxShadow: {
        // Warm, low, diffuse — a card resting on paper, not floating over it.
        card: "0 1px 2px oklch(0.3 0.03 50 / 0.06), 0 8px 24px -12px oklch(0.3 0.03 50 / 0.18)",
        lift: "0 2px 4px oklch(0.3 0.03 50 / 0.08), 0 16px 40px -16px oklch(0.3 0.03 50 / 0.28)",
        bar: "0 -8px 24px -12px oklch(0.3 0.03 50 / 0.18)",
      },
      transitionTimingFunction: {
        out: "cubic-bezier(0.22, 1, 0.36, 1)",
      },
      keyframes: {
        rise: {
          from: { opacity: "0", transform: "translateY(8px)" },
          to: { opacity: "1", transform: "translateY(0)" },
        },
        "slide-up": {
          from: { transform: "translateY(100%)" },
          to: { transform: "translateY(0)" },
        },
        fade: { from: { opacity: "0" }, to: { opacity: "1" } },
        shimmer: {
          from: { backgroundPosition: "200% 0" },
          to: { backgroundPosition: "-200% 0" },
        },
        pulse2: {
          "0%, 100%": { opacity: "1" },
          "50%": { opacity: "0.35" },
        },
        // The mark's lap: one turn per transfer. The ring reaches 360° at 62%
        // and rests for the remainder, which is the beat the dot pops into.
        orbit: {
          "0%": { transform: "rotate(0deg)" },
          "62%, 100%": { transform: "rotate(360deg)" },
        },
        pop: {
          "0%, 58%": { transform: "scale(1)" },
          "66%": { transform: "scale(1.35)" },
          "76%, 100%": { transform: "scale(1)" },
        },
      },
      animation: {
        rise: "rise 0.5s cubic-bezier(0.22, 1, 0.36, 1) both",
        "slide-up": "slide-up 0.4s cubic-bezier(0.22, 1, 0.36, 1) both",
        fade: "fade 0.25s ease-out both",
        shimmer: "shimmer 1.6s linear infinite",
        pulse2: "pulse2 1.8s ease-in-out infinite",
        // 2.4s is the brand's timing. `-once` is the same lap run a single
        // time, for something that just happened rather than something being
        // waited on.
        orbit: "orbit 2.4s cubic-bezier(.65,0,.35,1) infinite",
        "orbit-once": "orbit 2.4s cubic-bezier(.65,0,.35,1) both",
        pop: "pop 2.4s ease-out infinite",
        "pop-once": "pop 2.4s ease-out both",
      },
    },
  },
  plugins: [],
} satisfies Config;
