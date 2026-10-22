# Remesso design system

A portable breakdown of the web app's look, feel and interaction rules, so the
same design can be rebuilt on another stack. The reference implementation is
`app/globals.css`, `tailwind.config.ts` and `components/`; the brief it serves
is in the repo root `.impeccable.md`.

---

## 1. Intent

**Who:** people sending money home to Nigeria on a schedule, mostly inside
MiniPay's in-wallet browser on a mid-range Android at 360×640, often first-time
app users. They come back to answer one question — *did it go through?*

**Feel:** warm and human. A capable friend handling something important; not a
terminal, not a bank. Confidence comes from clarity, never decoration.

**Principles**

1. **The amount is the headline.** Every screen leads with the number and the
   person; mechanism comes after.
2. **Say what is actually true.** "Delivered" and "paid out" are different
   things and are never drawn the same. No optimistic states for money.
3. **One thumb, one hand.** Primary actions live at the bottom; tap targets are
   44px+; everything works at 360×640.
4. **Warmth through type and tone, not clutter.** Rhythm from spacing and
   hierarchy; decoration only where it carries meaning.
5. **MiniPay's rules are design constraints.** No wallet addresses on screen
   (not even truncated), no "gas", no CELO; names instead of hex; the deposit
   deeplink instead of a dead-end "top up" error.

---

## 2. Identity

**A ring for the schedule. A dot for the next transfer.** The mark replaces the
final `o` of the wordmark: a ring broken at the upper right, with a marigold dot
sitting in the break *on the ring's own circle*. The ring is the mandate signed
once; the dot is the money travelling round to the next date. Both are drawn
from one description in `components/Mark.tsx`, and
`scripts/build-brand-assets.mjs` rasterises the app icons from the same
geometry — so the icon on a home screen cannot drift from the mark on screen.

Geometry (100×100 viewBox): ring centred 50,50 at r=35, stroke 22, undrawn from
−81° to −9°; dot at 74.75,25.25 r=14. Butt caps, so the break is two clean
radial edges.

**Wordmark** — `remess` + the mark, set in Fraunces 600 at 27px in the header,
with `SOFT 100, WONK 1` and −0.03em tracking. Lowercase on purpose: it reads as
a person, not a bank. WONK leans the r, m and s like handwriting; it belongs to
the wordmark alone and never to running text.

The brand sheet sets its *own* headings at `SOFT 100` as well. That is the
brand page speaking at 44–88px, not an instruction for the product: the app
screens hold display type at `SOFT 30` (§4), and the two documents differ here
deliberately. Raising the app to 100 makes every heading read like signage.

| Ground | Letters | Ring | Dot |
|---|---|---|---|
| Paper / surface | `ink` | `clay` | marigold |
| Ink | `paper` | `clay-light` | marigold |
| Teal | `surface` | `surface` | marigold |

Rules

- **The dot stays marigold on every ground.** Only the one-colour version
  (`mono`) gives it up, and that exists for embossing, not for styling.
