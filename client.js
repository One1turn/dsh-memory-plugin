/**
 * dsh-memory 设置页管理区（Client 半边）。
 *
 * 版式对齐 ZCode 原生记忆页（单栏全宽）：
 *   大标题「记忆」→ 工作区记忆开关卡（全宽）→ 工具行（自绘工作区下拉 | N 条记忆 | 搜索）→
 *   「文件」+ 打开目录 + 刷新 → 全宽文件列表（M 图标 + 名称 + 日期 + 类型徽标 + 打开文件夹）。
 * 点击行在行下展开内容查看器（手风琴）；行内文件夹按钮在资源管理器中定位该文件。
 * 图标全部为内联 SVG；样式只用 --dsw-* 主题 token。
 */
window.__ModuleLoader__.load({
  id: "@local/dsh-memory",
  factory(require) {
    const React = require("react");
    const h = React.createElement;
    const { useState, useEffect, useCallback, useMemo, useRef } = React;

    const STYLES = `
.dshm-wrap { display: flex; flex-direction: column; gap: 16px; width: 100%; min-width: 0; color: var(--dsw-alias-label-primary); }
.dshm-title { display: flex; align-items: center; gap: 8px; font-size: 18px; font-weight: 600; color: var(--dsw-alias-label-primary); margin: 0; }
.dshm-title-icon { color: var(--dsw-static-deepseek-500, #4176e6); flex: 0 0 auto; }
.dshm-card { border: 1px solid var(--dsw-alias-settings-card-stroke, var(--dsw-alias-border-l2)); border-radius: 14px; background: var(--dsw-alias-bg-layer-1); padding: 18px 20px; display: flex; align-items: center; justify-content: space-between; gap: 16px; }
.dshm-card-title { font-size: 15px; font-weight: 600; color: var(--dsw-alias-label-primary); }
.dshm-card-desc { font-size: 13px; color: var(--dsw-alias-label-secondary); margin-top: 6px; line-height: 1.6; }
.dshm-switch { position: relative; width: 46px; height: 25px; border-radius: 13px; background: var(--dsw-alias-bg-layer-3); border: 1px solid var(--dsw-alias-border-l2); cursor: pointer; flex: 0 0 auto; transition: background .15s ease, border-color .15s ease; padding: 0; }
.dshm-switch[aria-checked="true"] { background: var(--dsw-static-deepseek-500, #4176e6); border-color: transparent; }
.dshm-switch::after { content: ""; position: absolute; top: 2px; left: 2px; width: 19px; height: 19px; border-radius: 50%; background: #fff; transition: left .15s ease; box-shadow: 0 1px 3px rgba(0,0,0,.35); }
.dshm-switch[aria-checked="true"]::after { left: 23px; }
.dshm-toolbar { display: flex; align-items: center; gap: 14px; }
.dshm-ws { position: relative; display: flex; align-items: center; gap: 8px; border: 1px solid var(--dsw-alias-border-l2); border-radius: 10px; background: var(--dsw-alias-bg-layer-1); height: 38px; padding: 0 12px; min-width: 220px; }
.dshm-ws > svg { color: var(--dsw-static-deepseek-500, #4176e6); flex: 0 0 auto; }
.dshm-ws-btn { display: flex; align-items: center; gap: 8px; border: none; background: transparent; color: var(--dsw-alias-label-primary); font-size: 13px; cursor: pointer; padding: 0; min-width: 0; flex: 1 1 auto; }
.dshm-ws-name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dshm-menu { position: absolute; top: calc(100% + 6px); left: 0; min-width: 100%; max-height: 260px; overflow-y: auto; z-index: 30; background: var(--dsw-alias-bg-layer-2); border: 1px solid var(--dsw-alias-border-l2); border-radius: 10px; box-shadow: 0 8px 24px rgba(0,0,0,.35); padding: 4px; }
.dshm-menu-item { display: flex; align-items: center; gap: 8px; width: 100%; text-align: left; border: none; background: transparent; color: var(--dsw-alias-label-primary); font-size: 13px; padding: 8px 10px; border-radius: 8px; cursor: pointer; }
.dshm-menu-item:hover { background: var(--dsw-alias-bg-layer-3); }
.dshm-menu-check { width: 16px; flex: 0 0 auto; color: var(--dsw-static-deepseek-500, #4176e6); font-size: 12px; }
.dshm-menu-name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dshm-menu-empty { padding: 10px; font-size: 12px; color: var(--dsw-alias-label-dimmed); }
.dshm-vsep { width: 1px; height: 20px; background: var(--dsw-alias-border-l2); }
.dshm-count { font-size: 13px; color: var(--dsw-alias-label-secondary); white-space: nowrap; }
.dshm-search-wrap { margin-left: auto; position: relative; width: 360px; max-width: 45%; }
.dshm-search-wrap > svg { position: absolute; left: 10px; top: 50%; transform: translateY(-50%); color: var(--dsw-alias-label-dimmed); pointer-events: none; }
.dshm-search { height: 38px; border-radius: 10px; border: 1px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); font-size: 13px; padding: 0 12px 0 34px; width: 100%; box-sizing: border-box; outline: none; }
.dshm-search::placeholder { color: var(--dsw-alias-label-dimmed); }
.dshm-search:focus { border-color: var(--dsw-static-deepseek-500, #4176e6); }
.dshm-listhead { display: flex; align-items: center; justify-content: space-between; font-size: 14px; color: var(--dsw-alias-label-primary); }
.dshm-listhead-actions { display: flex; align-items: center; gap: 8px; }
.dshm-iconbtn { border: 1px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-secondary); border-radius: 9px; width: 32px; height: 32px; cursor: pointer; display: flex; align-items: center; justify-content: center; padding: 0; }
.dshm-iconbtn:hover { color: var(--dsw-alias-label-primary); background: var(--dsw-alias-bg-layer-2); }
.dshm-list { border: 1px solid var(--dsw-alias-border-l2); border-radius: 14px; background: var(--dsw-alias-bg-layer-1); overflow: hidden; }
.dshm-item { border-bottom: 1px solid var(--dsw-alias-border-l2); }
.dshm-item:last-child { border-bottom: none; }
.dshm-row { display: flex; align-items: center; gap: 14px; width: 100%; text-align: left; padding: 14px 18px; background: transparent; border: none; cursor: pointer; color: inherit; }
.dshm-row:hover { background: var(--dsw-alias-bg-layer-2); }
.dshm-row[data-active="true"] { background: var(--dsw-alias-bg-layer-2); }
.dshm-row-icon { width: 36px; height: 36px; border-radius: 10px; background: var(--dsw-alias-bg-layer-3); color: var(--dsw-static-deepseek-500, #4176e6); display: flex; align-items: center; justify-content: center; font-size: 13px; font-weight: 700; flex: 0 0 auto; }
.dshm-row-main { min-width: 0; flex: 1 1 auto; }
.dshm-row-name { display: block; font-size: 15px; font-weight: 500; color: var(--dsw-alias-label-primary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.dshm-row-date { display: block; font-size: 12px; color: var(--dsw-alias-label-tertiary); margin-top: 3px; }
.dshm-typebadge { font-size: 11px; padding: 2px 8px; border-radius: 7px; border: 1px solid var(--dsw-alias-border-l2); color: var(--dsw-alias-label-secondary); flex: 0 0 auto; }
.dshm-rowicon-btn { border: 1px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-secondary); border-radius: 8px; width: 30px; height: 30px; cursor: pointer; display: flex; align-items: center; justify-content: center; padding: 0; flex: 0 0 auto; }
.dshm-rowicon-btn:hover { color: var(--dsw-alias-label-primary); background: var(--dsw-alias-bg-layer-3); }
.dshm-chev { color: var(--dsw-alias-label-tertiary); display: flex; transition: transform .15s ease; flex: 0 0 auto; }
.dshm-chev[data-open="true"] { transform: rotate(180deg); }
.dshm-viewer { border-top: 1px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-layer-2); padding: 16px 20px; font-size: 13px; line-height: 1.75; white-space: pre-wrap; word-break: break-word; color: var(--dsw-alias-label-primary); font-family: ui-monospace, SFMono-Regular, Consolas, monospace; max-height: 420px; overflow: auto; }
.dshm-empty { padding: 40px 0; text-align: center; color: var(--dsw-alias-label-dimmed); font-size: 13px; }
.dshm-error { font-size: 12px; color: var(--dsw-alias-state-error-primary); }
`;

    const svgProps = { width: 15, height: 15, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": true };
    const IconFolder = () => h("svg", svgProps, h("path", { d: "M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" }));
    const IconFolderOpen = () => h("svg", svgProps, h("path", { d: "m6 14 1.5-4.5A2 2 0 0 1 9.4 8H20a1 1 0 0 1 .97 1.24l-1.3 5.2A2 2 0 0 1 17.72 16H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2" }));
    const IconSearch = () => h("svg", svgProps, h("circle", { cx: 11, cy: 11, r: 7 }), h("path", { d: "m20 20-3.5-3.5" }));
    const IconRefresh = () => h("svg", svgProps, h("path", { d: "M21 12a9 9 0 1 1-2.64-6.36" }), h("path", { d: "M21 3v6h-6" }));
    const IconChevron = () => h("svg", svgProps, h("path", { d: "m6 9 6 6 6-6" }));
    /** 大脑图标（ZCode 记忆风格，蓝紫渐变描边），与宿主 16px 描边图标同规格 */
    const brainPathProps = { stroke: "url(#dshm-brain-grad)", fill: "none", strokeWidth: 1.3, strokeLinecap: "round", strokeLinejoin: "round" };
    const IconBrain = () => h("svg", { width: 16, height: 16, viewBox: "0 0 24 24", "aria-hidden": true, className: "dshm-title-icon" },
      h("defs", null,
        h("linearGradient", { id: "dshm-brain-grad", x1: "3", y1: "3", x2: "21", y2: "21", gradientUnits: "userSpaceOnUse" },
          h("stop", { offset: "0", stopColor: "#4D6BFE" }),
          h("stop", { offset: "1", stopColor: "#A855F7" }),
        ),
      ),
      h("path", { d: "M12 5a3 3 0 1 0-5.997.125 4 4 0 0 0-2.526 5.77 4 4 0 0 0 .556 6.588A4 4 0 1 0 12 18Z", ...brainPathProps }),
      h("path", { d: "M12 5a3 3 0 1 1 5.997.125 4 4 0 0 1 2.526 5.77 4 4 0 0 1-.556 6.588A4 4 0 1 1 12 18Z", ...brainPathProps }),
      h("path", { d: "M15 13a4.5 4.5 0 0 1-3-4 4.5 4.5 0 0 1-3 4", ...brainPathProps }),
      h("path", { d: "M17.599 6.5a3 3 0 0 0 .399-1.375", ...brainPathProps }),
      h("path", { d: "M17.599 6.5a3 3 0 0 1-.399 1.375", ...brainPathProps }),
    );

    function formatDate(ms) {
      if (!ms) return "";
      const d = new Date(ms);
      const now = new Date();
      const hm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
      const sameDay = d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
      if (sameDay) return `今天 ${hm}`;
      const y = new Date(now.getTime() - 86400000);
      if (d.getFullYear() === y.getFullYear() && d.getMonth() === y.getMonth() && d.getDate() === y.getDate()) return `昨天 ${hm}`;
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    }

    function Switch({ checked, onChange, label }) {
      return h("button", {
        type: "button",
        role: "switch",
        "aria-checked": checked ? "true" : "false",
        "aria-label": label,
        className: "dshm-switch",
        onClick: () => onChange(!checked),
      });
    }

    /** 自绘工作区下拉：替代原生 select，跟随主题、带选中勾。 */
    function WorkspaceSelect({ workspaces, value, onChange }) {
      const [open, setOpen] = useState(false);
      const ref = useRef(null);
      useEffect(() => {
        if (!open) return undefined;
        const close = (e) => {
          if (ref.current && !ref.current.contains(e.target)) setOpen(false);
        };
        document.addEventListener("mousedown", close);
        return () => document.removeEventListener("mousedown", close);
      }, [open]);
      const current = workspaces.find((w) => w.path === value);
      return h("div", { className: "dshm-ws", ref },
        h(IconFolder, null),
        h("button", {
          type: "button",
          className: "dshm-ws-btn",
          onClick: () => setOpen((o) => !o),
        },
          h("span", { className: "dshm-ws-name" }, current?.name ?? "尚无记忆工作区"),
          h("span", { className: "dshm-chev", "data-open": open ? "true" : "false" }, h(IconChevron, null)),
        ),
        open ? h("div", { className: "dshm-menu" },
          workspaces.length === 0
            ? h("div", { className: "dshm-menu-empty" }, "还没有记忆工作区：在某个工作区里用一次 memory_write 即可生成")
            : workspaces.map((w) => h("button", {
                key: w.path,
                type: "button",
                className: "dshm-menu-item",
                onClick: () => { setOpen(false); onChange(w.path); },
              },
                h("span", { className: "dshm-menu-check" }, w.path === value ? "✓" : ""),
                h("span", { className: "dshm-menu-name" }, w.name),
              )),
        ) : null,
      );
    }

    function MemoryPage({ rpcCall }) {
      const [enabled, setEnabled] = useState(true);
      const [enabledBusy, setEnabledBusy] = useState(false);
      const [workspaces, setWorkspaces] = useState([]);
      const [selected, setSelected] = useState(null);
      const [files, setFiles] = useState([]);
      const [search, setSearch] = useState("");
      const [openFile, setOpenFile] = useState(null);
      const [content, setContent] = useState(null);
      const [loading, setLoading] = useState(true);
      const [error, setError] = useState(null);

      const call = useCallback(async (method, payload) => {
        const raw = await rpcCall(method, payload);
        if (raw && raw.ok === false) throw new Error(raw.error?.message || "记忆管理请求失败");
        return raw && raw.ok === true ? raw.value : raw;
      }, [rpcCall]);

      const refreshWorkspaces = useCallback(async (prefer) => {
        const data = await call("workspace.list", {});
        setEnabled(data.enabled !== false);
        setWorkspaces(data.items ?? []);
        const list = data.items ?? [];
        const next = prefer && list.find((w) => w.path === prefer) ? prefer : (list[0]?.path ?? null);
        setSelected(next);
        return next;
      }, [call]);

      const refreshFiles = useCallback(async (dir) => {
        if (!dir) { setFiles([]); return; }
        const data = await call("memory.list", { dir });
        setFiles(data.items ?? []);
      }, [call]);

      useEffect(() => {
        let dead = false;
        (async () => {
          try {
            setLoading(true);
            setError(null);
            const dir = await refreshWorkspaces();
            if (!dead) await refreshFiles(dir);
          } catch (e) {
            if (!dead) setError(e?.message ?? String(e));
          } finally {
            if (!dead) setLoading(false);
          }
        })();
        return () => { dead = true; };
      }, [refreshWorkspaces, refreshFiles]);

      const toggleRow = useCallback(async (dir, file) => {
        if (openFile === file) { setOpenFile(null); setContent(null); return; }
        setOpenFile(file);
        setContent(null);
        try {
          const data = await call("memory.read", { dir, file });
          setContent(data.content ?? "");
        } catch (e) {
          setContent(`读取失败：${e?.message ?? e}`);
        }
      }, [call, openFile]);

      const toggleEnabled = useCallback(async (next) => {
        setEnabledBusy(true);
        try {
          const data = await call("memory.enabled.set", { enabled: next });
          setEnabled(data.enabled === true);
        } catch (e) {
          setError(e?.message ?? String(e));
        } finally {
          setEnabledBusy(false);
        }
      }, [call]);

      const openInExplorer = useCallback(async (file) => {
        try {
          await call("memory.open", file ? { dir: selected, file } : { dir: selected });
        } catch (e) {
          setError(e?.message ?? String(e));
        }
      }, [call, selected]);

      const filtered = useMemo(() => {
        const q = search.trim().toLowerCase();
        if (!q) return files;
        return files.filter((f) => f.file.toLowerCase().includes(q) || (f.description ?? "").toLowerCase().includes(q));
      }, [files, search]);

      return h("div", { className: "dshm-wrap" },
        h("h2", { className: "dshm-title" }, h(IconBrain, null), h("span", null, "记忆")),
        h("div", { className: "dshm-card" },
          h("div", null,
            h("div", { className: "dshm-card-title" }, "工作区记忆"),
            h("div", { className: "dshm-card-desc" }, "在工作区中保存并复用长期上下文，新会话生效。开启后可能增加模型调用和 Token 成本。"),
          ),
          h(Switch, { checked: enabled, onChange: toggleEnabled, label: "工作区记忆" }),
        ),
        error ? h("div", { className: "dshm-error" }, error) : null,
        h("div", { className: "dshm-toolbar" },
          h(WorkspaceSelect, {
            workspaces,
            value: selected,
            onChange: (dir) => {
              setSelected(dir);
              setOpenFile(null);
              setContent(null);
              void refreshFiles(dir);
            },
          }),
          h("span", { className: "dshm-vsep" }),
          h("span", { className: "dshm-count" }, `${filtered.length} 条记忆`),
          h("div", { className: "dshm-search-wrap" },
            h(IconSearch, null),
            h("input", {
              className: "dshm-search",
              placeholder: "搜索记忆文件...",
              value: search,
              onChange: (e) => setSearch(e.target.value),
            }),
          ),
        ),
        h("div", { className: "dshm-listhead" },
          h("span", null, "文件"),
          h("div", { className: "dshm-listhead-actions" },
            h("button", {
              className: "dshm-iconbtn",
              title: "打开记忆目录",
              onClick: () => void openInExplorer(null),
            }, h(IconFolderOpen, null)),
            h("button", {
              className: "dshm-iconbtn",
              title: "刷新",
              onClick: () => { void refreshFiles(selected); },
            }, h(IconRefresh, null)),
          ),
        ),
        h("div", { className: "dshm-list" },
          filtered.length === 0
            ? h("div", { className: "dshm-empty" }, loading ? "加载中…" : "此工作区还没有记忆文件")
            : filtered.map((f) => h("div", { key: f.file, className: "dshm-item" },
                h("div", { className: "dshm-row", "data-active": openFile === f.file ? "true" : "false", role: "button", tabIndex: 0,
                  onClick: () => void toggleRow(selected, f.file),
                  onKeyDown: (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); void toggleRow(selected, f.file); } },
                },
                  h("span", { className: "dshm-row-icon" }, f.file === "MEMORY.md" ? "M↓" : "M"),
                  h("span", { className: "dshm-row-main" },
                    h("span", { className: "dshm-row-name" }, f.file),
                    h("span", { className: "dshm-row-date" }, formatDate(f.updatedAt)),
                  ),
                  f.type ? h("span", { className: "dshm-typebadge" }, f.type) : null,
                  h("button", {
                    type: "button",
                    className: "dshm-rowicon-btn",
                    title: "在资源管理器中显示",
                    onClick: (e) => { e.stopPropagation(); void openInExplorer(f.file); },
                  }, h(IconFolderOpen, null)),
                  h("span", { className: "dshm-chev", "data-open": openFile === f.file ? "true" : "false" }, h(IconChevron, null)),
                ),
                openFile === f.file
                  ? (content === null
                      ? h("div", { className: "dshm-viewer" }, "加载中…")
                      : h("div", { className: "dshm-viewer" }, content))
                  : null,
              )),
        ),
      );
    }

    return {
      inject: ["slots", "connection"],
      apply(ctx) {
        ctx.effect(() => {
          const style = document.createElement("style");
          style.textContent = STYLES;
          document.head.appendChild(style);
          return () => style.remove();
        }, "dsh-memory: styles");

        const rpcCall = async (method, payload, signal) => {
          const raw = await ctx.connection.rpc.call("/api", "dsh-memory", { method, payload }, signal);
          if (raw && typeof raw === "object" && "ok" in raw) return raw;
          return raw?.result ?? raw;
        };

        ctx.slots.inject("settings.section", () => ctx.slots.register({
          name: "settings.section",
          id: "dsh-memory",
          order: 60,
          label: () => "记忆",
          inject: () => ({ rpcCall }),
        }, MemoryPage));
      },
    };
  },
});
