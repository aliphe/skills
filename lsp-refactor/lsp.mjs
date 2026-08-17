#!/usr/bin/env node
// lsp-refactor runner — one-shot Language Server Protocol client.
// Spawns a language server, performs one requested operation, shuts down.
// No dependencies; runs on any node >= 18.
//
// JSON-RPC framing/client adapted from pi-subagents' watchdog LSP client
// (https://github.com/…/pi-subagents/src/watchdog/lsp-diagnostics.ts).

import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_PROBE_FILES = 10;
const MAX_PROBE_OCCURRENCES = 8;
const WALK_FILE_LIMIT = 4000;
const MAX_FILE_SIZE = 2 * 1024 * 1024;
const ALWAYS_SKIP = new Set([
  "node_modules", ".git", ".hg", ".svn", "vendor", "dist", "build", "out",
  "target", ".next", ".nuxt", "coverage", ".cache", "__pycache__", ".venv",
  "venv", ".terraform", ".idea", ".vscode", ".DS_Store", ".turbo", ".tap",
]);

const EXTS = {
  go: new Set([".go"]),
  typescript: new Set([".ts", ".tsx", ".mts", ".cts", ".d.ts"]),
  cpp: new Set([".c", ".cc", ".cpp", ".cxx", ".h", ".hpp", ".hxx", ".m", ".mm"]),
};

// ---------------------------------------------------------------------------
// small utilities

function log(msg) {
  process.stdout.write(msg.endsWith("\n") ? msg : msg + "\n");
}

function warn(msg) {
  process.stderr.write(`warn: ${msg}\n`);
}

