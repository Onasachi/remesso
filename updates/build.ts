/// Builds updates.remesso.xyz into updates/public from the articles in
/// updates/articles.
///
///   deno run --allow-read --allow-write updates/build.ts           rebuild public/
///   deno run --allow-read updates/build.ts --check                exit 1 if public/ is stale
///
/// public/ is committed and served exactly as it is, so the host runs no build,
/// and --check is what keeps it honest.
///
/// An article is a folder in articles/ named by its slug; its page is /<slug>/.
/// It holds article.json (see `Meta` in site.ts), one of body.md or body.html,
/// and optionally style.css and og.png (updates/og.ts draws that). Anything else
/// in the folder, such as images the body links to, is copied next to the page.
/// A body.md article gets the standard masthead from article.json. A body.html
/// article draws its own, and may write {{date}} and {{datetime}}.
import { marked } from "npm:marked@18.1.0";
import { articleDirs, esc, here, longDate, type Meta, RING_D, SITE, title, X_PATH } from "./site.ts";

const PUBLIC = here("./public/");
const check = Deno.args.includes("--check");

const FONTS =
  "https://fonts.googleapis.com/css2?family=DM+Mono:wght@400;500&family=DM+Sans:opsz,wght@9..40,400..700&family=Fraunces:opsz,wght,SOFT,WONK@9..144,400..700,0..100,0..1&display=swap";

/// Files copied as they are. The icons come from the app, so the brand has one source.
const STATIC: [string, string][] = [
  ["assets/site.css", here("./assets/site.css")],
  ["og.png", here("./assets/og.png")],
  ["favicon.svg", here("../web/public/brand/remesso-mark.svg")],
  ["favicon.ico", here("../web/app/favicon.ico")],
  ["icon.png", here("../web/app/icon.png")],
  ["apple-touch-icon.png", here("../web/app/apple-icon.png")],
];
const OWN_FILES = new Set(["article.json", "body.md", "body.html", "style.css"]);

type Article = Meta & { slug: string; main: string; css: string; image: string };

const out = new Map<string, Uint8Array>();
const enc = new TextEncoder();
function put(path: string, data: string | Uint8Array) {
  if (out.has(path)) throw new Error(`${path} would be written twice`);
  out.set(path, typeof data === "string" ? enc.encode(data) : data);
}

/// Relative paths of the files under `dir`, skipping dotfiles; [] if it doesn't exist.
async function filesUnder(dir: string, prefix = ""): Promise<string[]> {
  const found: string[] = [];
  try {
    for await (const e of Deno.readDir(dir + prefix)) {
      if (e.name.startsWith(".")) continue;
      if (e.isDirectory) found.push(...await filesUnder(dir, `${prefix}${e.name}/`));
      else if (e.isFile) found.push(prefix + e.name);
    }
  } catch (e) {
    if (!(e instanceof Deno.errors.NotFound)) throw e;
  }
  return found.sort();
}

const WORDMARK =
  `<span class="wordmark" role="img" aria-label="Remesso">remess<svg class="ring" viewBox="0 0 100 100" aria-hidden="true"><path d="${RING_D}" fill="none" stroke-width="22"/><circle cx="74.75" cy="25.25" r="14"/></svg></span>`;
const X_ICON = `<svg class="x-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="${X_PATH}"/></svg>`;
const BRAND = `<a class="brand" href="/">${WORDMARK}<span class="brand-tag">Updates</span></a>`;

const HEADER = `<header class="site-head">
  <div class="site-bar wide">
    ${BRAND}
    <nav class="site-nav" aria-label="Remesso">
      <a href="${SITE.docs}">Docs</a>
      <a href="https://x.com/${SITE.x}">${X_ICON}<span>@${SITE.x}</span></a>
      <a class="nav-app" href="${SITE.app}">Open the app</a>
    </nav>
  </div>
</header>`;