- **Clear space:** one ring-width (0.22 of the mark's own width) on every side.
- **Minimum size:** the wordmark is never below 80px wide — in the app that is
  26px type. Below it, use the mark alone.
- The ring never matches the letters. On ink it lifts to `clay-light`, because
  `clay` loses its shape against `#0f2125`.
- `app/icon.png`, `apple-icon.png` and `favicon.ico` are **generated**. Edit the
  geometry, run `node scripts/build-brand-assets.mjs`, and commit the output;
  `--check` fails on drift. `public/brand/` holds the SVGs for anything outside
  this repo.

---

## 3. Colour

Light theme only (MiniPay is a light in-wallet browser). Defined as OKLCH
channels so the palette can be retuned in one place; hex is given for stacks
without OKLCH. Every neutral is tinted a few degrees toward the accent hue so
paper and ink read as one material.

Token names are **roles**, not hues. The accent is called `clay` in the code
for historical reasons; it is teal.

| Role | Token | OKLCH (L C H) | Hex | Use |
|---|---|---|---|---|
| Page background | `paper` | 0.976 0.006 195 | `#f3f8f8` | body |
| Raised surface | `surface` | 0.995 0.003 195 | `#fbfefe` | cards, fields, sheet, buttons |
| Muted surface | `sand` | 0.952 0.011 195 | `#e7f2f1` | soft buttons, info notices, disclosure, muted discs |
| Hairline | `line` | 0.885 0.014 195 | `#cfdcdc` | borders, dividers, inactive progress |
| Text, primary | `ink` | 0.235 0.025 215 | `#0f2125` | headings, values, labels |
| Text, secondary | `ink-2` | 0.46 0.025 215 | `#485c61` | body copy, hints |
| Text, tertiary | `ink-3` | 0.62 0.02 210 | `#798a8d` | eyebrows, timestamps, units, placeholders |
| **Accent** | `clay` | 0.56 0.105 195 | `#008787` | primary buttons, selected state, progress, focus ring, headline emphasis |
| Accent, pressed | `clay-deep` | 0.47 0.105 198 | `#006c70` | hover/active on accent, text on accent-soft |
| Accent, tint | `clay-soft` | 0.955 0.03 195 | `#daf7f6` | selected tile fill, initials disc, review hero, selection |
| Accent on ink | `clay-light` | 0.7 0.11 192 | `#5fc9c6` | the mark's ring on an ink ground; nothing else |
| **Identity** | `marigold` | 0.76 0.16 65 | `#f59926` | the dot in the mark. Not a state, not a button |
| Money received / success | `naira` | 0.55 0.13 150 | `#298646` | naira amounts, delivered/paid-out, verified account, ✓ marks, live dot |
| Success tint | `naira-soft` | 0.955 0.04 150 | `#def8e2` | success notices, good pills |
| Caution | `amber` | 0.72 0.14 72 | `#da942c` | in-progress dots, warn pills |
| Caution tint | `amber-soft` | 0.965 0.045 82 | `#fff1d2` | warn notices, working/warn pills |
| Failure | `danger` | 0.55 0.19 27 | `#c9302d` | failed state, destructive button text, invalid field |
| Failure tint | `danger-soft` | 0.96 0.03 25 | `#ffebe8` | error notices, bad pills |

Rules

- One accent. It marks *the* action and *the* selection on a screen, nothing
  else. Two accent-coloured things competing is a bug.
- **Marigold is identity, never state.** It sits a few degrees from `amber`,
  which means "in flight, be careful". Spending marigold on anything but the
  dot makes the logo read as a warning, and makes a warning read as decoration.
- Green means money arrived or a check passed. Never use it for a button.
- Amber means "in flight" or "be careful"; it is the colour of a bank payout
  until the bank confirms. Red means it failed.
- Never pure black or pure white. Never grey text on a coloured background —
  use a darker shade of that background's hue (`clay-deep` on `clay-soft`,
  `naira` on `naira-soft`).
- Opacity modifiers on tokens are fine (`ink/40` overlay, `line/70` borders).

---

## 4. Typography

| Role | Font | Notes |
|---|---|---|
| Display | **Fraunces** (variable) | Headings and hero amounts only. `opsz 144, SOFT 30, WONK 0`, letter-spacing −0.02em. Never below ~22px. |
| Wordmark | **Fraunces** 600 | `opsz 144, SOFT 100, WONK 1`, −0.03em. The lockup only — see §2. |
| Text | **DM Sans** (variable, `opsz` axis) | Everything else. |
| Numbers | DM Sans with `tnum` | Tabular figures are on globally so amounts line up in lists. |
| Digit strings | DM Sans + 0.04em tracking (`.mono`) | Account numbers, references. Not a monospace font. |

Both are self-hosted (via `next/font`); no runtime request to Google, which
matters for MiniPay's network manifest.

Scale (px, mobile-first)

| Use | Size / weight |
|---|---|
| Hero amount | 44 display, medium; unit 16 medium `ink-3` |
| Page heading (H1) | 26 display |
| Section heading (H2) / sheet title | 22 display |
| Card title / row value | 15–16 medium |
| Body | 14–15 regular, line-height 1.6 |
| Hint / secondary | 13 regular `ink-2` |
| Pill, chip, meta | 12–13 medium |
| Eyebrow | 11 semibold, uppercase, tracking 0.12em, `ink-3` |

Copy voice: plain, second person, present tense. "You cancelled the signature."
"Not enough USDT in your wallet." Say *network fee*, never *gas*. Name the
recipient wherever possible ("No more transfers to Mum").

---

## 5. Space, shape, depth

- **Base unit 4px.** Page gutter 16px. Content max-width 512px, centred.
- **Rhythm, not uniformity:** tight inside a group (8–12px), generous between
  groups (24–32px). Sections are separated by space or a hairline, not boxes.
- **Radii:** buttons and cards 20px (`2xl`), fields and tiles 12px (`xl`),
  chips and pills fully round, bottom sheet 28px on top corners only.
