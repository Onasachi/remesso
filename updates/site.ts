/// What build.ts and og.ts share: the site's own facts, and reading the
/// articles' metadata.

export const SITE = {
  url: "https://updates.remesso.xyz",
  name: "Remesso Updates",
  tagline: "Agent-to-agent remittance rails on Celo",
  description:
    "Articles from the team building Remesso: agent-to-agent remittance rails on Celo, where agents pay agents across borders in the currency the recipient spends.",
  app: "https://remesso.xyz",
  docs: "https://docs.remesso.xyz",
  code: "https://github.com/Onasachi/remesso",
  x: "useremesso_si",
} as const;

export type Meta = {
  title: string;
  /// One or two sentences: the home page, the feed and link previews use it.
  description: string;
  /// YYYY-MM-DD. Newest first everywhere.
  date: string;
  updated?: string;
  /// A Markdown article's masthead intro, when it should differ from the description.
  lede?: string;
  /// Text after the date in a Markdown article's masthead.
  kicker?: string;
  /// Alt text for the link-preview image.
  imageAlt?: string;
  /// Left out of the site entirely.
  draft?: boolean;
};

export const here = (rel: string) => decodeURIComponent(new URL(rel, import.meta.url).pathname);
export const ARTICLES = here("./articles/");

const isDate = (s: unknown): s is string =>
  typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s) &&
  !Number.isNaN(Date.parse(`${s}T00:00:00Z`)) && new Date(`${s}T00:00:00Z`).toISOString().startsWith(s);

/// Every article folder, by slug, with its metadata checked. Drafts included:
/// each caller decides what to do with them.
export async function articleDirs(): Promise<{ slug: string; dir: string; meta: Meta }[]> {
  const slugs: string[] = [];
  for await (const e of Deno.readDir(ARTICLES)) {
    if (e.isDirectory && !e.name.startsWith(".")) slugs.push(e.name);
  }
  slugs.sort();
  const found = [];
  for (const slug of slugs) {
    if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(slug)) {
      throw new Error(`articles/${slug}: a slug is lowercase letters and digits, joined by single hyphens`);
    }
    const dir = `${ARTICLES}${slug}/`;
    const meta = JSON.parse(await Deno.readTextFile(`${dir}article.json`)) as Meta;
    for (const k of ["title", "description"] as const) {
      if (typeof meta[k] !== "string" || !meta[k].trim()) throw new Error(`articles/${slug}/article.json: "${k}" is required`);
    }
    if (!isDate(meta.date)) throw new Error(`articles/${slug}/article.json: "date" must be a real YYYY-MM-DD`);
    if (meta.updated !== undefined && !isDate(meta.updated)) {
      throw new Error(`articles/${slug}/article.json: "updated" must be a real YYYY-MM-DD`);
    }
    found.push({ slug, dir, meta });
  }
  return found;
}

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];
/// "29 October 2026", the same on every machine.
export function longDate(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  return `${d} ${MONTHS[m - 1]} ${y}`;
}

export const esc = (s: string) =>
  s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");

/// Escaped, with each hyphenated word kept on one line (`.nw`), for titles.
export const title = (s: string) => esc(s).replace(/\w+(?:-\w+)+/g, (w) => `<span class="nw">${w}</span>`);

/// The mark's geometry, as web/components/Mark.tsx draws it.
export const RING_D = "M84.57 44.53A35 35 0 1 1 55.47 15.43";
export const X_PATH =
  "M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z";
