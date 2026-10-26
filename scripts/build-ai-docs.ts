/// The documentation, for AI assistants, written from docs-site/docs so it
/// can't drift from the pages people read:
///
///   docs-site/static/llms.txt                 an index of every page (llmstxt.org)
///   docs-site/static/llms-full.txt            every page in one file, in sidebar order
///   docs-site/static/docs/<page>.md           each page as Markdown, at its URL plus .md
///   skills/remesso-sdk/references/<page>.md   the same pages, for the remesso-sdk
///                                             skill, which lists them in its SKILL.md
///
/// The MDX in the pages becomes plain Markdown: the deployment tables from the
/// rows the site renders them from (docs-site/src/components/deployment-rows.ts),
/// tabs as labelled blocks, admonitions as quotes. A component it doesn't know
/// stops it rather than vanishing from the text. Links between pages stay
/// relative in the per-page files, whose folders mirror the docs, and become
/// URLs in llms-full.txt.
///
///   deno run --allow-read --allow-write scripts/build-ai-docs.ts          write them
///   deno run --allow-read --allow-write scripts/build-ai-docs.ts --check  exit 1 if any differs
import {
  chainRows,
  contractRows,
  type Deployment,
  endpointRows,
  EXPLORER,
  feePercent,
  type Text,
  tokenRows,
} from "../docs-site/src/components/deployment-rows.ts";

const SITE = "https://docs.remesso.xyz";
const ROOT = new URL("..", import.meta.url).pathname;
const DOCS = `${ROOT}docs-site/docs`;
const STATIC = "docs-site/static";
const SKILL_DIR = "skills/remesso-sdk";
const START = "<!-- references: written by scripts/build-ai-docs.ts -->";
const END = "<!-- /references -->";
const check = Deno.args.includes("--check");

const read = (path: string) => Deno.readTextFile(`${ROOT}${path}`);
const deployment = JSON.parse(await read("docs-site/src/data/deployment.json")) as Deployment;
const version = JSON.parse(await read("packages/remesso-sdk/package.json")).version as string;
const config = await read("docs-site/docusaurus.config.ts");
const siteTitle = config.match(/^\s*title:\s*"([^"]+)"/m)?.[1];
const tagline = config.match(/^\s*tagline:\s*"([^"]+)"/m)?.[1];
if (!siteTitle || !tagline) throw new Error("docusaurus.config.ts: no title or tagline found");

type Category = { label: string; ids: string[] };
type Page = { id: string; title: string; label: string; description: string; url: string; body: string };

/// The sidebar's categories and their pages, in order. Read as text: the file
/// imports Docusaurus types this script has no use for.
function sidebar(src: string): Category[] {
  return src.split(/type:\s*"category"/).slice(1).map((chunk) => {
    const label = chunk.match(/label:\s*"([^"]+)"/)?.[1];
    const link = chunk.match(/link:\s*\{\s*type:\s*"doc",\s*id:\s*"([^"]+)"/)?.[1];
    const items = chunk.match(/items:\s*\[([^\]]*)\]/)?.[1];
    if (!label || items === undefined) throw new Error(`sidebars.ts: can't read a category near "${chunk.slice(0, 60).trim()}"`);
    const ids = [...items.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
    return { label, ids: link ? [link, ...ids] : ids };
  });
}

function unquote(value: string): string {
  if (value.startsWith('"') && value.endsWith('"')) return JSON.parse(value);
  if (value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1).replaceAll("''", "'");
  return value;
}

function parse(id: string, src: string): Page {
  const front = src.match(/^---\n([\s\S]*?)\n---\n/);
  if (!front) throw new Error(`${id}: no frontmatter`);
  const meta: Record<string, string> = {};
  for (const line of front[1].split("\n")) {
    const kv = line.match(/^([a-z_]+):\s*(.*)$/);
    if (kv) meta[kv[1]] = unquote(kv[2].trim());
  }
  if (!meta.title || !meta.description) throw new Error(`${id}: needs a title and a description`);
  // Docusaurus serves a page at its slug, else at its id, an index at its folder.
  const route = meta.slug === "/" ? "" : meta.slug ?? `/${id.replace(/(^|\/)index$/, "")}`;
  return {
    id,
    title: meta.title,
    label: meta.sidebar_label ?? meta.title,
    description: meta.description,
    url: `${SITE}/docs${route}`,
    body: plain(id, src.slice(front[0].length)),
  };
}

// --- MDX to Markdown -------------------------------------------------------------

