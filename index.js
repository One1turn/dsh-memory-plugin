/**
 * dsh-memory — 把 ZCode 的「记忆」功能移植为 DeepSeek Harness 插件。
 *
 * 与 ZCode 记忆子系统对齐的三件事：
 *  1. 物理布局：每个 workspace 一份目录 `<memoriesRoot>/projects/<basename>-<sha16>/memory/`，
 *     每条记忆一个 Markdown 文件（frontmatter: name/description/metadata.type），
 *     MEMORY.md 作为索引（`- [Title](file.md) — hook`）。
 *  2. 召回：agent 创建时把 MEMORY.md 注入其收件箱（agent.inject，不唤醒、落到下一个被接纳的步骤），
 *     并在系统提示词里说明使用规约。
 *  3. 写入：模型用 memory_write 工具；回合结束（turn/end 持久事件）后跑一次提取子调用
 *     （ctx.llm.stream 单次 JSON 产出），把值得长期保留的事实落成文件并盖 originSessionId。
 *
 * 另注册设置页管理区（client.js，样式仿 ZCode 原生记忆页），经 /api/dsh-memory RPC 读写。
 *
 * 刻意不 import 任何 @deepseek-ai 包：外部 link 安装的插件由 Node 从插件自身目录向上解析，
 * 宿主 asar 里的 SDK 对它不可见；全部能力走 ctx 上的服务（tools/systemPrompt/llm/sessions/connection）。
 * 插件数据不落 session 事件（会话日志是唯一事实源，插件记忆是派生缓存）。
 */
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const MEMORY_TYPES = new Set(["user", "feedback", "project", "reference"]);
const LOG = "[dsh-memory]";
const RPC_PATH = "/api/dsh-memory";

/** patch 行可覆盖的配置；与 README 的 config 节对应。 */
function resolveConfig(config = {}) {
  return {
    enabled: config.enabled !== false,
    memoriesRoot: typeof config.memoriesRoot === "string" && config.memoriesRoot.trim() ? config.memoriesRoot.trim() : "",
    autoExtract: config.autoExtract !== false,
    extractProvider: typeof config.extractProvider === "string" ? config.extractProvider : "",
    extractModel: typeof config.extractModel === "string" ? config.extractModel : "",
    minUserWords: Number.isFinite(config.minUserWords) ? config.minUserWords : 4,
    maxIndexLines: Number.isFinite(config.maxIndexLines) ? config.maxIndexLines : 200,
    maxExtractInputBytes: Number.isFinite(config.maxExtractInputBytes) ? config.maxExtractInputBytes : 48000,
  };
}

export const inject = ["sessions", "tools", "llm", "systemPrompt"];