function fail(msg, code = 1) {
  process.stderr.write(`error: ${msg}\n`);
  process.exit(code);
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function toPos(line1, col1) {
  return { line: Math.max(0, line1 - 1), character: Math.max(0, col1 - 1) };
}

function formatPos(p) {
  return `${p.line + 1}:${p.character + 1}`;
}

function uriToPath(uri) {
  try {
    if (uri.startsWith("file://")) return fileURLToPath(uri);
  } catch {
    /* fallthrough */
  }
  return uri;
}

function isInside(root, p) {
  const rel = path.relative(root, p);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

function fileExcerpt(file, range, context = 1) {
  try {
    const lines = fs.readFileSync(file, "utf-8").split("\n");
    const from = Math.max(0, range.start.line - context);
    const to = Math.min(lines.length - 1, range.end.line + context);
    return lines
      .slice(from, to + 1)
      .map((l, i) => `${range.start.line - context + i + 1}: ${l}`)
      .join("\n");
  } catch {
    return "";
  }
}

// ---------------------------------------------------------------------------
// language & server detection

function detectLanguage(root) {
  if (fs.existsSync(path.join(root, "go.mod"))) return "go";
  for (const d of [root]) {
    const entries = safeReaddir(d);
    if (entries) {
      if (entries.has("tsconfig.json") || entries.has("tsconfig.base.json")) return "typescript";
      if (entries.has("package.json") || entries.has("compile_commands.json")) {
        if (entries.has("compile_commands.json") || entries.has("CMakeLists.txt")) return "cpp";
      }
    }
  }
  // fall back to extension scan
  let found = null;
  walkFiles(root, Object.keys(EXTS).flatMap((k) => [...EXTS[k]]), 500).some((f) => {
    const ext = path.extname(f);
    for (const [lang, exts] of Object.entries(EXTS)) {
      if (exts.has(ext)) {
        found = lang;
        return true;
      }
    }
    return false;
  });
  return found;
}

function safeReaddir(dir) {
  try {
    return new Set(fs.readdirSync(dir));
  } catch {
    return null;
  }
}

function findBin(candidates) {
  for (const c of candidates) {
    try {
      fs.accessSync(c, fs.constants.X_OK);
      return c;
    } catch {
      /* try next */
    }
  }
  return null;
}

function resolveServer(root, lang) {
  if (lang === "go") {
    const gb = process.env.GOBIN;
    return findBin([
      ...(process.env.PATH || "").split(path.delimiter).map((d) => path.join(d, "gopls")).filter(Boolean),
      ...(gb ? [path.join(gb, "gopls")] : []),
      path.join(os.homedir(), "go", "bin", "gopls"),
    ]);
  }
  if (lang === "typescript") {
    // walk up from the target root to a repo root looking for a local install
    let dir = root;
    while (true) {
      const local = path.join(dir, "node_modules", ".bin", "typescript-language-server");
      if (fs.existsSync(local)) return local;
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
    return findBin(
      (process.env.PATH || "").split(path.delimiter)
        .map((d) => path.join(d, "typescript-language-server"))
        .filter(Boolean),
    );
  }
  if (lang === "cpp") {
    return findBin(
      (process.env.PATH || "").split(path.delimiter).map((d) => path.join(d, "clangd")).filter(Boolean),
    );
  }
  return null;
}

function serverCommand(bin, lang) {
  if (lang === "go") return { bin, args: ["-mode=stdio"] };
  if (lang === "typescript") return { bin, args: ["--stdio"] };
  if (lang === "cpp") return { bin, args: ["--background-index"] };
  return { bin, args: [] };
}

function serverVersion(bin, lang) {
  try {
    const args = lang === "go" ? ["version"] : ["--version"];
    return String(execFileSync(bin, args, { encoding: "utf-8" })).trim().split("\n")[0];
  } catch {
    return "unknown";
  }
}

// ---------------------------------------------------------------------------
// workspace file walk + identifier lookup

function walkFiles(root, exts, limit = WALK_FILE_LIMIT) {
  const out = [];
  const stack = [root];
  while (stack.length && out.length < limit) {
    const dir = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (e.isDirectory()) {
        if (ALWAYS_SKIP.has(e.name)) continue;
        stack.push(path.join(dir, e.name));
      } else if (e.isFile() && exts.includes(path.extname(e.name))) {
        out.push(path.join(dir, e.name));
      }
    }
  }
  return out;
}

function fileContains(f, name) {
  try {
    const st = fs.statSync(f);
    if (st.size > MAX_FILE_SIZE) return false;
    const buf = fs.readFileSync(f);
    if (buf.includes(0)) return false; // binary
    const text = buf.toString("utf-8");
    return new RegExp(`\\b${escapeRe(name)}\\b`).test(text);
  } catch {
    return false;
  }
}

function occurrencesInFile(file, name) {
  const text = fs.readFileSync(file, "utf-8");
  const re = new RegExp(`\\b${escapeRe(name)}\\b`, "g");
  const lines = text.split("\n");
  const hits = [];
  for (let i = 0; i < lines.length && hits.length < MAX_PROBE_OCCURRENCES; i++) {
    for (const m of lines[i].matchAll(re)) {
      hits.push({ line: i, character: m.index });
      if (hits.length >= MAX_PROBE_OCCURRENCES) break;
    }
  }
  return { hits, size: text.length };
}

function findCandidateFiles(root, lang, name) {
  const exts = EXTS[lang] || new Set();
  const files = walkFiles(root, [...exts]);
  const hits = [];
  for (const f of files) {
    if (fileContains(f, name)) {
      hits.push(f);
      if (hits.length >= MAX_PROBE_FILES) break;
    }
  }
  return hits;
}

// ---------------------------------------------------------------------------
// JSON-RPC over stdio

const MAX_STDERR = 2000;

class LspClient {
  constructor(child) {
    this.child = child;
    this.nextId = 1;
    this.pending = new Map();
    this.stdoutBuffer = Buffer.alloc(0);
    this.stderr = "";
    this.exited = false;
    child.stdout.on("data", (c) => this.onData(c));
    child.stderr.on("data", (c) => {
      this.stderr = `${this.stderr}${c.toString("utf-8")}`.slice(-MAX_STDERR);
    });
    child.on("error", (e) => {
      this.exited = true;
      this.rejectAll(e);
    });
    child.on("exit", (code, signal) => {
      this.exited = true;
      this.rejectAll(new Error(`server exited${code === null ? "" : ` (${code})`}${signal ? ` signal=${signal}` : ""}`));
    });
  }

  request(method, params, timeoutMs = DEFAULT_TIMEOUT_MS) {
    if (this.exited) return Promise.reject(new Error("server already exited"));
    const id = this.nextId++;
    const p = new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.send({ jsonrpc: "2.0", id, method, params });
    });
    return withTimeout(p, timeoutMs, `${method} timed out after ${timeoutMs}ms`);
  }

  notify(method, params) {
    if (this.exited) return;
    this.send({ jsonrpc: "2.0", method, params });
  }

  send(msg) {
    const body = JSON.stringify(msg);
    this.child.stdin.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
  }

  onData(chunk) {
    this.stdoutBuffer = Buffer.concat([this.stdoutBuffer, chunk]);
    for (;;) {
      const sep = this.stdoutBuffer.indexOf("\r\n\r\n");
      if (sep === -1) return;
      const header = this.stdoutBuffer.slice(0, sep).toString("utf-8");
      const m = header.match(/content-length:\s*(\d+)/i);
      if (!m) return;
      const len = Number(m[1]);
      const bodyStart = sep + 4;
      if (this.stdoutBuffer.length < bodyStart + len) return;
      const body = this.stdoutBuffer.slice(bodyStart, bodyStart + len).toString("utf-8");
      this.stdoutBuffer = this.stdoutBuffer.slice(bodyStart + len);
      try {
        this.onMessage(JSON.parse(body));
      } catch (e) {
        this.rejectAll(new Error(`invalid JSON-RPC message: ${e.message}`));
        return;
      }
    }
  }

  onMessage(msg) {
    if (msg.id === undefined || msg.id === null) return; // server -> client notif (e.g. window/logMessage)
    const p = this.pending.get(msg.id);
    if (!p) return;
    this.pending.delete(msg.id);
    if (msg.error) p.reject(new Error(msg.error.message || `request ${msg.method} failed`));
    else p.resolve(msg.result);
  }

  stderrTail() {
    return this.stderr.trim();
  }

  rejectAll(err) {
    for (const p of this.pending.values()) p.reject(err);
    this.pending.clear();
  }

  async shutdown(timeoutMs = 3000) {
    if (this.exited) return;
    try {
      await this.request("shutdown", null, timeoutMs);
      this.notify("exit", null);
    } catch {
      /* already exiting */
    }
    try {
      this.child.kill("SIGTERM");
    } catch {
      /* ignore */
    }
  }
}

