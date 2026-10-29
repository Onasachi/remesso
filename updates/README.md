# updates.remesso.xyz

Remesso's articles: how it works and what we ship. They are written in
`articles/`, built into `public/` by `build.ts`, and served as plain files, so
the host runs no build.

Every page carries the X handle [@useremesso_si](https://x.com/useremesso_si),
links to the [app](https://remesso.xyz) and the
[docs](https://docs.remesso.xyz), and ends with "Open the app", "Read the docs"
and "Share on X". Each one also has a link preview for X, an RSS feed entry
(`/feed.xml`) and a sitemap line.

## Write an article

1. Make a folder in `articles/` named by the slug. `articles/naira-cash-out/` is
   published at `https://updates.remesso.xyz/naira-cash-out/`.
2. Add `article.json`:

   ```json
   {
     "title": "Paying out in naira",
     "description": "One or two sentences. The home page, the feed and link previews use it.",
     "date": "2026-11-03"
   }
   ```

   Optional fields: `lede` (a Markdown article's intro, if it isn't the
   description), `kicker` (text after the date), `updated`, `imageAlt`, and
   `"draft": true` to keep it off the site.
3. Write the body as one of:
   - `body.md`: Markdown. The page gets the standard masthead: date, title and
     lede.
   - `body.html`: for an article with its own layout, like the integration map.
     It draws its own masthead, and `{{date}}` and `{{datetime}}` are filled in.
     Styles only it needs go in `style.css`, built on the tokens in
     `assets/site.css`.

   Images and any other files in the folder are copied next to the page, so
   `![](chart.png)` works.
4. Draw its link preview, then build:

   ```bash
   deno run --allow-read --allow-write --allow-run --allow-env updates/og.ts
   deno run --allow-read --allow-write updates/build.ts
   ```

   `og.ts` needs Chrome and draws only the previews that are missing
   (`--force` redraws them all).
5. Commit `articles/` and `public/` together. `build.ts --check` exits 1 while
   `public/` is stale.

To look at it locally:

```bash
deno run --allow-net --allow-read jsr:@std/http@1/file-server updates/public --port 3012
```

## Deploy

It's a Vercel project of its own:

1. **Add New → Project**, import this repository, and set **Root Directory** to
   `updates`. `vercel.json` sets the rest: no framework, no build, and `public/`
   as the output.
2. In the project's **Settings → Domains**, add `updates.remesso.xyz`.
3. At Namecheap, add the DNS record Vercel shows for it: a `CNAME` with host
   `updates`, pointing at Vercel's target (usually `cname.vercel-dns.com`).

After that, every push to the production branch publishes the committed
`public/`.
