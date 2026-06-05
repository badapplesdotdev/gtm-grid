#!/usr/bin/env node
// gtmgrid CLI — drive the engine headlessly: init, connect, build tables/columns, run.

import { readFileSync } from "node:fs";
import { openProject, projectPath, connectAi, parseManifest, type Column } from "@gtmgrid/engine";

interface Args {
  _: string[];
  flags: Record<string, string | boolean>;
  pairs: Record<string, string>; // k=v positional pairs
}

function parse(argv: string[]): Args {
  const _: string[] = [];
  const flags: Record<string, string | boolean> = {};
  const pairs: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        flags[key] = next;
        i++;
      } else flags[key] = true;
    } else if (a.includes("=")) {
      const idx = a.indexOf("=");
      pairs[a.slice(0, idx)] = a.slice(idx + 1);
    } else _.push(a);
  }
  return { _, flags, pairs };
}

function truncate(v: unknown, n = 38): string {
  const s = v == null ? "" : typeof v === "string" ? v : JSON.stringify(v);
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

const HELP = `gtmgrid — local-first programmable GTM spreadsheet

  gtmgrid init <project>
  gtmgrid connect-ai <project> --provider anthropic|openai --key <KEY> [--model <m>]
  gtmgrid connect <project> <extension> key=value [key=value...]
  gtmgrid ext add <project> <manifest.json>     upload a custom extension manifest
  gtmgrid ext ls <project>
  gtmgrid ext rm <project> <extension-id>
  gtmgrid table add <project> <name>
  gtmgrid col add <project> <table> <name> [--fn provider.method] [--code <file>] [--type json] [param=template ...]
  gtmgrid row add <project> <table> [Column=value ...]
  gtmgrid run <project> <table> [columnName] [--force] [--concurrency N]
  gtmgrid ls <project>
  gtmgrid show <project> <table>

Function columns: --fn ai.generate prompt="Bio for {{Name}}"
                  --fn github.getUser username="{{Username}}"
                  --code ./my.js  gh="{{GitHub}}"   (custom QuickJS body)`;

async function main() {
  const { _, flags, pairs } = parse(process.argv.slice(2));
  const [cmd, sub, ...rest] = _;

  if (!cmd || cmd === "help" || flags.help) {
    console.log(HELP);
    return;
  }

  // init
  if (cmd === "init") {
    const name = sub!;
    const { db } = openProject(name);
    console.log(`Initialised project "${name}" at ${projectPath(name)}`);
    db.close();
    return;
  }

  if (cmd === "connect-ai") {
    const name = sub!;
    const { db } = openProject(name);
    const provider = String(flags.provider ?? "anthropic") as "anthropic" | "openai";
    const key = String(flags.key ?? "");
    if (!key) throw new Error("--key is required");
    connectAi(db, provider, key, flags.model ? String(flags.model) : undefined);
    console.log(`Connected AI provider "${provider}" (key stored encrypted).`);
    db.close();
    return;
  }

  if (cmd === "connect") {
    const name = sub!;
    const extension = rest[0]!;
    const { db } = openProject(name);
    if (Object.keys(pairs).length === 0) throw new Error("provide secrets as key=value");
    db.saveCredential({ extensionId: extension, scope: "local", name: "default", secrets: pairs });
    console.log(`Saved credential for "${extension}" (encrypted): ${Object.keys(pairs).join(", ")}`);
    db.close();
    return;
  }

  if (cmd === "ext" && sub === "add") {
    const [name, manifestFile] = rest;
    const { db } = openProject(name!);
    const manifest = parseManifest(readFileSync(manifestFile!, "utf8"));
    db.saveExtension(manifest as any);
    console.log(`Uploaded extension "${manifest.name}" (${manifest.id}) — ${manifest.methods.length} methods:`);
    for (const m of manifest.methods) console.log(`   • sdk.${manifest.id}.${m.id} — ${m.label ?? m.id}`);
    db.close();
    return;
  }

  if (cmd === "ext" && (sub === "ls" || sub === "list")) {
    const { db } = openProject(rest[0]!);
    const exts = db.listExtensions();
    if (exts.length === 0) console.log("No custom extensions uploaded.");
    for (const e of exts as any[]) {
      const cred = db.getCredential(e.id);
      console.log(`🧩 ${e.name} (${e.id}) — ${e.methods.length} methods ${cred ? "· 🔑 connected" : "· no credential"}`);
    }
    db.close();
    return;
  }

  if (cmd === "ext" && (sub === "rm" || sub === "remove")) {
    const { db } = openProject(rest[0]!);
    db.deleteExtension(rest[1]!);
    console.log(`Removed extension "${rest[1]}"`);
    db.close();
    return;
  }

  if (cmd === "table" && sub === "add") {
    const name = rest[0]!;
    const tableName = rest[1]!;
    const { db } = openProject(name);
    const t = db.createTable(tableName);
    console.log(`Created table "${t.name}" (${t.id})`);
    db.close();
    return;
  }

  if (cmd === "col" && sub === "add") {
    const [name, tableName, colName] = rest;
    const { db } = openProject(name);
    const table = db.resolveTable(tableName!);
    if (!table) throw new Error(`no table "${tableName}"`);
    let provider: string | null = null;
    let method: string | null = null;
    if (flags.fn) {
      const [p, m] = String(flags.fn).split(".");
      provider = p;
      method = m;
    }
    const code = flags.code ? readFileSync(String(flags.code), "utf8") : null;
    const kind = provider || code ? "function" : "manual";
    const col = db.createColumn({
      tableId: table.id,
      name: colName!,
      type: (flags.type as any) ?? "text",
      kind,
      provider,
      method,
      code,
      params: pairs,
    });
    console.log(`Added ${kind} column "${col.name}"${provider ? ` [${provider}.${method}]` : ""}`);
    db.close();
    return;
  }

  if (cmd === "row" && sub === "add") {
    const [name, tableName] = rest;
    const { db } = openProject(name);
    const table = db.resolveTable(tableName!);
    if (!table) throw new Error(`no table "${tableName}"`);
    const row = db.createRow(table.id);
    for (const [colName, val] of Object.entries(pairs)) {
      const col = db.resolveColumn(table.id, colName);
      if (!col) throw new Error(`no column "${colName}"`);
      db.setCell(row.id, col.id, { value: val, status: "done" });
    }
    console.log(`Added row ${row.id} (${Object.keys(pairs).length} cells)`);
    db.close();
    return;
  }

  if (cmd === "run") {
    const name = sub;
    const tableName = rest[0];
    const colName = rest[1];
    const { db, engine } = openProject(name!);
    const table = db.resolveTable(tableName!);
    if (!table) throw new Error(`no table "${tableName}"`);
    const cols = db.listColumns(table.id).filter((c) => c.kind === "function");
    const targets = colName ? cols.filter((c) => c.name === colName || c.id === colName) : cols;
    if (targets.length === 0) throw new Error("no matching function columns to run");
    const concurrency = flags.concurrency ? Number(flags.concurrency) : 5;
    for (const col of targets) {
      process.stdout.write(`Running "${col.name}"… `);
      const res = await engine.runColumn(col.id, { concurrency, force: !!flags.force });
      console.log(`done: ${res.ran} ran, ${res.errors} errors`);
    }
    db.close();
    return;
  }

  if (cmd === "ls") {
    const { db } = openProject(sub!);
    for (const t of db.listTables()) {
      const cols = db.listColumns(t.id);
      const rows = db.listRows(t.id);
      console.log(`📋 ${t.name} — ${rows.length} rows, ${cols.length} columns`);
      for (const c of cols) {
        console.log(`   • ${c.name} [${c.kind}${c.provider ? `:${c.provider}.${c.method}` : c.code ? ":code" : ""}]`);
      }
    }
    db.close();
    return;
  }

  if (cmd === "show") {
    const { db } = openProject(sub!);
    const table = db.resolveTable(rest[0]!);
    if (!table) throw new Error(`no table "${rest[0]}"`);
    const cols = db.listColumns(table.id);
    const header = ["#", ...cols.map((c) => c.name)];
    const widths = header.map((h) => h.length);
    const rows = db.listRows(table.id);
    const matrix: string[][] = rows.map((r, i) => {
      const cells = db.rowCells(r.id);
      const line = [String(i + 1), ...cols.map((c) => cellText(cells.get(c.id), c))];
      line.forEach((v, idx) => (widths[idx] = Math.max(widths[idx], v.length)));
      return line;
    });
    const fmt = (cells: string[]) => cells.map((v, i) => v.padEnd(widths[i])).join("  ");
    console.log(fmt(header));
    console.log(widths.map((w) => "─".repeat(w)).join("  "));
    for (const line of matrix) console.log(fmt(line));
    db.close();
    return;
  }

  console.log(HELP);
}

function cellText(cell: ReturnType<import("@gtmgrid/engine").Db["getCell"]>, _col: Column): string {
  if (!cell) return "·";
  if (cell.status === "error") return "⚠ " + truncate(cell.error, 30);
  if (cell.status === "running") return "…";
  return truncate(cell.value);
}

main().catch((e) => {
  console.error("Error:", e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