function withTimeout(promise, ms, message) {
  let timer;
  return new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

// ---------------------------------------------------------------------------
// session

async function openSession(root, lang, bin, extraTimeout) {
  const { bin: binPath, args } = serverCommand(bin, lang);
  const child = spawn(binPath, args, {
    cwd: root,
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, NO_COLOR: "1" },
  });
  const client = new LspClient(child);
  const rootUri = pathToFileURL(path.resolve(root)).href;
  const timeout = (extraTimeout || DEFAULT_TIMEOUT_MS);
  try {
    const init = await client.request(
      "initialize",
      initParams(root, rootUri),
      timeout,
    );
    client.notify("initialized", {});
    return { client, rootUri, timeout, capabilities: init?.capabilities || {} };
  } catch (e) {
    const tail = client.stderrTail();
    await client.shutdown();
    throw new Error(`${e.message}${tail ? ` — server: ${tail}` : ""}`);
  }
}

const opened = new Set();

async function openFile(client, root, file) {
  const abs = path.resolve(root, file);
  if (opened.has(abs)) return;
  opened.add(abs);
  const text = fs.readFileSync(abs, "utf-8");
  const langId = languageIdFor(path.extname(abs));
  client.notify("textDocument/didOpen", {
    textDocument: { uri: pathToFileURL(abs).href, languageId: langId, version: 1, text },
  });
}

// Open every source file in the workspace so the server's program/workspace
// model includes them (editors do this; required for cross-file renames).
async function openAllFiles(ctx, limit = 2000) {
  const exts = EXTS[ctx.lang] || new Set();
  const files = walkFiles(ctx.root, [...exts], limit);
  for (const f of files) await openFile(ctx.client, ctx.root, f);
}

function languageIdFor(ext) {
  switch (ext) {
    case ".go": return "go";
    case ".ts": return "typescript";
    case ".tsx": return "typescriptreact";
    case ".mts":
    case ".cts":
    case ".d.ts": return "typescript";
    case ".c":
    case ".h": return "c";
    case ".cpp":
    case ".cc":
    case ".cxx":
    case ".hpp":
    case ".hxx": return "cpp";
    case ".m":
    case ".mm": return "objective-cpp";
    default: return "plaintext";
  }
}

// ---------------------------------------------------------------------------
// symbol position resolution

