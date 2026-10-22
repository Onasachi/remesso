/// The Remesso mark and wordmark.
///
/// The mark is the final `o` of the wordmark: a ring with a gap, and a marigold
/// dot sitting in that gap on the ring's own circle. The ring is the schedule
/// the sender signs once; the dot is the money on its way round to the next
/// date. That is the whole identity, so both are drawn from one place here
/// rather than pasted as markup — and `scripts/build-brand-assets.mjs` draws
/// the app icons from the same geometry, so a change reaches both.

/// Every lap is one transfer: the ring turns 360° and eases to a stop, then
/// the dot pops. `loop` is for waiting, `once` for something that just
/// happened. Never loop it behind text somebody is reading.
type Motion = "none" | "loop" | "once";

const RING_D = "M84.57 44.53A35 35 0 1 1 55.47 15.43";

export function Mark({
  className = "",
  motion = "none",
  mono = false,
  title,
}: {
  className?: string;
  motion?: Motion;
  /// One-colour: the dot takes the ring's colour too. For embossing, faxes and
  /// anywhere the marigold cannot survive — not a style choice.
  mono?: boolean;
  title?: string;
}) {
  const spin =
    motion === "none" ? "" : motion === "loop" ? "animate-orbit" : "animate-orbit-once";
  const pop = motion === "none" ? "" : motion === "loop" ? "animate-pop" : "animate-pop-once";

  return (
    <svg
      viewBox="0 0 100 100"
      className={`overflow-visible ${className}`}
      role={title ? "img" : "presentation"}
      aria-label={title}
      aria-hidden={title ? undefined : true}
    >
      {/* transform-box/origin put the pivot at the ring's centre in viewBox
          units; without it the browser spins about the element's border box. */}
      <g className={spin} style={{ transformOrigin: "50px 50px", transformBox: "view-box" }}>
        <path d={RING_D} fill="none" stroke="currentColor" strokeWidth={22} />
        <circle
          cx={74.75}
          cy={25.25}
          r={14}
          className={`${mono ? "fill-current" : "fill-marigold"} ${pop}`}
          style={{ transformOrigin: "74.75px 25.25px", transformBox: "view-box" }}
        />
      </g>
    </svg>
  );
}

/// The wordmark: `remess` set in Fraunces with Soft and Wonk fully on, then the
/// mark standing in for the last letter.
///
/// Lowercase on purpose — it reads as a person rather than a bank. The visible
/// text is only six letters, so the accessible name is set on the wrapper and
/// the mark is decorative; otherwise a screen reader announces "remess".
///
/// The ring never matches the letters. It carries the accent on a light ground
/// and lifts to `clay-light` on ink, because the accent itself loses its shape
/// against #0f2125. The dot stays marigold on every ground — that is the one
/// rule the brand states outright.
const TONES = {
  paper: { text: "text-ink", ring: "text-clay" },
  ink: { text: "text-paper", ring: "text-clay-light" },
  teal: { text: "text-surface", ring: "text-surface" },
} as const;

export function Wordmark({
  className = "",
  tone = "paper",
}: {
  className?: string;
  tone?: keyof typeof TONES;
}) {
  const { text, ring } = TONES[tone];
  return (
    <span
      aria-label="Remesso"
      role="img"
      className={`font-wordmark inline-flex select-none items-baseline leading-none ${text} ${className}`}
    >
      remess
      <Mark className={`relative top-[0.035em] ml-[0.03em] h-[0.5em] w-[0.5em] ${ring}`} />
    </span>
  );
}