export function apply(ctx, rawConfig) {
  const config = resolveConfig(rawConfig);
  if (!config.enabled) {
    console.log(`${LOG} enabled=false，插件不激活`);
    return;
  }

  const memoriesRoot =
    config.memoriesRoot ||
    path.join(process.env.DSH_HOME || path.join(os.homedir(), ".dsh"), "memories");

  // 会话最近一次请求路由（提取子调用复用同一条模型通道）
  const routes = new Map(); // sessionId -> { provider, model }
  // 每目录串行锁，防并发改写 MEMORY.md
  const locks = new Map();
  // 提取调度状态
  const extraction = new Map(); // sessionId -> { cursor, running, dirty }
  // 每个 agent 已注入的索引指纹
  const injected = new Map(); // agentId -> indexText
  // 运行期开关（设置页「工作区记忆」），持久化在 memoriesRoot/settings.json
  let runtimeEnabled = true;

  function withLock(key, fn) {
    const prev = locks.get(key) ?? Promise.resolve();
    const run = prev.then(fn, fn);
    locks.set(
      key,
      run.catch(() => {}),
    );
    return run;
  }

  // ── 路径与作用域 ────────────────────────────────────────────────────────
  function scopeForCwd(cwd) {
    const abs = path.resolve(cwd || process.cwd());
    const hash = crypto.createHash("sha256").update(abs.toLowerCase()).digest("hex").slice(0, 16);
    const base = (path.basename(abs) || "root").replace(/[^A-Za-z0-9._-]+/g, "-").slice(0, 48);
    return path.join(memoriesRoot, "projects", `${base}-${hash}`, "memory");
  }

  function currentCwd(explicit) {
    if (typeof explicit === "string" && explicit.trim()) return explicit.trim();
    const list = ctx.sessions.list();
    for (let i = list.length - 1; i >= 0; i -= 1) {
      const cwd = list[i]?.meta?.cwd;
      if (cwd) return cwd;
    }
    return process.cwd();
  }

  // ── frontmatter：与 ZCode 记忆文件格式一致 ──────────────────────────────
  function renderEntry(entry) {
    const meta = ["---", `name: ${entry.title}`, `description: ${entry.description}`, "metadata:"];
    meta.push(`  type: ${entry.type}`);
    if (entry.originSessionId) meta.push(`  originSessionId: ${entry.originSessionId}`);
    if (entry.originSessionId) meta.push("  node_type: memory");
    meta.push("---", "", entry.body.trim(), "");
    return meta.join("\n");
  }

  function parseEntryHead(text) {
    const out = { description: "", type: "reference" };
    const lines = text.split(/\r?\n/).slice(0, 30);
    if (lines[0]?.trim() !== "---") return out;
    for (const line of lines.slice(1)) {
      if (line.trim() === "---") break;
      const desc = /^description:\s*(.+)$/.exec(line);
      if (desc) out.description = desc[1].trim();
      const nested = /^\s{2}type:\s*(.+)$/.exec(line);
      if (nested && MEMORY_TYPES.has(nested[1].trim())) out.type = nested[1].trim();
      const top = /^type:\s*(.+)$/.exec(line);
      if (top && MEMORY_TYPES.has(top[1].trim())) out.type = top[1].trim();
    }
    return out;
  }

  function safeFileName(title) {
    const base = title
      .toLowerCase()
      .replace(/[^a-z0-9一-龥._-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60);
    return `${base || "memory"}.md`;
  }

  async function writeMemoryFile(dir, entry) {
    return withLock(dir, async () => {
      await fs.mkdir(dir, { recursive: true });
      let file = safeFileName(entry.title);
      for (let n = 2; await fs.stat(path.join(dir, file)).then(() => true, () => false); n += 1) {
        file = safeFileName(`${entry.title}-${n}`);
      }
      await fs.writeFile(path.join(dir, file), renderEntry(entry), "utf8");
      const indexFile = path.join(dir, "MEMORY.md");
      const existing = await fs.readFile(indexFile, "utf8").catch(() => "");
      const line = `- [${entry.title}](${file}) — ${entry.description}`;
      if (!existing.includes(`](${file})`)) {
        await fs.writeFile(indexFile, `${existing.replace(/\n*$/, "")}${existing.trim() ? "\n" : ""}${line}\n`, "utf8");
      }
      return file;
    });
  }

  async function readIndex(dir) {
    return fs.readFile(path.join(dir, "MEMORY.md"), "utf8").catch(() => "");
  }

  async function listManifest(dir) {
    const names = await fs.readdir(dir).catch(() => []);
    const items = [];
    for (const name of names) {
      if (!name.endsWith(".md")) continue;
      const stat = await fs.stat(path.join(dir, name)).catch(() => null);
      if (!stat?.isFile()) continue;
      if (name === "MEMORY.md") {
        // 索引文件也进列表（与 ZCode 原生记忆页一致），不标类型
        items.push({ file: name, description: "记忆索引", type: "", updatedAt: stat.mtimeMs });
        continue;
      }
      const head = await fs.readFile(path.join(dir, name), "utf8").catch(() => "");
      const { description, type } = parseEntryHead(head);
      items.push({ file: name, description, type, updatedAt: stat.mtimeMs });
    }
    items.sort((a, b) => (a.file === "MEMORY.md" ? -1 : b.file === "MEMORY.md" ? 1 : b.updatedAt - a.updatedAt));
    return items.slice(0, config.maxIndexLines);
  }

  // ── 模型可见工具（普通定义对象，直接注册） ─────────────────────────────
  const textOutput = { schema: { type: "string" }, render: (_args, value) => [{ type: "text", text: value }] };

  ctx.tools.register({
    name: "memory_write",
    description:
      "Persist one durable fact to the workspace memory store (markdown file + MEMORY.md index). Types: user (who the user is), feedback (how you should work, include why), project (ongoing goal/constraint not derivable from code), reference (pointer to external resource).",
    parameters: {
      title: { type: "string", required: true, description: "Short kebab-ish human title, becomes the file name" },
      description: { type: "string", required: true, description: "One-line summary used to decide relevance later" },
      type: { type: "string", required: true, description: "user | feedback | project | reference" },
      body: { type: "string", required: true, description: "The fact itself; feedback/project bodies end with **Why:** and **How to apply:** lines" },
      workspace: { type: "string", description: "Absolute workspace path; defaults to the current session cwd" },
    },
    output: textOutput,
    async execute(args) {
      if (!MEMORY_TYPES.has(args.type)) {
        return JSON.stringify({ ok: false, error: `type must be one of: ${[...MEMORY_TYPES].join(", ")}` });
      }
      const dir = scopeForCwd(currentCwd(args.workspace));
      const file = await writeMemoryFile(dir, {
        title: args.title.trim(),
        description: args.description.trim(),
        type: args.type,
        body: args.body,
      });
      return JSON.stringify({ ok: true, file, dir });
    },
  });

  ctx.tools.register({
    name: "memory_list",
    description: "List the current workspace's memory entries (file, description, type, updatedAt), newest first.",
    parameters: {
      workspace: { type: "string", description: "Absolute workspace path; defaults to the current session cwd" },
    },
    output: textOutput,
    async execute(args) {
      const dir = scopeForCwd(currentCwd(args.workspace));
      const items = await listManifest(dir);
      return JSON.stringify({ dir, count: items.length, items });
    },
  });

  ctx.tools.register({
    name: "memory_read",
    description: "Read one memory file by name (as listed by memory_list), full markdown content.",
    parameters: {
      file: { type: "string", required: true, description: "File name, e.g. win-perf-cleanup-2026-10.md" },
      workspace: { type: "string" },
    },
    output: textOutput,
    async execute(args) {
      const dir = scopeForCwd(currentCwd(args.workspace));
      const target = path.resolve(dir, args.file);
      if (!target.startsWith(dir + path.sep) || !target.endsWith(".md") || target.endsWith("MEMORY.md")) {
        return JSON.stringify({ ok: false, error: "invalid memory file name" });
      }
      const content = await fs.readFile(target, "utf8").catch(() => null);
      return content === null
        ? JSON.stringify({ ok: false, error: "not found" })
        : JSON.stringify({ ok: true, file: args.file, content });
    },
  });

  // ── 系统提示词：使用规约 ────────────────────────────────────────────────
  ctx.systemPrompt?.section({
    name: "dsh-memory",
    order: 9000,
    text: `# Memory
You have a persistent, file-based memory store for this workspace, managed by the dsh-memory plugin.
- Layout: one markdown file per fact under the workspace memory dir, plus MEMORY.md as its index.
- Frontmatter: name, description (one line, drives future relevance), metadata.type = user | feedback | project | reference.
- feedback/project bodies should end with **Why:** and **How to apply:** lines.
- Save durable facts with memory_write (it updates the index for you); survey with memory_list, read with memory_read.
- Do NOT store what the repo/code already records, transient task state, or anything only meaningful in this one conversation.
The index content is injected into context automatically at session start; treat it as background, verify file paths before recommending them.`,
  });

  // ── 运行期开关持久化 ────────────────────────────────────────────────────
  const settingsFile = path.join(memoriesRoot, "settings.json");
  async function loadEnabled() {
    try {
      const raw = JSON.parse(await fs.readFile(settingsFile, "utf8"));
      runtimeEnabled = raw?.enabled !== false;
    } catch {
      runtimeEnabled = true;
    }
    return runtimeEnabled;
  }
  async function setEnabled(value) {
    runtimeEnabled = value === true;
    await fs.mkdir(memoriesRoot, { recursive: true });
    await fs.writeFile(settingsFile, `${JSON.stringify({ enabled: runtimeEnabled }, null, 2)}\n`, "utf8");
    return runtimeEnabled;
  }
  void loadEnabled();

  // ── 召回注入：agent 创建时把 MEMORY.md 放进收件箱 ───────────────────────
  ctx.on("agent/created", ({ agent }) => {
    if (!runtimeEnabled) return;
    const dir = scopeForCwd(agent.session?.meta?.cwd || currentCwd(""));
    void (async () => {
      const md = (await readIndex(dir)).trim();
      if (!md) return;
      if (injected.get(agent.id) === md) return;
      agent.inject({
        content: [{ type: "text", text: `Contents of ${path.join(dir, "MEMORY.md")} (auto-memory, persists across conversations):\n\n${md}` }],
        source: { kind: "plugin", plugin: "dsh-memory" },
      });
      injected.set(agent.id, md);
    })();
  });

  // ── 提取：记住路由 + 回合结束调度 ──────────────────────────────────────
  ctx.on("session/event", (session, event) => {
    const type = event?.type;
    if (type === "request/header") {
      const data = event.data ?? event;
      if (data?.provider) routes.set(session.id, { provider: data.provider, model: data.model ?? "" });
    }
    if (type === "turn/end" && config.autoExtract && runtimeEnabled) scheduleExtraction(session);
  });

  ctx.on("session/disposed", (session) => {
    routes.delete(session.id);
    extraction.delete(session.id);
  });

  function scheduleExtraction(session) {
    if (extraction.has(session.id) && extraction.get(session.id).running) {
      extraction.get(session.id).dirty = true;
      return;
    }
    const st = extraction.get(session.id) ?? { cursor: 0, running: false, dirty: false };
    extraction.set(session.id, st);
    st.running = true;
    void runExtraction(session, st).finally(() => {
      st.running = false;
      if (st.dirty) {
        st.dirty = false;
        scheduleExtraction(session);
      }
    });
  }

  async function runExtraction(session, st) {
    try {
      const messages = session.deriveMessages();
      if (messages.length <= st.cursor) return;
      const window = messages.slice(st.cursor);
      st.cursor = messages.length;

      const transcript = [];
      let userWords = 0;
      for (const msg of window) {
        const text = (msg.content ?? [])
          .filter((b) => b.type === "text")
          .map((b) => b.text)
          .join("\n");
        if (!text.trim()) continue;
        if (msg.role === "user") {
          const words = text.split(/\s+/).filter(Boolean).length;
          // 跳过插件注入的记忆索引回声，避免被当成用户话语
          if (text.startsWith("Contents of") && text.includes("auto-memory")) continue;
          userWords += words;
        }
        if (msg.role === "user" || msg.role === "assistant") transcript.push(`${msg.role}: ${text.slice(0, 4000)}`);
      }
      if (userWords < config.minUserWords || transcript.length === 0) return;

      const dir = scopeForCwd(session.meta?.cwd || currentCwd(""));
      const known = (await listManifest(dir)).map((m) => m.file).join(", ");
      let input = transcript.join("\n\n");
      const budget = config.maxExtractInputBytes;
      if (Buffer.byteLength(input, "utf8") > budget) input = input.slice(input.length - budget);

      const route = (config.extractProvider && { provider: config.extractProvider, model: config.extractModel })
        || routes.get(session.id);
      if (!route?.provider) return; // 没有可用模型通道：静默跳过

      const prompt = `You are the memory extractor for a coding-agent session (workspace memory dir: ${dir}).
Existing memory files: ${known || "(none)"}.
From the transcript tail below, save ONLY durable facts worth persisting across conversations:
- user: who the user is (role, expertise, preferences)
- feedback: how the agent should work (corrections AND confirmed approaches; include why)
- project: ongoing goals/constraints not derivable from code or git
- reference: pointers to external resources (URLs, dashboards, tickets)
Skip: code structure, transient state, details only relevant to this conversation.
If a fact duplicates an existing file, skip it.
Reply with STRICT JSON: {"memories":[{"title","description","type","body"}]} — empty array is fine. No prose.

TRANSCRIPT:
${input}`;

      let out = "";
      for await (const chunk of ctx.llm.stream({
        provider: route.provider,
        model: route.model || undefined,
        messages: [{ role: "user", content: [{ type: "text", text: prompt }] }],
      })) {
        if (!chunk || typeof chunk !== "object") continue;
        if (chunk.type === "text-delta") out += chunk.text ?? chunk.delta ?? "";
        else if (chunk.type === "text" && typeof chunk.text === "string") out += chunk.text;
      }
      const jsonStart = out.indexOf("{");
      const jsonEnd = out.lastIndexOf("}");
      if (jsonStart < 0 || jsonEnd <= jsonStart) return;
      const parsed = JSON.parse(out.slice(jsonStart, jsonEnd + 1));
      const items = Array.isArray(parsed?.memories) ? parsed.memories : [];
      let saved = 0;
      for (const item of items) {
        if (!item?.title || !item?.description || !MEMORY_TYPES.has(item.type) || !item?.body) continue;
        await writeMemoryFile(dir, {
          title: String(item.title).slice(0, 80),
          description: String(item.description).slice(0, 300),
          type: item.type,
          body: String(item.body),
          originSessionId: session.id,
        });
        saved += 1;
      }
      if (saved) console.log(`${LOG} 自动提取写入 ${saved} 条记忆 (session=${session.id})`);
    } catch (error) {
      console.warn(`${LOG} 提取失败（跳过本次）: ${error?.message ?? error}`);
    }
  }

  // ── 设置页管理 RPC（client.js 消费；低层 fetch 路由 + 手动信封，同 codearts-auth） ──
  ctx.inject(["connection"], (connectionCtx) => {
    const connection = connectionCtx.connection ?? connectionCtx.get?.("connection");
    if (!connection?.fetch?.register) {
      console.warn(`${LOG} connection.fetch 不可用，设置页管理端点未注册`);
      return;
    }
    const reply = (rpcId, result) => Response.json({ type: "server-response", rpcId, result });
    connection.fetch.register({
      path: RPC_PATH,
      methods: ["POST"],
      requestBody: "buffered",
      async fetch(request) {
        if (request.method !== "POST") return new Response("method not allowed", { status: 405 });
        let message;
        try {
          message = await request.json();
        } catch {
          return new Response("body is not JSON", { status: 400 });
        }
        const rpcId = typeof message?.rpcId === "string" ? message.rpcId : "invalid";
        const call = message?.payload;
        if (message?.type !== "client-request" || typeof call?.method !== "string") {
          return reply(rpcId, { ok: false, error: { code: "dsh-memory/bad-request", message: "invalid request" } });
        }
        try {
          const value = await handleRpc(call.method, call.payload ?? {});
          return reply(rpcId, { ok: true, value });
        } catch (error) {
          const text = error instanceof Error ? error.message : String(error);
          console.warn(`${LOG} ${call.method} 失败: ${text}`);
          return reply(rpcId, { ok: false, error: { code: "dsh-memory/failed", message: text } });
        }
      },
    });
    console.log(`${LOG} 设置页管理端点已注册 ${RPC_PATH}`);
  });

  async function handleRpc(method, payload) {
    if (method === "workspace.list") {
      const root = path.join(memoriesRoot, "projects");
      const dirs = await fs.readdir(root).catch(() => []);
      const items = [];
      for (const dir of dirs) {
        const memoryDir = path.join(root, dir, "memory");
        const stat = await fs.stat(memoryDir).catch(() => null);
        if (!stat?.isDirectory()) continue;
        items.push({
          id: dir,
          name: dir.replace(/-[0-9a-f]{16}$/i, ""),
          path: memoryDir,
          updatedAt: stat.mtimeMs,
        });
      }
      items.sort((a, b) => b.updatedAt - a.updatedAt);
      return { items, enabled: runtimeEnabled };
    }
    if (method === "memory.list") {
      const dir = String(payload.dir ?? "");
      if (!dir.startsWith(path.join(memoriesRoot, "projects") + path.sep)) throw new Error("invalid memory dir");
      const items = await listManifest(dir);
      return { items, index: await readIndex(dir) };
    }
    if (method === "memory.read") {
      const dir = String(payload.dir ?? "");
      const file = String(payload.file ?? "");
      if (!dir.startsWith(path.join(memoriesRoot, "projects") + path.sep)) throw new Error("invalid memory dir");
      const target = path.resolve(dir, file);
      if (!target.startsWith(dir + path.sep) || !target.endsWith(".md")) throw new Error("invalid memory file");
      const content = await fs.readFile(target, "utf8");
      return { file, content };
    }
    if (method === "memory.enabled.get") {
      return { enabled: await loadEnabled() };
    }
    if (method === "memory.enabled.set") {
      return { enabled: await setEnabled(payload.enabled === true) };
    }
    if (method === "memory.open") {
      // 定位到本地文件夹：file 传了就在资源管理器里选中该文件，否则打开目录本身
      const dir = String(payload.dir ?? "");
      if (!dir.startsWith(path.join(memoriesRoot, "projects") + path.sep)) throw new Error("invalid memory dir");
      const file = payload.file ? String(payload.file) : "";
      if (file) {
        const target = path.resolve(dir, file);
        if (!target.startsWith(dir + path.sep) || !target.endsWith(".md")) throw new Error("invalid memory file");
        spawn("explorer", ["/select,", target], { detached: true, stdio: "ignore" }).unref();
      } else {
        spawn("explorer", [dir], { detached: true, stdio: "ignore" }).unref();
      }
      return { ok: true };
    }
    throw new Error(`unknown method: ${method}`);
  }

  console.log(`${LOG} 已激活，记忆根目录 ${memoriesRoot}`);
}