// Returns { uri, pos (0-based), range (word range), file (abs) } or null.
async function probePosition(client, root, rootUri, file, name) {
  const uri = pathToFileURL(path.resolve(root, file)).href;
  await openFile(client, root, file);
  const { hits } = occurrencesInFile(file, name);
  let firstError = null;
  for (const { line, character } of hits) {
    try {
      const prepared = await client.request(
        "textDocument/prepareRename",
        { textDocument: { uri }, position: { line, character } },
        15_000,
      );
      if (prepared && prepared.range?.start) {
        return { uri, pos: { line, character }, range: prepared.range, file };
      }
    } catch (e) {
      if (!firstError) firstError = e.message;
      // prepareRename rejects when the position is not a renameable symbol —
      // that's exactly the validation we want; try the next occurrence.
      if (/no symbol|not renameable|invalid.*position|not.*rename/i.test(e.message)) continue;
      throw e;
    }
  }
  // fallback: even without rename support, use the first occurrence as a position
  if (hits.length) return { uri, pos: hits[0], range: { start: hits[0], end: hits[0] }, file };
  if (firstError) warn(`prepareRename: ${firstError}`);
  return null;
}

async function resolveTarget(ctx, input, fileArg) {
  // explicit FILE:LINE[:COL] in either the positional or the --file argument
  for (const candidate of [input, fileArg].filter(Boolean)) {
    const m = String(candidate).match(/^(.+?):(\d+)(?::(\d+))?$/);
    if (!m) continue;
    const abs = path.resolve(ctx.root, m[1]);
    if (fs.existsSync(abs)) {
      const pos = toPos(Number(m[2]), m[3] ? Number(m[3]) : 1);
      const uri = pathToFileURL(abs).href;
      await openFile(ctx.client, ctx.root, abs);
      return { uri, pos, range: { start: pos, end: pos }, file: abs };
    }
  }
  if (!input) fail(`need a NAME or FILE:LINE:COL`);
  const name = input;
  const candidates = fileArg ? [path.resolve(ctx.root, fileArg)] : findCandidateFiles(ctx.root, ctx.lang, name);
  if (!candidates.length) fail(`no file in the workspace contains "${name}" — give a FILE:LINE:COL instead`);
  for (const file of candidates.slice(0, MAX_PROBE_FILES)) {
    const probe = await probePosition(ctx.client, ctx.root, ctx.rootUri, file, name);
    if (probe) return probe;
  }
  fail(`could not locate a symbol for "${name}" — pass FILE:LINE:COL explicitly`);
}

// ---------------------------------------------------------------------------
// applying workspace edits

function collectEdits(workspaceEdit, rootDir) {
  const files = new Map(); // absPath -> edits[]
  const skipped = [];
  const visit = (uri, edits, label) => {
    if (!Array.isArray(edits) || !edits.length) return;
    const p = uriToPath(uri);
    if (!isInside(rootDir, p)) {
      skipped.push(`${p} (outside workspace)`);
      return;
    }
    const list = files.get(p) || [];
    list.push(...edits.map((e) => ({ ...e, label })));
    files.set(p, list);
  };
  if (workspaceEdit?.changes) {
    for (const [uri, edits] of Object.entries(workspaceEdit.changes)) visit(uri, edits, "");
  }
  for (const entry of workspaceEdit?.documentChanges || []) {
    if (entry.kind === "create" || entry.kind === "rename" || entry.kind === "delete") {
      skipped.push(`${entry.kind} ${entry.uri || entry.oldUri || "?"} (file-op — not applied)`);
      continue;
    }
    visit(entry.textDocument?.uri, entry.edits, "");
  }
  return { files, skipped };
}

function applyToFile(abs, edits, dryRun) {
  const sorted = [...edits].sort((a, b) =>
    b.range.start.line - a.range.start.line || b.range.start.character - a.range.start.character,
  );
  const original = fs.readFileSync(abs, "utf-8");
  let text = original;
  const offsetOf = (p) => {
    const lines = text.split("\n");
    let off = 0;
    for (let i = 0; i < p.line; i++) off += lines[i].length + 1;
    return off + p.character;
  };
  const applied = [];
  for (const e of sorted) {
    const start = offsetOf(e.range.start);
    const end = offsetOf(e.range.end);
    if (end < start) { warn(`skipping malformed edit in ${abs}`); continue; }
    text = text.slice(0, start) + e.newText + text.slice(end);
    applied.push(e);
  }
  if (!dryRun && applied.length && text !== original) {
    fs.writeFileSync(abs, text);
  }
  return { changed: text !== original, applied, original };
}

