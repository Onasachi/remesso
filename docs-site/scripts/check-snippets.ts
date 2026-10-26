/// Type-check every TypeScript code block in the docs against the SDK's own
/// source, so no page shows an API that doesn't exist or a call it can't make.
///
///   deno run --allow-read --allow-write --allow-run --allow-env docs-site/scripts/check-snippets.ts [docs/page.md ...]
///
/// Each ```ts block is checked as its own file. A block can use the clients and
/// ids the guides share without declaring them: `payer`, `receiver`, `agent`
/// and `person` (clients with an account), `reader` (a read-only client),
/// `requestId`, `scheduleId` and `policyId`. Whatever a block declares itself
/// wins. Mark a block ```ts nocheck to skip it.
const ROOT = new URL("../..", import.meta.url).pathname.replace(/\/$/, "");
const DOCS = `${ROOT}/docs-site/docs`;

/// Names a fragment may use undeclared, and what they are.
const CONTEXT: Record<string, string> = {
  payer: "__Remesso & { address: __Address }",
  receiver: "__Remesso & { address: __Address }",
  agent: "__Remesso & { address: __Address }",
  buyer: "__Remesso & { address: __Address }",
  seller: "__Remesso & { address: __Address }",
  person: "__Remesso & { address: __Address }",
  reader: "__Remesso",
  requestId: "string",
  scheduleId: "bigint",
  policyId: "bigint",
};

type Block = { doc: string; line: number; code: string };

async function* walk(dir: string): AsyncGenerator<string> {
  for await (const e of Deno.readDir(dir)) {
    const p = `${dir}/${e.name}`;
    if (e.isDirectory) yield* walk(p);
    else if (/\.mdx?$/.test(e.name)) yield p;
  }
}

/// Fenced ```ts blocks, with the line each starts on. A fence may be indented
/// (inside a <TabItem>); its indentation is removed from the code.
function blocks(doc: string, text: string): Block[] {
  const out: Block[] = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const open = lines[i].match(/^(\s*)(`{3,}|~{3,})\s*(ts|typescript)\b(.*)$/);
    if (!open) continue;
    const [, indent, fence, , meta] = open;
    const body: string[] = [];
    let j = i + 1;
    while (j < lines.length && !lines[j].trimStart().startsWith(fence)) {
      body.push(lines[j].startsWith(indent) ? lines[j].slice(indent.length) : lines[j]);
      j++;
    }
    if (!/\bnocheck\b/.test(meta)) out.push({ doc, line: i + 2, code: body.join("\n") });
    i = j;
  }
  return out;
}

/// The declarations a block needs: the shared names it uses but doesn't declare.
function preamble(code: string): string[] {
  const lines = [
    `import type { Address as __Address } from "viem";`,
    `import type { Remesso as __Remesso } from "remesso-sdk";`,
  ];
  for (const [name, type] of Object.entries(CONTEXT)) {
    const used = new RegExp(`\\b${name}\\b`).test(code);
    const declared = new RegExp(`\\b(const|let|var|function|class)\\s+${name}\\b|[{,]\\s*${name}\\s*[,}]\\s*=`).test(code);
    if (used && !declared) lines.push(`declare const ${name}: ${type};`);
  }
  lines.push("export {};");
  return lines;
}

const only = Deno.args.map((a) => `${ROOT}/docs-site/${a.replace(/^docs-site\//, "")}`);
const docs: string[] = [];
for await (const p of walk(DOCS)) if (!only.length || only.includes(p)) docs.push(p);
docs.sort();

const tmp = await Deno.makeTempDir({ prefix: "remesso-doc-snippets-" });
await Deno.writeTextFile(`${tmp}/deno.json`, JSON.stringify({
  imports: {
    "remesso-sdk": `${ROOT}/packages/remesso-sdk/src/index.ts`,
    "remesso-sdk/node": `${ROOT}/packages/remesso-sdk/src/node.ts`,
    "remesso-sdk/postgres": `${ROOT}/packages/remesso-sdk/src/postgres.ts`,
    "remesso-sdk/dev": `${ROOT}/packages/remesso-sdk/src/dev.ts`,
    "remesso-sdk/tools": `${ROOT}/packages/remesso-sdk/src/tools.ts`,
    "remesso-sdk/signers": `${ROOT}/packages/remesso-sdk/src/signers.ts`,
    "postgres": "npm:postgres@3.4.5",
    "viem": "npm:viem@2.57.7",
    "viem/": "npm:/viem@2.57.7/",
    "@celo/attribution-tags": "npm:@celo/attribution-tags@0.5.0",
  },
  compilerOptions: { types: ["npm:@types/node@22"] },
  lock: false,
}, null, 2));

const files: { path: string; block: Block; offset: number }[] = [];
let n = 0;
for (const doc of docs) {
  for (const block of blocks(doc, await Deno.readTextFile(doc))) {
    const pre = preamble(block.code);
    const path = `${tmp}/snippet-${String(++n).padStart(3, "0")}.ts`;
    await Deno.writeTextFile(path, `${pre.join("\n")}\n${block.code}\n`);
    files.push({ path, block, offset: pre.length });
  }
}

if (!files.length) {
  console.log("no TypeScript blocks to check");
  Deno.exit(0);
}

const run = await new Deno.Command("deno", {
  args: ["check", "--config", `${tmp}/deno.json`, "--unstable-sloppy-imports", ...files.map((f) => f.path)],
  cwd: tmp,
  stdout: "piped",
  stderr: "piped",
}).output();

// Point each error at the page and line it came from.
let report = new TextDecoder().decode(run.stderr) + new TextDecoder().decode(run.stdout);
report = report.replace(/\x1b\[[0-9;]*m/g, "");
for (const f of files) {
  const where = new RegExp(`(?:file://)?${f.path.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}:(\\d+):(\\d+)`, "g");
  report = report.replace(where, (_m, l: string, c: string) =>
    `${f.block.doc.slice(ROOT.length + 1)}:${f.block.line + Number(l) - f.offset - 1}:${c}`);
}
await Deno.remove(tmp, { recursive: true });

const pages = new Set(files.map((f) => f.block.doc)).size;
if (run.success) {
  console.log(`${files.length} TypeScript blocks in ${pages} pages type-check against remesso-sdk`);
} else {
  console.error(report.split("\n").filter((l) => !/^(Check|Download) /.test(l)).join("\n").trim());
  console.error(`\nfailed: TypeScript blocks in docs-site/docs that don't type-check against remesso-sdk`);
  Deno.exit(1);
}