- **Shadows** are low, diffuse and tinted with the ink hue — a card resting on
  paper, not floating:
  - card: `0 1px 2px ink/6%, 0 8px 24px -12px ink/18%`
  - lift (sheet): `0 2px 4px ink/8%, 0 16px 40px -16px ink/28%`
  - bar (upwards): `0 -8px 24px -12px ink/18%`
- **Don't nest cards.** A card is a list item or a discrete object; inside it,
  use hairlines and spacing.
- **Safe areas:** header padding respects `safe-area-inset-top`; the action
  bar respects `safe-area-inset-bottom`; `viewport-fit: cover`.

---

## 6. Motion

- Easing: `cubic-bezier(0.22, 1, 0.36, 1)` (ease-out-quint). No bounce.
- Entry: `rise` — opacity 0→1, translateY 8px→0, 500ms. Lists stagger children
  by 60ms (`.stagger`). A step change re-mounts its content with `rise`.
- Bottom sheet: `slide-up` 400ms with a 250ms backdrop fade.
- Feedback: buttons and tiles scale to 0.98 on press; 200ms transitions on
  colour/border. Progress segments animate colour over 500ms.
- Live state: a slow 1.8s opacity pulse on "working" dots and the current
  signing phase. Skeletons shimmer at 1.6s.
- **The lap** — the mark turns one full 360°, eases to a stop at 62%, and the
  dot pops to 1.35 and settles. 2.4s, `cubic-bezier(.65, 0, .35, 1)`. One lap
  means one transfer, so it is used for waiting (`motion="loop"`) and for
  something that just happened (`motion="once"`), and **never looped behind
  text somebody is reading**. It is the only animation allowed to run
  indefinitely besides the working-dot pulse and the skeleton shimmer.
  Three places, and adding a fourth needs a reason: the splash, the signing
  card's header, and "Connecting to your wallet…" on the landing. **One lap
  per screen** — a second thing turning beside it is the same bug as two
  accent-coloured things, which is why the signing steps pulse rather than
  spin.
- Only `transform` and `opacity` are animated. Reduced-motion collapses
  everything to ~0ms.

---

## 7. Components

Sizes are minimums; all interactive elements are ≥44px tall.

**Button** — 48px tall, 20px radius, 15px semibold, press scale 0.98,
disabled at 40% opacity (never disabled without a stated reason nearby).
- *Primary:* accent fill, white text, faint inner top highlight. One per screen.
- *Ink:* ink fill, paper text. Secondary-strong (e.g. "Verify account", "Fill in the form").
- *Ghost:* surface fill, hairline border. Back, "Keep it".
- *Soft:* sand fill. Pause/Resume, "Add money".
- *Danger:* surface fill, danger text and 25% danger border; solid danger only inside the confirmation sheet.
- *Small:* 40px tall, 12px radius, 14px text — header and inline actions.

**Field** — surface fill, hairline border, 12px radius, 15px text, 12px/16px
padding. Focus: accent border + 4px accent ring at 15%. Invalid: danger border
and ring. Placeholder in `ink-3`. Label above: 14px medium ink. Hint below:
13px `ink-2`. Address fields get a trailing **Paste** button.

**Hero amount input** — borderless, 44px display type, 2px bottom hairline
that turns accent on focus, unit set beside it in `ink-3`. Quick-amount chips
beneath.

**Tile** (single choice in a grid) — surface, hairline, 12px radius, 12px
padding, left-aligned title 15px medium + 12px subtitle. Selected: accent
border, `clay-soft` fill, 2px accent ring at 70%, subtitle in `clay-deep`.
Equal heights within a grid. Disabled at 40%.

**Chip** — 36px pill, hairline, 13px `ink-2`. Selected: accent border,
`clay-soft` fill, `clay-deep` text. Used for quick amounts, counts, and
tap-to-insert phrases.

**Switch** — 48×28 pill, `line` off / accent on, 24px white knob with card
shadow, 200ms slide. Mirrors the phone's own control.

**Status pill** — full-round, 12px medium, leading 6px dot. Tones:
- neutral: sand / `ink-2`, dot `ink-3` — paused, cancelled, completed, skipped
- working: `amber-soft` / ink, dot amber *pulsing* — starting, converting, paying out, awaiting bank
- good: `naira-soft` / naira — active, delivered (wallet), paid out
- warn: `amber-soft` / ink — not authorised
- bad: `danger-soft` / danger — failed

**Notice** — 12px radius, 16px/12px padding, 13px text; colour carries the
meaning, no icons. `info` sand/`ink-2`, `warn` amber-soft/ink, `danger`
danger-soft/danger, `good` naira-soft/naira. May carry a trailing small button
(e.g. "Add money", "Retry").