function formatEditDiff(abs, applied, original) {
  const out = [];
  const lines = original.split("\n");
  const ordered = [...applied].sort(
    (a, b) => a.range.start.line - b.range.start.line || a.range.start.character - b.range.start.character,
  );
  for (const e of ordered) {
    const { start, end } = e.range;
    if (start.line === end.line) {
      const line = lines[start.line] ?? "";
      const newLine = line.slice(0, start.character) + e.newText + line.slice(end.character);
      const num = start.line + 1;
      out.push(`- ${num}: ${line}`);
      out.push(`+ ${num}: ${newLine}`);
    } else {
      const oldText = lines.slice(start.line, end.line + 1).join("\n");
      out.push(`- ${start.line + 1}: ${oldText}`);
      const pad = `+ ${start.line + 1}: `;
      out.push(pad + e.newText.replace(/\n/g, `\n${pad}`));
    }
  }
  return out.join("\n");
}

async function applyWorkspaceEdit(ctx, workspaceEdit, dryRun) {
  const { files, skipped } = collectEdits(workspaceEdit, ctx.root);
  if (skipped.length) warn(`skipped: ${skipped.join("; ")}`);
  if (!files.size) {
    log("no file edits returned by the server" + (skipped.length ? " (all were skipped)" : ""));
    return;
  }
  let total = 0;
  for (const [abs, edits] of files) {
    const { changed, applied, original } = applyToFile(abs, edits, dryRun);
    total += applied.length;
    log(`\n${dryRun ? "[dry-run] " : ""}${path.relative(ctx.root, abs) || abs} — ${applied.length} edit(s)`);
    if (changed || dryRun) log(formatEditDiff(abs, applied, original));
  }
  log(`\n${dryRun ? "would apply" : "applied"} ${total} edit(s) across ${files.size} file(s)`);
  if (!dryRun && fs.existsSync(path.join(ctx.root, ".git"))) {
    try {
      const out = String(execFileSync("git", ["diff", "--stat"], { cwd: ctx.root, encoding: "utf-8" }));
      if (out.trim()) log(`\n${out.trim()}`);
    } catch {
      /* ignore */
    }
  }
  return files.size;
}

// ---------------------------------------------------------------------------
// actions

async function actionDetect(ctx) {
  log(`root: ${ctx.root}`);
  log(`language: ${ctx.lang || "unknown (no project markers found)"}`);
  if (!ctx.lang) return;
  const bin = resolveServer(ctx.root, ctx.lang);
  if (!bin) {
    const hint =
      ctx.lang === "typescript"
        ? `install it in the project: pnpm add -Dw typescript-language-server (or npm i -D typescript-language-server)`
        : ctx.lang === "go"
          ? `install it: go install golang.org/x/tools/gopls@latest`
          : `make ${ctx.lang === "cpp" ? "clangd" : "the server"} available on PATH`;
    fail(`${ctx.lang} server not found — ${hint}`);
  }
  log(`server: ${path.basename(bin)}`);
  log(`bin: ${bin}`);
  log(`version: ${serverVersion(bin, ctx.lang)}`);
}

async function actionCaps(ctx, opts) {
  if (!ctx.lang) fail("cannot detect language in this directory — run from a Go/TS/C++ project or pass --root");
  const bin = resolveServer(ctx.root, ctx.lang);
  if (!bin) fail(`no ${ctx.lang} server found (run 'lsp.mjs detect')`);
  log(`requesting capabilities from ${path.basename(bin)} …`);
  const session = await openSession(ctx.root, ctx.lang, bin);
  try {
    const caps = session.capabilities;
    const interesting = pickCapabilities(caps);
    log(`\n== provider summary ==`);
    for (const [k, v] of Object.entries(interesting)) {
      log(`${k}: ${typeof v === "object" && v !== null ? JSON.stringify(v) : String(v)}`);
    }
    if (opts.json) log(`\n== raw ==\n${JSON.stringify(caps, null, 2)}`);
  } finally {
    await session.client.shutdown();
  }
}