const FOOTER = `<footer class="site-foot">
  <div class="foot-inner wide">
    <div class="foot-brand">
      ${BRAND}
      <p class="foot-line">${SITE.tagline}.</p>
    </div>
    <nav class="foot-nav" aria-label="Elsewhere">
      <a href="${SITE.app}">App</a>
      <a href="${SITE.docs}">Docs</a>
      <a href="https://x.com/${SITE.x}">X</a>
      <a href="${SITE.code}">GitHub</a>
      <a href="/feed.xml">RSS</a>
    </nav>
  </div>
</footer>`;

/// Every page ends by pointing at the product: the app, the docs, and X.
function cta(share?: { title: string; url: string }): string {
  const x = share
    ? `<a class="btn" href="${esc(`https://x.com/intent/tweet?${new URLSearchParams({ text: share.title, url: share.url, via: SITE.x })}`)}">Share on X</a>`
    : `<a class="btn" href="https://x.com/${SITE.x}">Follow @${SITE.x}</a>`;
  return `<aside class="site-cta" aria-labelledby="cta-h">
  <div class="cta-card wide">
    <div>
      <h2 id="cta-h">Try Remesso</h2>
      <p>Mandates and spending limits a human signs on-chain, so agents can pay agents across borders in the currency the recipient spends.</p>
    </div>
    <div class="cta-actions">
      <a class="btn btn-primary" href="${SITE.app}">Open the app</a>
      <a class="btn" href="${SITE.docs}">Read the docs</a>
      ${x}
    </div>
  </div>
</aside>`;
}

type Page = {
  path: string;
  title: string;
  /// The title link previews show, without the site's name.
  shareTitle: string;
  description: string;
  image: string;
  imageAlt: string;
  type: "website" | "article";
  published?: string;
  modified?: string;
  css?: string;
  main: string;
  share?: boolean;
  noindex?: boolean;
};