**Card** — surface, hairline at 70%, 20px radius, 20px padding, card shadow.
List cards are `initials disc + text block + pill`, tap-to-open, press scale
0.99, hover border darkens. Non-active cards drop surface to 60%.

**Initials disc** — 44px (list) / 48px (detail) circle, first letter in
display type; `clay-soft`/`clay-deep` when active, sand/`ink-3` when quiet.
Stands in for an avatar; never an address.

**Row** (definition list) — label left 14px `ink-2`, value right 15px ink,
optional 13px sub-line, 12px vertical padding, hairline dividers.

**Eyebrow** — small caps label above a block or a section.

**Progress** — three 4px segments with 6px gaps; completed and current are
accent, the rest `line`. Beneath: "Step 2 of 3 · How much".

**Action bar** — fixed to the bottom, full width, `paper` at 90% with blur,
hairline top, upward shadow, 12px top / 16px+safe-area bottom padding. Holds
one primary button (plus an optional ghost Back). An optional one-line note
above the buttons states why the primary is disabled. Pages using it add
~104px bottom padding.

**Bottom sheet** — rises from the bottom over an `ink/40` backdrop; 28px top
radii, drag handle, 22px display title, body, then a stacked destructive
button and a ghost dismiss. Escape and backdrop tap close it. Used only for
irreversible decisions.

**Splash** — the boot screen: the mark alone, 64px, orbiting on paper, while
the bundle loads. Server-rendered so the webview paints it instead of a white
rectangle, and taken down the moment React hydrates (450ms floor so a warm
load does not flicker, 320ms fade). It never replays on an in-app navigation,
and it cannot get stuck: a CSS backstop uncovers the page at 4s if React never
arrives, and with scripting off it is never shown. Not a brand interstitial —
if the app booted instantly it would be right to delete it.

**Skeleton** — sand→line shimmer, drawn in the shape of the content it
replaces (a disc + two lines for a list card, a wide bar for an amount).
Skeletons still own *content* loading; the lap is only for the app itself
starting and for a wallet action in flight.

**Timeline** — 11px dot per item on a 1px vertical rule, dot colour by outcome
(green delivered/paid, amber in-flight, red failed, grey skipped). Each item:
amount (→ naira amount in green when converted), relative time · attempt,
pill, optional notice, optional links.