function initParams(root, rootUri) {
  return {
    processId: process.pid,
    rootUri,
    workspaceFolders: [{ uri: rootUri, name: path.basename(root) || "workspace" }],
    capabilities: {
      textDocument: {
        publishDiagnostics: { relatedInformation: false, versionSupport: true },
        rename: { prepareSupport: true },
        references: {},
        definition: {},
        typeDefinition: {},
        implementation: {},
        documentSymbol: { hierarchicalDocumentSymbolSupport: true },
        codeAction: {},
        hover: {},
        callHierarchy: {},
        inlayHint: {},
        semanticTokens: {},
      },
      workspace: { workspaceFolders: true, symbol: {} },
    },
  };
}

function pickCapabilities(caps) {
  const keys = [
    "renameProvider", "referencesProvider", "definitionProvider", "typeDefinitionProvider",
    "implementationProvider", "documentSymbolProvider", "workspaceSymbolProvider",
    "codeActionProvider", "hoverProvider", "callHierarchyProvider", "inlayHintProvider",
    "semanticTokensProvider", "documentHighlightProvider", "executeCommandProvider",
    "documentFormattingProvider", "selectionRangeProvider", "foldingRangeProvider",
  ];
  const out = {};
  for (const k of keys) if (caps[k] !== undefined && caps[k] !== null && caps[k] !== false) out[k] = caps[k];
  return out;
}

const positionNeeds = ["rename", "refs", "def", "impl", "callers", "hover", "codeaction"];

async function actionRename(ctx, args, opts) {
  const [oldName, newName, maybeFile] = args;
  if (!oldName || !newName) fail("usage: rename OLD NEW [FILE] [--dry-run]");
  const target = await resolveTarget(ctx, oldName, maybeFile || opts.file);
  log(`symbol: "${oldName}" at ${path.relative(ctx.root, target.file) || target.file}:${formatPos(target.pos)}`);
  await openAllFiles(ctx);
  const result = await ctx.client.request(
    "textDocument/rename",
    { textDocument: { uri: target.uri }, position: target.pos, newName },
    ctx.timeout,
  );
  if (!result) fail("server returned no workspace edit");
  await applyWorkspaceEdit(ctx, result, opts.dryRun);
  if (!opts.dryRun) log(`\nrenamed "${oldName}" → "${newName}"`);
}

async function actionRefs(ctx, args, opts) {
  const [input] = args;
  const target = await resolveTarget(ctx, input, opts.file);
  const refs = await ctx.client.request(
    "textDocument/references",
    { textDocument: { uri: target.uri }, position: target.pos, context: { includeDeclaration: true } },
    ctx.timeout,
  );
  printLocations(ctx, refs || [], "reference");
}