function shell(p: Page): string {
  const url = SITE.url + p.path;
  const meta = [
    `<meta name="description" content="${esc(p.description)}">`,
    p.noindex ? `<meta name="robots" content="noindex">` : `<link rel="canonical" href="${url}">`,
    `<link rel="alternate" type="application/atom+xml" title="${SITE.name}" href="/feed.xml">`,
    `<link rel="icon" href="/favicon.ico" sizes="any">`,
    `<link rel="icon" href="/favicon.svg" type="image/svg+xml">`,
    `<link rel="apple-touch-icon" href="/apple-touch-icon.png">`,
    `<meta property="og:site_name" content="${SITE.name}">`,
    `<meta property="og:type" content="${p.type}">`,
    `<meta property="og:title" content="${esc(p.shareTitle)}">`,
    `<meta property="og:description" content="${esc(p.description)}">`,
    `<meta property="og:url" content="${url}">`,
    `<meta property="og:image" content="${p.image}">`,
    `<meta property="og:image:width" content="1200">`,
    `<meta property="og:image:height" content="630">`,
    `<meta property="og:image:alt" content="${esc(p.imageAlt)}">`,
    ...(p.published ? [`<meta property="article:published_time" content="${p.published}T00:00:00Z">`] : []),
    ...(p.modified ? [`<meta property="article:modified_time" content="${p.modified}T00:00:00Z">`] : []),
    `<meta name="twitter:card" content="summary_large_image">`,
    `<meta name="twitter:site" content="@${SITE.x}">`,
    `<meta name="twitter:creator" content="@${SITE.x}">`,
    `<meta name="twitter:title" content="${esc(p.shareTitle)}">`,
    `<meta name="twitter:description" content="${esc(p.description)}">`,
    `<meta name="twitter:image" content="${p.image}">`,
    `<meta name="twitter:image:alt" content="${esc(p.imageAlt)}">`,
  ];
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${esc(p.title)}</title>
${meta.join("\n")}
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="${esc(FONTS)}">
<link rel="stylesheet" href="/assets/site.css">
${p.css ? `<style>\n${p.css.trim()}\n</style>\n` : ""}</head>
<body>
<a class="skip" href="#content">Skip to content</a>
${HEADER}
<main id="content">
${p.main.trim()}
</main>
${cta(p.share ? { title: p.shareTitle, url } : undefined)}
${FOOTER}
</body>
</html>
`;
}

function markdownMain(m: Meta, html: string): string {
  return `<header class="col mast">
  <p class="eyebrow"><time datetime="${m.date}">${longDate(m.date)}</time>${m.kicker ? ` · ${esc(m.kicker)}` : ""}</p>
  <h1>${title(m.title)}</h1>
  <p class="lede">${esc(m.lede ?? m.description)}</p>
</header>
<article class="col prose">
${html.trim()}
</article>`;
}

async function loadArticles(): Promise<Article[]> {
  const list: Article[] = [];
  for (const { slug, dir, meta } of await articleDirs()) {
    if (meta.draft) continue;
    const files = await filesUnder(dir);
    const md = files.includes("body.md");
    if (md === files.includes("body.html")) throw new Error(`articles/${slug}: needs exactly one of body.md or body.html`);
    const raw = await Deno.readTextFile(`${dir}${md ? "body.md" : "body.html"}`);
    const main = md
      ? markdownMain(meta, marked.parse(raw, { async: false, gfm: true }) as string)
      : raw.replaceAll("{{datetime}}", meta.date).replaceAll("{{date}}", longDate(meta.date));
    for (const f of files) if (!OWN_FILES.has(f)) put(`${slug}/${f}`, await Deno.readFile(dir + f));
    list.push({
      ...meta,
      slug,
      main,
      css: files.includes("style.css") ? await Deno.readTextFile(`${dir}style.css`) : "",
      image: files.includes("og.png") ? `/${slug}/og.png` : "/og.png",
    });
  }
  return list.sort((a, b) => b.date.localeCompare(a.date) || a.slug.localeCompare(b.slug));
}

function homeMain(list: Article[]): string {
  const [first, ...rest] = list;
  const feature = first
    ? `<article class="feature wide">
  <img src="${first.image}" alt="" width="1200" height="630">
  <div class="post-body">
    <p class="post-date"><time datetime="${first.date}">${longDate(first.date)}</time></p>
    <h2><a href="/${first.slug}/">${title(first.title)}</a></h2>
    <p class="post-desc">${esc(first.description)}</p>
    <p class="read" aria-hidden="true">Read the article →</p>
  </div>
</article>`
    : `<p class="col">Nothing here yet.</p>`;
  const older = rest.length
    ? `<section class="col" aria-labelledby="older-h">
  <h2 class="list-h" id="older-h">Earlier</h2>
  <ul class="posts">
${rest.map((a) => `    <li class="post"><p class="post-date"><time datetime="${a.date}">${longDate(a.date)}</time></p><h3><a href="/${a.slug}/">${title(a.title)}</a></h3><p class="post-desc">${esc(a.description)}</p></li>`).join("\n")}
  </ul>
</section>`
    : "";
  return `<header class="col mast">
  <p class="eyebrow">${SITE.name}</p>
  <h1>What we're building</h1>
  <p class="lede">${esc(SITE.description)}</p>
  <p class="follow">Follow <a href="https://x.com/${SITE.x}">@${SITE.x}</a> on X, or subscribe to the <a href="/feed.xml">RSS feed</a>.</p>
</header>
${feature}
${older}`;
}

function feed(list: Article[]): string {
  const updated = list.reduce((max, a) => (a.updated ?? a.date) > max ? (a.updated ?? a.date) : max, "1970-01-01");
  const entries = list.map((a) => `  <entry>
    <title>${esc(a.title)}</title>
    <link href="${SITE.url}/${a.slug}/"/>
    <id>${SITE.url}/${a.slug}/</id>
    <published>${a.date}T00:00:00Z</published>
    <updated>${a.updated ?? a.date}T00:00:00Z</updated>
    <summary>${esc(a.description)}</summary>
  </entry>`);
  return `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>${SITE.name}</title>
  <subtitle>${esc(SITE.description)}</subtitle>
  <link href="${SITE.url}/feed.xml" rel="self"/>
  <link href="${SITE.url}/"/>
  <id>${SITE.url}/</id>
  <updated>${updated}T00:00:00Z</updated>
  <author><name>Remesso</name><uri>https://x.com/${SITE.x}</uri></author>
  <icon>${SITE.url}/icon.png</icon>
${entries.join("\n")}
</feed>
`;
}

function sitemap(list: Article[]): string {
  const latest = list[0] ? list[0].updated ?? list[0].date : undefined;
  const urls = [
    `  <url><loc>${SITE.url}/</loc>${latest ? `<lastmod>${latest}</lastmod>` : ""}</url>`,
    ...list.map((a) => `  <url><loc>${SITE.url}/${a.slug}/</loc><lastmod>${a.updated ?? a.date}</lastmod></url>`),
  ];
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.join("\n")}
</urlset>
`;
}

