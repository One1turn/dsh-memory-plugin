// 离线冒烟：真实 @deepseek-ai 包 + 假 ctx，验证 dsh-memory 的注册、注入、工具与提取路径。
// 运行：node --env "NODE_PATH=C:\Users\PC\AppData\Local\Programs\DeepSeek Harness\1\resources\dsh\node_modules" smoke.mjs
// （NODE_PATH 让 @deepseek-ai/* 从 DSH 安装里解析，正如宿主运行时）
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { pathToFileURL } from "node:url";

import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const HOME = process.env.DSH_TEST_HOME || path.join(os.tmpdir(), "dsh-memory-smoke");
await fs.rm(HOME, { recursive: true, force: true });
await fs.mkdir(HOME, { recursive: true });
const memRoot = path.join(HOME, "memories");
const WS = path.join(HOME, "workspace");
await fs.mkdir(WS, { recursive: true });
process.env.DSH_HOME = HOME;

const captured = { tools: [], sections: [], handlers: [] };
const sessions = [];
const agent = {
  id: "agent-1",
  session: null,
  injected: [],
  inject(msg) { this.injected.push(msg); },
};
let llmCanned = [];
const ctx = {
  sessions: {
    list: () => sessions,
    get: (id) => sessions.find((s) => s.id === id),
  },
  tools: { register: (def) => captured.tools.push(def) },
  systemPrompt: { section: (def) => captured.sections.push(def) },
  llm: {
    async *stream() { for (const c of llmCanned) yield c; },
  },
  agents: {},
  inject(_deps, cb) { cb({ connection: undefined, get: () => undefined }); },
  on(evt, handler) { captured.handlers.push([evt, handler]); },
};

const mod = await import(pathToFileURL(path.join(ROOT, "index.js")).href);
mod.apply(ctx, {
  enabled: true, memoriesRoot: "", autoExtract: true,
  extractProvider: "deepseek", extractModel: "canned",
  minUserWords: 4, maxIndexLines: 200, maxExtractInputBytes: 48000,
});

const dir = path.join(memRoot);
const calls = captured.handlers;
function fire(evt, ...args) {
  for (const [name, fn] of calls) if (name === evt) fn(...args);
}
async function callTool(name, args) {
  const t = captured.tools.find((x) => x.name === name);
  return JSON.parse(await t.execute(args, {}));
}

let failures = 0;
function check(label, ok, evidence) {
  console.log(`${ok ? "✓" : "✗"} ${label}${evidence ? ` — ${evidence}` : ""}`);
  if (!ok) failures += 1;
}

check("注册了 3 个工具", captured.tools.length === 3, captured.tools.map((t) => t.name).join(","));
check("注册了记忆提示词段", captured.sections.some((s) => s.name === "dsh-memory"));

// 会话
const session = {
  id: "sess-1",
  meta: { cwd: WS },
  messages: [],
  deriveMessages() { return this.messages; },
};
sessions.push(session);
agent.session = session;

// memory_write 基础
const w = await callTool("memory_write", {
  title: "smoke-fact", description: "冒烟测试事实", type: "project",
  body: "这是一条自动提取测试事实。\n\n**Why:** 测试\n\n**How to apply:** 忽略",
});
check("memory_write 落盘", w.ok && w.file === "smoke-fact.md", JSON.stringify(w));
const index = await fs.readFile(path.join(w.dir, "MEMORY.md"), "utf8");
check("MEMORY.md 追加索引行", index.includes("- [smoke-fact](smoke-fact.md)"), index.trim());
const fileText = await fs.readFile(path.join(w.dir, "smoke-fact.md"), "utf8");
check("frontmatter 类型正确", fileText.includes("type: project"));

// 注入（agent/created）
fire("agent/created", { agent });
await new Promise((r) => setTimeout(r, 300));
check("agent.inject 携带 MEMORY.md", agent.injected.length === 1 && agent.injected[0].content[0].text.includes("smoke-fact.md"), String(agent.injected.length));

// 提取路径：request/header 记路由 + 用户话语 + turn/end + 假 LLM 返回一条记忆
fire("session/event", session, { type: "request/header", data: { provider: "deepseek", model: "m1" } });
session.messages.push({ role: "user", content: [{ type: "text", text: "这台机器的 python 在 D 盘，记住以后都用 D 盘 python 别用商店版" }] });
session.messages.push({ role: "assistant", content: [{ type: "text", text: "好的，记下了" }] });
llmCanned = [
  { type: "text-delta", text: '```json\n{"memories":[{"title":"python-on-d","description":"本机 Python 安装在 D 盘","type":"project","body":"用户要求使用 D 盘 python。\\n\\n**Why:** 商店版损坏\\n\\n**How to apply:** 命令一律用 D:/python/python.exe"}]}\n```' },
  { type: "finish" },
];
fire("session/event", session, { type: "turn/end", data: {} });
for (let i = 0; i < 30 && !(await fs.readdir(w.dir)).includes("python-on-d.md"); i += 1) {
  await new Promise((r) => setTimeout(r, 100));
}
const files = await fs.readdir(w.dir);
check("自动提取写入了记忆文件", files.includes("python-on-d.md"), files.join(","));
const extracted = files.includes("python-on-d.md")
  ? await fs.readFile(path.join(w.dir, "python-on-d.md"), "utf8")
  : "";
check("提取文件带 originSessionId", extracted.includes("originSessionId: sess-1"));

// memory_list / memory_read
const l = await callTool("memory_list", {});
check("memory_list 默认作用域命中会话 cwd", l.count >= 2 && l.dir === w.dir, JSON.stringify({ count: l.count, dir: l.dir }));
const r1 = await callTool("memory_read", { file: "smoke-fact.md" });
check("memory_read 返回内容", r1.ok && r1.content.includes("冒烟测试事实"));
const rBad = await callTool("memory_read", { file: "../MEMORY.md" });
check("memory_read 拒绝越界路径", rBad.ok === false);

console.log(failures ? `FAILED=${failures}` : "ALL PASS");
process.exit(failures ? 1 : 0);
