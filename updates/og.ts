/// Draws the link previews (1200×630 PNG) that X and other apps show for
/// updates.remesso.xyz: the site's own (assets/og.png) and one per article
/// (articles/<slug>/og.png). They are committed, so the site build needs no
/// browser.
///
///   deno run --allow-read --allow-write --allow-run --allow-env updates/og.ts           draw the missing ones
///   deno run --allow-read --allow-write --allow-run --allow-env updates/og.ts --force   redraw them all
///
/// Needs Chrome, and the network for the fonts. Set CHROME to the binary if it
/// isn't in the usual macOS place.
import { articleDirs, esc, here, longDate, RING_D, SITE, title, X_PATH } from "./site.ts";

const CHROME = Deno.env.get("CHROME") ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const force = Deno.args.includes("--force");

type Card = { out: string; tag: string; title: string; description: string };

const cards: Card[] = [{
  out: here("./assets/og.png"),
  tag: "Updates",
  title: SITE.tagline,
  description: "How Remesso works and what we're shipping, from the team building it.",
}];
for (const { dir, meta } of await articleDirs()) {
  if (meta.draft) continue;
  cards.push({ out: `${dir}og.png`, tag: longDate(meta.date), title: meta.title, description: meta.description });
}

// Light only: a preview is shown on whatever background the app around it has.
const page = (c: Card) => `<!doctype html>
<html><head><meta charset="utf-8">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=DM+Sans:opsz,wght@9..40,400..700&family=Fraunces:opsz,wght,SOFT,WONK@9..144,400..700,0..100,0..1&display=block">
<style>
  html, body { margin: 0; width: 1200px; height: 630px; overflow: hidden; background: oklch(0.976 0.006 195); }
  .card { position: relative; box-sizing: border-box; width: 1200px; height: 630px; padding: 60px 72px 52px; display: flex; flex-direction: column; overflow: hidden; }
  .bg { position: absolute; right: -96px; top: -96px; width: 420px; height: 420px; }
  .bg path { stroke: oklch(0.935 0.03 195); }
  .bg circle { fill: oklch(0.92 0.06 75); }
  .top { position: relative; display: flex; align-items: baseline; gap: 18px; }
  .wordmark { font-family: "Fraunces"; font-variation-settings: "opsz" 144, "SOFT" 100, "WONK" 1; font-weight: 600; letter-spacing: -0.03em; font-size: 46px; line-height: 1; color: oklch(0.235 0.025 215); display: inline-flex; align-items: baseline; }
  .wordmark svg { width: 0.5em; height: 0.5em; margin-left: 0.03em; position: relative; top: 0.035em; overflow: visible; }
  .wordmark path { stroke: oklch(0.56 0.105 195); }
  .wordmark circle { fill: oklch(0.76 0.16 65); }
  .tag { font: 600 17px/1 "DM Sans"; letter-spacing: 0.12em; text-transform: uppercase; color: oklch(0.47 0.105 198); }
  h1 { position: relative; margin: auto 0 0; max-width: 980px; font-family: "Fraunces"; font-variation-settings: "opsz" 144, "SOFT" 30, "WONK" 0; font-weight: 560; font-size: 74px; line-height: 1.05; letter-spacing: -0.02em; color: oklch(0.235 0.025 215); text-wrap: balance; }
  p { position: relative; margin: 22px 0 0; max-width: 920px; font: 400 27px/1.4 "DM Sans"; color: oklch(0.46 0.025 215); }
  .foot { position: relative; margin-top: 36px; padding-top: 20px; border-top: 2px solid oklch(0.885 0.014 195); display: flex; justify-content: space-between; align-items: center; font: 500 21px/1 "DM Sans"; color: oklch(0.5 0.02 210); }
  .foot span { display: inline-flex; align-items: center; gap: 10px; }
  .foot svg { width: 18px; height: 18px; fill: currentColor; }
  .nw { white-space: nowrap; }
</style></head>
<body><div class="card">
  <svg class="bg" viewBox="0 0 100 100" aria-hidden="true"><path d="${RING_D}" fill="none" stroke-width="22"/><circle cx="74.75" cy="25.25" r="14"/></svg>
  <div class="top"><span class="wordmark">remess<svg viewBox="0 0 100 100"><path d="${RING_D}" fill="none" stroke-width="22"/><circle cx="74.75" cy="25.25" r="14"/></svg></span><span class="tag">${esc(c.tag)}</span></div>
  <h1>${title(c.title)}</h1>
  <p>${esc(c.description)}</p>
  <div class="foot"><span>${new URL(SITE.url).host}</span><span><svg viewBox="0 0 24 24"><path d="${X_PATH}"/></svg>@${SITE.x}</span></div>
</div></body></html>
`;

/// Width and height from a PNG's IHDR chunk.
function pngSize(png: Uint8Array): [number, number] {
  const v = new DataView(png.buffer, png.byteOffset, png.byteLength);
  return [v.getUint32(16), v.getUint32(20)];
}

const work = await Deno.makeTempDir({ prefix: "remesso-og-" });
try {
  for (const c of cards) {
    const exists = await Deno.stat(c.out).then(() => true, () => false);
    if (exists && !force) continue;
    const html = `${work}/card.html`;
    const png = `${work}/card.png`;
    await Deno.writeTextFile(html, page(c));
    await Deno.remove(png).catch(() => {});
    // A profile of its own, so a Chrome the user has open is never touched.
    const { code, stderr } = await new Deno.Command(CHROME, {
      args: [
        "--headless=new", "--disable-gpu", "--hide-scrollbars", "--no-first-run", "--no-default-browser-check",
        `--user-data-dir=${work}/profile`, "--force-device-scale-factor=1", "--window-size=1200,630",
        "--virtual-time-budget=10000", `--screenshot=${png}`, `file://${html}`,
      ],
      stdout: "null",
      stderr: "piped",
      signal: AbortSignal.timeout(90_000),
    }).output();
    const shot = await Deno.readFile(png).catch(() => null);
    if (code !== 0 || !shot) throw new Error(`Chrome failed on "${c.title}": ${new TextDecoder().decode(stderr).slice(-400)}`);
    const [w, h] = pngSize(shot);
    if (w !== 1200 || h !== 630) throw new Error(`"${c.title}" came out ${w}×${h}, not 1200×630`);
    await Deno.writeFile(c.out, shot);
    console.log(`drew ${c.out.replace(here("./"), "updates/")}`);
  }
} finally {
  await Deno.remove(work, { recursive: true });
}