// ---------------------------------------------------------------------------

for (const [to, from] of STATIC) {
  try {
    put(to, await Deno.readFile(from));
  } catch (e) {
    if (e instanceof Deno.errors.NotFound && to === "og.png") {
      throw new Error("updates/assets/og.png is missing: draw it with updates/og.ts");
    }
    throw e;
  }
}

const articles = await loadArticles();
const siteImage = `${SITE.url}/og.png`;

put("index.html", shell({
  path: "/",
  title: SITE.name,
  shareTitle: SITE.name,
  description: SITE.description,
  image: siteImage,
  imageAlt: `${SITE.name}: ${SITE.tagline}`,
  type: "website",
  main: homeMain(articles),
}));
for (const a of articles) {
  put(`${a.slug}/index.html`, shell({
    path: `/${a.slug}/`,
    title: `${a.title} · ${SITE.name}`,
    shareTitle: a.title,
    description: a.description,
    image: SITE.url + a.image,
    imageAlt: a.imageAlt ?? `${SITE.name}: ${a.title}`,
    type: "article",
    published: a.date,
    modified: a.updated,
    css: a.css,
    main: a.main,
    share: true,
  }));
}
put("404.html", shell({
  path: "/404.html",
  title: `Page not found · ${SITE.name}`,
  shareTitle: SITE.name,
  description: SITE.description,
  image: siteImage,
  imageAlt: `${SITE.name}: ${SITE.tagline}`,
  type: "website",
  noindex: true,
  main: `<header class="col mast">
  <p class="eyebrow">404</p>
  <h1>That page isn't here</h1>
  <p class="lede">It may have moved. <a href="/">See every update</a>, or go to the <a href="${SITE.app}">app</a> or the <a href="${SITE.docs}">docs</a>.</p>
</header>`,
}));
put("feed.xml", feed(articles));
put("sitemap.xml", sitemap(articles));
put("robots.txt", `User-agent: *\nAllow: /\n\nSitemap: ${SITE.url}/sitemap.xml\n`);

const same = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((v, i) => v === b[i]);
const readOr = async (path: string) => {
  try {
    return await Deno.readFile(path);
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) return null;
    throw e;
  }
};
const existing = await filesUnder(PUBLIC);

if (check) {
  const problems: string[] = [];
  for (const [path, data] of out) {
    const current = await readOr(PUBLIC + path);
    if (!current) problems.push(`missing ${path}`);
    else if (!same(current, data)) problems.push(`stale   ${path}`);
  }
  for (const path of existing) if (!out.has(path)) problems.push(`extra   ${path}`);
  if (problems.length) {
    console.error(`updates/public is out of date; run updates/build.ts.\n  ${problems.join("\n  ")}`);
    Deno.exit(1);
  }
  console.log(`updates/public matches its sources: ${out.size} files, ${articles.length} articles.`);
} else {
  for (const path of existing) if (!out.has(path)) await Deno.remove(PUBLIC + path);
  let written = 0;
  for (const [path, data] of out) {
    const current = await readOr(PUBLIC + path);
    if (current && same(current, data)) continue;
    await Deno.mkdir(PUBLIC + path.slice(0, path.lastIndexOf("/") + 1), { recursive: true });
    await Deno.writeFile(PUBLIC + path, data);
    written++;
  }
  // Folders a removed article left behind.
  for await (const e of Deno.readDir(PUBLIC)) {
    if (!e.isDirectory) continue;
    if ((await filesUnder(PUBLIC, `${e.name}/`)).length === 0) await Deno.remove(PUBLIC + e.name, { recursive: true });
  }
  console.log(`updates/public: ${out.size} files, ${written} written, ${articles.length} articles.`);
}