function printLocations(ctx, locations, label) {
  if (!locations || !locations.length) {
    log(`no ${label}s found`);
    return;
  }
  log(`${locations.length} ${label}(s):`);
  for (const loc of locations) {
    const p = uriToPath(loc.uri);
    const rel = path.relative(ctx.root, p).replace(/^\.\.\//, "");
    log(`  ${rel}:${formatPos(loc.range.start)}${loc.range.start.line !== loc.range.end.line ? `-${formatPos(loc.range.end)}` : ""}`);
  }
}

async function jumpAction(ctx, method, args, opts, label) {
  const [input] = args;
  const target = await resolveTarget(ctx, input, opts.file);
  const result = await ctx.client.request(method, {
    textDocument: { uri: target.uri },
    position: target.pos,
  }, ctx.timeout);
  if (Array.isArray(result) && result.length && result[0].targetUri) {
    // LocationLink[]
    for (const l of result) {
      const p = uriToPath(l.targetUri);
      log(`${path.relative(ctx.root, p)}:${formatPos(l.targetRange?.start || l.targetSelectionRange?.start)}`);
    }
  } else {
    printLocations(ctx, result || [], label);
  }
}

async function actionOutline(ctx, args, opts) {
  const file = args[0] || opts.file;
  if (!file) fail("usage: outline FILE");
  const abs = path.resolve(ctx.root, file);
  if (!fs.existsSync(abs)) fail(`file not found: ${abs}`);
  const uri = pathToFileURL(abs).href;
  await openFile(ctx.client, ctx.root, abs);
  const result = await ctx.client.request("textDocument/documentSymbol", { textDocument: { uri } }, ctx.timeout);
  const items = result || [];
  const print = (symbols, depth) => {
    for (const s of symbols) {
      if (s.range && s.selectionRange) {
        // hierarchical DocumentSymbol
        log(`${"  ".repeat(depth)}${s.name}  (${s.kindName || kindName(s.kind)})  ${formatPos(s.range.start)}`);
        if (s.children?.length) print(s.children, depth + 1);
      } else {
        // flat SymbolInformation
        log(`${"  ".repeat(depth)}${s.name}  (${s.kindName || kindName(s.kind)})  ${formatPos(s.location.range.start)}`);
      }
    }
  };
  if (!items.length) {
    log("no symbols");
    return;
  }
  print(items, 0);
}

function kindName(kind) {
  const names = [
    "", "File", "Module", "Namespace", "Package", "Class", "Method", "Property",
    "Field", "Constructor", "Enum", "Interface", "Function", "Variable", "Constant",
    "String", "Number", "Boolean", "Array", "Object", "Key", "Null", "EnumMember",
    "Struct", "Event", "Operator", "TypeParameter",
  ];
  return names[kind] || `kind(${kind})`;
}

async function actionSymbols(ctx, args) {
  const [query] = args;
  if (!query) fail("usage: symbols QUERY");
  const result = await ctx.client.request("workspace/symbol", { query }, ctx.timeout);
  const items = result || [];
  if (!items.length) {
    log(`no symbols match "${query}"`);
    return;
  }
  for (const s of items.slice(0, 50)) {
    const loc = s.location || {};
    const p = uriToPath(loc.uri);
    const rel = path.relative(ctx.root, p).replace(/^\.\.\//, "");
    log(`${s.containerName ? s.containerName + "." : ""}${s.name}  (${kindName(s.kind)})  ${rel}:${formatPos(loc.range?.start)}`);
  }
  if (items.length > 50) log(`… ${items.length - 50} more — refine the query`);
}

async function actionCallers(ctx, args, opts) {
  const [input] = args;
  const target = await resolveTarget(ctx, input, opts.file);
  const items = (await ctx.client.request("textDocument/prepareCallHierarchy", {
    textDocument: { uri: target.uri },
    position: target.pos,
  }, ctx.timeout)) || [];
  if (!items.length) {
    log("no call hierarchy for this position");
    return;
  }
  for (const item of items.slice(0, 10)) {
    const incoming = (await ctx.client.request("callHierarchy/incomingCalls", { item }, ctx.timeout)) || [];
    if (!incoming.length) {
      log(`no callers of ${item.name}`);
      continue;
    }
    log(`callers of ${item.name}:`);
    const seen = new Set();
    for (const c of incoming) {
      const key = `${c.from.uri}:${formatPos(c.fromRange?.[0]?.start || c.from.range?.start)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const p = uriToPath(c.from.uri);
      const rel = path.relative(ctx.root, p).replace(/^\.\.\//, "");
      const start = c.fromRange?.[0]?.start || c.from.range?.start;
      log(`  ${c.from.name}  ${rel}:${formatPos(start)}`);
    }
  }
}

async function actionHover(ctx, args, opts) {
  const [input] = args;
  const target = await resolveTarget(ctx, input, opts.file);
  const result = await ctx.client.request("textDocument/hover", {
    textDocument: { uri: target.uri },
    position: target.pos,
  }, ctx.timeout);
  if (!result?.contents) {
    log("no hover info");
    return;
  }
  const c = result.contents;
  if (c.kind) log(String(c.value ?? ""));
  else if (Array.isArray(c)) for (const part of c) log(String(part.value ?? part));
  else log(String(c));
}

async function actionCodeAction(ctx, args, opts) {
  const [input] = args;
  const target = await resolveTarget(ctx, input, opts.file);
  await openAllFiles(ctx);
  const result = await ctx.client.request("textDocument/codeAction", {
    textDocument: { uri: target.uri },
    range: { start: target.range.start, end: target.range.end },
    context: { diagnostics: [] },
  }, ctx.timeout);
  const actions = result || [];
  if (!actions.length) {
    log("no code actions at this position");
    return;
  }
  log(`code actions at ${path.relative(ctx.root, target.file) || target.file}:${formatPos(target.pos)}:`);
  actions.forEach((a, i) => {
    const hasEdit = !!a.edit?.changes || !!a.edit?.documentChanges?.length;
    log(`  [${i}] ${a.title}${a.kind ? `  (${a.kind})` : ""}${hasEdit ? "" : "  (command — needs editor)"}`);
  });
  if (opts.apply !== undefined) {
    const idx = Number(opts.apply);
    const action = actions[idx];
    if (!action) fail(`no action at index ${idx}`);
    if (action.edit && (action.edit.changes || action.edit.documentChanges)) {
      await applyWorkspaceEdit(ctx, action.edit, opts.dryRun);
      log(`applied code action: ${action.title}`);
    } else {
      fail(`action "${action.title}" has no editable result (server-side command) — cannot apply one-shot`);
    }
  }
}

// ---------------------------------------------------------------------------
// CLI

const USAGE = `lsp-refactor — one-shot Language Server Protocol operations

usage: node lsp.mjs <action> [args...] [options]

actions:
  detect                        print language, server binary and version
  caps [--json]                 print capabilities the server advertises
  rename OLD NEW [FILE]         validated symbol rename (applies edits)
  refs NAME [FILE]              find all references (incl. declaration)
  def NAME [FILE]               go to definition
  impl NAME [FILE]              implementation/type definitions (Go interfaces)
  callers NAME [FILE]           who calls this symbol
  outline FILE                  symbol tree of a file
  symbols QUERY                 workspace-wide symbol search
  hover NAME | FILE:LINE:COL    hover/type info
  codeaction NAME|FILE:LINE:COL [--apply N]   list code actions, apply one

options:
  --root DIR         project root (default: cwd)
  --file FILE        target file (alternative to positional FILE)
  --dry-run          print edits without writing
  --apply N          codeaction: apply action at index N and write
  --json             caps: also print raw capabilities
  --timeout SEC      per-request timeout (default 60)
  --server BIN       force a server binary (skip detection)

positions are 1-based: FILE:LINE:COL or FILE:LINE (defaults to col 1)
`;

function parseArgs(argv) {
  const opts = { root: process.cwd(), timeout: DEFAULT_TIMEOUT_MS };
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--root") opts.root = path.resolve(argv[++i]);
    else if (a === "--file") opts.file = argv[++i];
    else if (a === "--timeout") opts.timeout = Number(argv[++i]) * 1000;
    else if (a === "--server") opts.server = argv[++i];
    else if (a === "--dry-run") opts.dryRun = true;
    else if (a === "--json") opts.json = true;
    else if (a === "--apply") opts.apply = argv[++i];
    else if (a === "-h" || a === "--help") { log(USAGE); process.exit(0); }
    else if (a.startsWith("--")) fail(`unknown option: ${a}`);
    else positional.push(a);
  }
  return { opts, positional };
}

async function main() {
  const { opts, positional } = parseArgs(process.argv.slice(2));
  const [action, ...rest] = positional;
  if (!action) { log(USAGE); process.exit(0); }
  const root = path.resolve(opts.root);
  if (!fs.existsSync(root)) fail(`root not found: ${root}`);
  const lang = detectLanguage(root);
  const ctx = { root, lang, opts };
  if (action === "detect") { await actionDetect(ctx); return; }
  if (action === "caps") { await actionCaps(ctx, opts); return; }
  if (!lang) fail(`cannot detect language in ${root} (expected go.mod / tsconfig.json / compile_commands.json)`);
  const bin = opts.server || resolveServer(root, lang);
  if (!bin) {
    const hint = lang === "typescript"
      ? "install it in the project: pnpm add -Dw typescript-language-server"
      : lang === "go"
        ? "install it: go install golang.org/x/tools/gopls@latest"
        : "make the server available on PATH";
    fail(`${lang} server not found — ${hint}`);
  }
  const session = await openSession(root, lang, bin, ctx.opts.timeout);
  Object.assign(ctx, session); // client, rootUri, timeout
  const dispatch = {
    rename: actionRename,
    refs: actionRefs,
    def: (c, a, o) => jumpAction(c, "textDocument/definition", a, o, "definition"),
    impl: (c, a, o) => jumpAction(c, "textDocument/implementation", a, o, "implementation"),
    callers: actionCallers,
    outline: actionOutline,
    symbols: actionSymbols,
    hover: actionHover,
    codeaction: actionCodeAction,
  };
  const fn = dispatch[action];
  if (!fn) fail(`unknown action: ${action}`);
  try {
    await fn(ctx, rest, opts);
  } catch (e) {
    const tail = session.client.stderrTail();
    fail(`${e.message}${tail ? `\nserver stderr: ${tail}` : ""}`, 1);
  } finally {
    await session.client.shutdown();
  }
}

main().catch((e) => fail(`${e.message}`));