const address = (value: string) => `[\`${value}\`](${EXPLORER}${value})`;
const rich = (text: Text) => text.map((part) => typeof part === "string" ? part : `\`${part.code}\``).join("");
function table(head: string[], rows: string[][]): string[] {
  const cell = (s: string) => s.replaceAll("|", "\\|");
  return [`| ${head.map(cell).join(" | ")} |`, `|${head.map(() => "---").join("|")}|`, ...rows.map((r) => `| ${r.map(cell).join(" | ")} |`)];
}
const TABLES: Record<string, () => string[]> = {
  TokenTable: () =>
    table(
      ["Token", "Currency", "Decimals", "Per payment, before the fee", "Pays gas", "Address"],
      tokenRows(deployment).map((t) => [`**${t.symbol}**`, t.currency, String(t.decimals), t.perPayment, t.paysGas ? "Yes" : "No", address(t.address)]),
    ),
  ChainTable: () => table(["", ""], chainRows(deployment).map((r) => [`**${r.label}**`, rich(r.value)])),
  ContractTable: () =>
    table(
      ["Contract", "Address", "What it does"],
      contractRows(deployment).map((r) => [`**${r.name}**`, r.linked ? address(r.address) : `\`${r.address}\``, r.note]),
    ),
  EndpointTable: () => table(["Endpoint", "What it does"], endpointRows(deployment).map((r) => [`\`${r.url}\``, r.note])),
};
const INLINE: Record<string, () => string> = { FeePercent: () => feePercent(deployment) };
const ADMONITION = /^:::(note|tip|info|warning|danger|caution)(?:\[(.+)\]|\s+(.+))?\s*$/;

/// A page's MDX body as Markdown. Code blocks pass through untouched, apart
/// from check-snippets' `nocheck`, which means nothing to a reader.
function plain(id: string, body: string): string {
  const out: string[] = [];
  let fence: string | null = null;
  let quote = false;
  const push = (line: string) => out.push(quote ? (line ? `> ${line}` : ">") : line);
  for (const line of body.split("\n")) {
    const trimmed = line.trimStart();
    if (fence) {
      if (trimmed.startsWith(fence) && trimmed.slice(fence.length).trim() === "") fence = null;
      push(line);
      continue;
    }
    const open = trimmed.match(/^(`{3,}|~{3,})(.*)$/);
    if (open) {
      fence = open[1];
      push(`${line.slice(0, line.length - trimmed.length)}${open[1]}${open[2].replace(/\s*\bnocheck\b/, "")}`);
      continue;
    }
    if (/^import\s.+\sfrom\s+['"]@(site|theme)\/[^'"]+['"];?\s*$/.test(trimmed)) continue;
    const admonition = trimmed.match(ADMONITION);
    if (admonition) {
      const kind = admonition[1];
      push(`> **${admonition[2] ?? admonition[3] ?? kind[0].toUpperCase() + kind.slice(1)}**`);
      quote = true;
      push("");
      continue;
    }
    if (quote && /^:::\s*$/.test(trimmed)) {
      quote = false;
      continue;
    }
    if (/^<\/?Tabs\b[^>]*>$/.test(trimmed) || /^<\/TabItem>$/.test(trimmed)) continue;
    const tab = trimmed.match(/^<TabItem\b[^>]*\blabel="([^"]+)"[^>]*>$/);
    if (tab) {
      push(`**${tab[1]}**`);
      continue;
    }
    const component = trimmed.match(/^<([A-Z][A-Za-z]*)\s*\/>$/);
    if (component) {
      const render = TABLES[component[1]];
      if (!render) throw new Error(`${id}: no Markdown for <${component[1]} />; add it to build-ai-docs.ts`);
      for (const row of render()) push(row);
      continue;
    }
    const inline = line.replace(/<([A-Z][A-Za-z]*)\s*\/>/g, (_m, name: string) => {
      if (!INLINE[name]) throw new Error(`${id}: no Markdown for <${name} />; add it to build-ai-docs.ts`);
      return INLINE[name]();
    });
    if (/^<\/?[A-Z]/.test(trimmed)) throw new Error(`${id}: no Markdown for ${trimmed}; add it to build-ai-docs.ts`);
    push(inline);
  }
  if (fence || quote) throw new Error(`${id}: a code block or an admonition is never closed`);
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

/// The body with every link to another page as its URL, for llms-full.txt,
/// where relative paths have nothing to resolve against.
function absolute(page: Page, urls: Map<string, string>): string {
  let fence: string | null = null;
  return page.body.split("\n").map((line) => {
    const trimmed = line.replace(/^>\s?/, "").trimStart();
    if (fence) {
      if (trimmed.startsWith(fence)) fence = null;
      return line;
    }
    const open = trimmed.match(/^(`{3,}|~{3,})/);
    if (open) {
      fence = open[1];
      return line;
    }
    return line.replace(/\]\(([^)\s]+)\)/g, (whole, target: string) => {
      if (/^[a-z]+:/i.test(target)) return whole;
      const [path, anchor] = target.split("#");
      if (!path) return `](${page.url}#${anchor})`;
      const dir = page.id.includes("/") ? page.id.slice(0, page.id.lastIndexOf("/") + 1) : "";
      const id = new URL(path, `file:///${dir}`).pathname.slice(1).replace(/\.mdx?$/, "");
      const url = urls.get(id);
      if (!url) throw new Error(`${page.id}: links to ${target}, which isn't a page`);
      return `](${url}${anchor ? `#${anchor}` : ""})`;
    });
  }).join("\n");
}

const document = (page: Page, body: string) => `# ${page.title}\n\n> ${page.description}\n\nSource: ${page.url}\n\n${body}\n`;

// --- the outputs -------------------------------------------------------------------

