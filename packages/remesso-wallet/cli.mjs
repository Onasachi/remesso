#!/usr/bin/env node
// `remesso-wallet`         starts the Remesso agent wallet, an MCP server on stdio.
// `remesso-wallet skills`  copies the Remesso skills to ~/.agents/skills (or the
//                          folder given), where Codex and Cursor both look.
//
// The server is the same bundle the Claude plugin ships (server.mjs, built from
// mcp/ in the Remesso repo). Nothing is installed: it has no dependencies.

import { cpSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

if (process.argv[2] === "skills") {
  const dest = resolve(process.argv[3] ?? join(homedir(), ".agents", "skills"));
  mkdirSync(dest, { recursive: true });
  for (const name of readdirSync(join(here, "skills"))) {
    const to = join(dest, name);
    const verb = existsSync(to) ? "updated" : "added";
    // Only our own remesso* folders are written; anything else there is left alone.
    cpSync(join(here, "skills", name), to, { recursive: true, force: true });
    console.log(`${verb} ${to}`);
  }
  console.log("Restart Codex or Cursor to pick them up.");
} else {
  await import("./server.mjs");
}