**Checklist** — 20px circle marker: green ✓ passed, red ! failed, hairline
empty for neutral/not-yet. Failing items *state the problem* ("Not enough
USDT in your wallet") with a fix line beneath, which may be a link.

---

## 8. Screens and UX flows

### Shell
- Header is contextual: the wordmark lockup (26px) on the list; a chevron +
  page title as a back button everywhere else. Sticky, paper at 85% with blur.
- Right side: session name pill (green dot + generated two-word name, never
  an address). "Sign out" appears only on the list screen and never inside
  MiniPay, where the wallet owns the session. Inside MiniPay there is no
  connect button at all — it auto-connects and shows "Connecting" with a
  pulsing dot.
- Wrong network: an amber pill (MiniPay, can't switch) or a "Switch to Celo"
  primary button (other wallets).

### Landing (not connected)
Left-aligned display headline with the second line in the accent ("Send money
home, / on a schedule."), one paragraph, three hairline-separated benefit
lines, one full-width primary button. No cards.

### Home (connected)
1. **Total balance** eyebrow + the sum of USDT, USDC and cUSD in dollars
   (36px display, `$` set smaller in `ink-3`; the three are dollar
   stablecoins, summed 1:1). Inside MiniPay an "Add money" soft button on
   the right (deposit deeplink).
2. An asset switcher: three equal tiles (symbol in 12px, balance in 15px),
   the selected one in the accent tile-on state. Switching never changes
   the total — only which per-asset figure and allowance are shown.
3. A one-line disclosure: "Remesso can move up to **X USDT** in total" for
   the selected asset — the allowance is the sender's kill switch and is
   per-asset on-chain, explained on expand only.
4. **Schedules** H1 with an "N active" count. List of cards (name, pill,
   amount · cadence, then "Next in 6 days" for active or the recipient label
   otherwise). Skeletons while loading; a dashed-border empty state that
   teaches the three steps.
5. Action bar: "New schedule" / "Set up your first schedule".

### New schedule (3 steps: Who → How much → Review)
- Progress segments + "Step n of 3 · name". Step content re-enters with `rise`
  and the page scrolls to top.
- Action bar: Back (ghost) + Continue (primary). Continue is disabled only
  with a reason shown above it ("Give them a name to continue", "Enter their
  wallet address to continue", "Verify the bank account to continue", "Enter
  an amount to continue").

**Who**
- "Or just say it": a sand panel with a textarea; starter sentences as chips
  before anything is typed, an ink "Fill in the form" button after. Results
  come back as a note, a "still needed" warn notice with tap-to-add phrase
  chips (frequency, count only — never an address or amount), or an info
  notice offering to limit an open-ended schedule. A footer line says it
  only fills the form.
- Name field ("Who is this for?").
- Rail tiles: Stablecoin (Shows in MiniPay) / cNGN (Other wallets) / Bank
  (Coming soon, disabled). Choosing cNGN shows an amber notice that MiniPay
  will not display it. Stablecoin reveals asset tiles USDT / USDC / cUSD with
  a hint that no conversion happens.
- Address field with Paste; live "Looks right." in green or "That doesn't
  look like a complete address." in red; otherwise a hint that the address
  is fixed once signed.
- Bank fields (when enabled): bank select, 10-digit account number, an ink
  "Verify account" button; the verified name appears in a green panel with
  display type — the moment the sender confirms the person.

**How much**
- Hero amount input + quick chips (10 / 20 / 50 / 100). For conversion rails,
  "About ₦X at today's rate" beneath, naira in green.
- Cadence tiles in a 2-column grid.
- Rate floor (conversion rails only): label with the resulting ₦ value on the
  right, a range slider, "Skip a run if the rate drops more than N% below
  today", and a hint explaining it is written into the contract.
- Count chips: 6 / 12 / Until I stop it / an "Other" pill field. Tapped and
  typed values are tracked separately so typing "60" never lights "6".
- Expiry date field with a hint on why it is required (max one year).
- "Send the first one now" row with a switch.

**Review**
- A `clay-soft` hero block: eyebrow cadence ("EVERY MONTH"), hero amount, "to
  **Mum**", one line on how it arrives.
- Rows: rate floor (conversion only, with a sub-line), transfers, first one,
  expires, "You approve X USDT" with a sub-line on revoking.
- Short balance: amber notice with "Add money" inside MiniPay.
- One paragraph on what signing fixes on-chain.
- Action bar: Back + "Authorise" / "Approve & authorise".
- While signing, an info notice lists the phases — Saving the details,
  Approve in your wallet (only if needed), Sign the authorisation, Confirming
  on the network — done in green ✓, current in pulsing accent, later in
  `ink-3`. The page scrolls to keep it (or any error) in view. Errors are
  rewritten into plain language ("You cancelled the signature.", "Not enough
  funds to cover the network fee.", contract errors mapped by name).
- Success routes to the schedule page with `?created=1`.

### Schedule detail
- Optional green "You're all set." notice when just created.
- Initials disc + name + recipient label, pill on the right.
- Hero amount; "every month · next in 6 days".
- Hairline rows: rate floor (conversion only), transfers, expires, reference.
- **Next transfer** eyebrow + checklist read live from the contract (enough
  funds → "Add money" link in MiniPay; approval covers next run; due now).
- Pause/Resume (soft) and Cancel (danger) side by side. Cancel opens the
  bottom sheet: "Cancel this schedule?" / "No more transfers to Mum. This is
  written to the contract and cannot be undone…" / solid-danger "Yes, cancel
  it" / ghost "Keep it".
- **History** H2 + timeline. Bank payouts stay amber ("Awaiting bank") after
  the swap lands, with an info line that it isn't settled until the bank
  confirms. A skipped run's reason is a warn notice; a failed run's is a
  danger notice; the assistant's plain-English explanation sits above the raw
  reason, which is always shown.
- Loading: skeleton in the page's shape. A failed load says "Couldn't load
  this schedule" with Retry; "doesn't exist" is reserved for a real 404.

---

## 9. Anti-patterns (don't)

- Dark mode, neon accents, gradients on text, glassmorphism as decoration.
- Recolouring the dot, matching the ring to the letters, setting the wordmark
  in capitals, or hand-editing a generated icon.
- Card inside card; identical icon-heading-text card grids; centred everything.
- A disabled button with no stated reason.
- "Loading…" as text; use a skeleton in the content's shape.
- Modals for confirmation; use the bottom sheet, and only for the irreversible.
- Any 0x address, the word "gas", or CELO anywhere a user can read.
- Rendering a bank run's "delivered" as finished.