const categories = sidebar(await read("docs-site/sidebars.ts"));
const order = categories.flatMap((c) => c.ids);
/// Every page in docs/ by its id, which is its path without the extension.
const sources = new Map<string, string>();
const walkDocs = async (rel: string) => {
  for await (const entry of Deno.readDir(rel ? `${DOCS}/${rel}` : DOCS)) {
    const path = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory) await walkDocs(path);
    else if (/\.mdx?$/.test(entry.name)) sources.set(path.replace(/\.mdx?$/, ""), `${DOCS}/${path}`);
  }
};
await walkDocs("");
const missing = [...sources.keys()].filter((id) => !order.includes(id));
const extra = order.filter((id) => !sources.has(id));
if (missing.length || extra.length || new Set(order).size !== order.length) {
  throw new Error(`the sidebar and docs/ disagree: not in the sidebar ${JSON.stringify(missing)}, no page for ${JSON.stringify(extra)}`);
}

const pages = new Map<string, Page>();
for (const id of order) pages.set(id, parse(id, await Deno.readTextFile(sources.get(id)!)));
const urls = new Map([...pages].map(([id, p]) => [id, p.url]));
const intro = pages.get("intro")?.body.split("\n\n")[0];
if (!intro) throw new Error("docs/intro.md has no first paragraph");

const out = new Map<string, string>();
for (const page of pages.values()) {
  const md = document(page, page.body);
  out.set(`${STATIC}/docs/${page.id}.md`, md);
  out.set(`${SKILL_DIR}/references/${page.id}.md`, md);
}

out.set(`${STATIC}/llms.txt`, [
  `# ${siteTitle}`,
  "",
  `> ${tagline}`,
  "",
  intro,
  "",
  `These are the pages of ${SITE} for remesso-sdk ${version}, each as Markdown. All of them in one file: ${SITE}/llms-full.txt. ` +
  `Coding assistants can load them as the remesso-sdk skill: ${SITE}/docs/build-with-ai`,
  "",
  ...categories.flatMap((c) => [
    `## ${c.label}`,
    "",
    ...c.ids.map((id) => `- [${pages.get(id)!.label}](${SITE}/docs/${id}.md): ${pages.get(id)!.description}`),
    "",
  ]),
].join("\n"));

out.set(`${STATIC}/llms-full.txt`, [
  `# ${siteTitle} documentation`,
  "",
  `> ${tagline}`,
  "",
  `Every page of ${SITE} for remesso-sdk ${version}, in the order of its sidebar. Each page starts with a level-1 heading and its URL.`,
  "",
  [...pages.values()].map((p) => document(p, absolute(p, urls))).join("\n---\n\n"),
].join("\n"));

const skill = await read(`${SKILL_DIR}/SKILL.md`);
const [before, rest] = skill.split(START);
const after = rest?.split(END)[1];
if (after === undefined) throw new Error(`${SKILL_DIR}/SKILL.md needs the markers ${START} and ${END}`);
const index = categories.map((c) =>
  `### ${c.label}\n\n${c.ids.map((id) => `- [${pages.get(id)!.label}](references/${id}.md): ${pages.get(id)!.description}`).join("\n")}`
).join("\n\n");
out.set(`${SKILL_DIR}/SKILL.md`, `${before}${START}\n\nThe pages of ${SITE} for remesso-sdk ${version}.\n\n${index}\n\n${END}${after}`);

// --- write, or compare -------------------------------------------------------------

/// Generated files no page produces any more: a removed page's Markdown.
async function stale(dir: string): Promise<string[]> {
  const found: string[] = [];
  const walk = async (rel: string) => {
    let entries: Deno.DirEntry[];
    try {
      entries = await Array.fromAsync(Deno.readDir(`${ROOT}${rel}`));
    } catch (e) {
      if (e instanceof Deno.errors.NotFound) return;
      throw e;
    }
    for (const entry of entries) {
      const path = `${rel}/${entry.name}`;
      if (entry.isDirectory) await walk(path);
      else if (entry.name.endsWith(".md") && !out.has(path)) found.push(path);
    }
  };
  await walk(dir);
  return found;
}
const leftovers = [...await stale(`${STATIC}/docs`), ...await stale(`${SKILL_DIR}/references`)];

let drift = 0;
for (const [path, next] of out) {
  const prev = await Deno.readTextFile(`${ROOT}${path}`).catch(() => null);
  if (prev === next) continue;
  drift++;
  if (check) {
    console.log(`${path}: ${prev === null ? "missing" : "differs"}`);
  } else {
    await Deno.mkdir(`${ROOT}${path.slice(0, path.lastIndexOf("/"))}`, { recursive: true });
    await Deno.writeTextFile(`${ROOT}${path}`, next);
    console.log(`${path}: written`);
  }
}
for (const path of leftovers) {
  drift++;
  if (check) console.log(`${path}: no page makes it any more`);
  else {
    await Deno.remove(`${ROOT}${path}`);
    console.log(`${path}: removed`);
  }
}
console.log(`${pages.size} pages, ${out.size} files: ${drift ? (check ? `${drift} out of date` : `${drift} changed`) : "all current"}`);
if (check && drift) Deno.exit(1);
