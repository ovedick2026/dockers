import http from "node:http";
import net from "node:net";
import crypto from "node:crypto";
import path from "node:path";
import fs from "node:fs";
import fsp from "node:fs/promises";
import { spawn } from "node:child_process";

const PUBLIC_PORT = Number(process.env.PORT || 7860);
const OPENCODE_PORT = Number(process.env.OPENCODE_INTERNAL_PORT || 7861);

const ROOT = await fsp.realpath(
  process.env.FILES_ROOT || "/home/choreo/workspace",
);

const FILES_USERNAME =
  process.env.FILES_USERNAME ||
  process.env.OPENCODE_SERVER_USERNAME ||
  "opencode";

const FILES_PASSWORD =
  process.env.FILES_PASSWORD ||
  process.env.OPENCODE_SERVER_PASSWORD;

if (!FILES_PASSWORD || FILES_PASSWORD === "CHANGE_THIS_IN_CHOREO") {
  console.error(
    "请通过 Choreo Secret 设置 OPENCODE_SERVER_PASSWORD，不能使用默认占位密码。",
  );
  process.exit(1);
}

function json(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
  });
  res.end(body);
}

function fail(res, status, message) {
  json(res, status, { error: message });
}

function sameText(a, b) {
  const aa = Buffer.from(a || "");
  const bb = Buffer.from(b || "");
  return aa.length === bb.length && crypto.timingSafeEqual(aa, bb);
}

function isAuthorized(req) {
  const expected = `Basic ${Buffer.from(
    `${FILES_USERNAME}:${FILES_PASSWORD}`,
  ).toString("base64")}`;

  return sameText(req.headers.authorization, expected);
}

function requireAuth(req, res) {
  if (isAuthorized(req)) return true;

  res.writeHead(401, {
    "WWW-Authenticate": 'Basic realm="OpenCode Files"',
    "Content-Type": "text/plain; charset=utf-8",
  });
  res.end("Authentication required");
  return false;
}

function isFilesRoute(pathname) {
  return pathname === "/files" || pathname.startsWith("/files/");
}

function relativePath(fullPath) {
  const rel = path.relative(ROOT, fullPath);
  return rel.split(path.sep).join("/");
}

async function safePath(input) {
  let requested = input || ".";

  if (
    typeof requested !== "string" ||
    requested.includes("\0") ||
    path.isAbsolute(requested)
  ) {
    throw new Error("非法路径");
  }

  const candidate = path.resolve(ROOT, requested);

  if (candidate !== ROOT && !candidate.startsWith(`${ROOT}${path.sep}`)) {
    throw new Error("路径超出允许目录");
  }

  // 禁止通过符号链接读取 workspace 外部的内容
  const lstat = await fsp.lstat(candidate);
  if (lstat.isSymbolicLink()) {
    throw new Error("不允许访问符号链接");
  }

  const real = await fsp.realpath(candidate);

  if (real !== ROOT && !real.startsWith(`${ROOT}${path.sep}`)) {
    throw new Error("路径超出允许目录");
  }

  return {
    real,
    relative: relativePath(real),
  };
}

function contentType(fileName) {
  const ext = path.extname(fileName).toLowerCase();

  const types = {
    ".txt": "text/plain; charset=utf-8",
    ".md": "text/markdown; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".ts": "text/plain; charset=utf-8",
    ".tsx": "text/plain; charset=utf-8",
    ".jsx": "text/plain; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".html": "text/plain; charset=utf-8",
    ".yml": "text/plain; charset=utf-8",
    ".yaml": "text/plain; charset=utf-8",
    ".py": "text/plain; charset=utf-8",
    ".go": "text/plain; charset=utf-8",
    ".java": "text/plain; charset=utf-8",
    ".sh": "text/plain; charset=utf-8",
    ".xml": "application/xml; charset=utf-8",
    ".csv": "text/csv; charset=utf-8",
    ".pdf": "application/pdf",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
  };

  return types[ext] || "application/octet-stream";
}

async function readJsonBody(req) {
  let body = "";

  for await (const chunk of req) {
    body += chunk;

    if (body.length > 64 * 1024) {
      throw new Error("请求内容过大");
    }
  }

  return JSON.parse(body || "{}");
}

async function listDirectory(res, url) {
  const { real, relative } = await safePath(url.searchParams.get("p"));
  const stat = await fsp.stat(real);

  if (!stat.isDirectory()) {
    throw new Error("目标不是目录");
  }

  const entries = await fsp.readdir(real, { withFileTypes: true });

  const files = await Promise.all(
    entries.map(async (entry) => {
      const full = path.join(real, entry.name);
      const st = await fsp.lstat(full);

      let kind = "file";
      if (entry.isDirectory()) kind = "directory";
      if (entry.isSymbolicLink()) kind = "symlink";

      return {
        name: entry.name,
        path: relative ? `${relative}/${entry.name}` : entry.name,
        kind,
        size: st.size,
        modifiedAt: st.mtime.toISOString(),
      };
    }),
  );

  files.sort((a, b) => {
    if (a.kind === "directory" && b.kind !== "directory") return -1;
    if (a.kind !== "directory" && b.kind === "directory") return 1;
    return a.name.localeCompare(b.name, "zh-CN");
  });

  json(res, 200, {
    root: ROOT,
    path: relative,
    files,
  });
}

async function downloadFile(res, url, inline = false) {
  const { real } = await safePath(url.searchParams.get("p"));
  const stat = await fsp.stat(real);

  if (!stat.isFile()) {
    throw new Error("只能下载或预览普通文件");
  }

  const filename = path.basename(real);
  const disposition = inline ? "inline" : "attachment";

  res.writeHead(200, {
    "Content-Type": contentType(filename),
    "Content-Length": stat.size,
    "Content-Disposition": `${disposition}; filename*=UTF-8''${encodeURIComponent(filename)}`,
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "sandbox; default-src 'none'",
  });

  fs.createReadStream(real).pipe(res);
}

async function previewText(res, url) {
  const { real } = await safePath(url.searchParams.get("p"));
  const stat = await fsp.stat(real);

  if (!stat.isFile()) {
    throw new Error("只能预览普通文件");
  }

  if (stat.size > 2 * 1024 * 1024) {
    throw new Error("文本预览仅支持小于 2 MB 的文件，请直接下载");
  }

  const buf = await fsp.readFile(real);

  if (buf.includes(0)) {
    throw new Error("二进制文件不支持文本预览，请直接下载");
  }

  json(res, 200, {
    name: path.basename(real),
    text: buf.toString("utf8"),
  });
}

async function archiveFiles(req, res) {
  const body = await readJsonBody(req);
  const paths = body?.paths;

  if (!Array.isArray(paths) || paths.length === 0) {
    throw new Error("请至少选择一个文件或目录");
  }

  if (paths.length > 100) {
    throw new Error("一次最多压缩 100 个项目");
  }

  const selected = [];

  for (const item of paths) {
    const { real, relative } = await safePath(item);
    const stat = await fsp.stat(real);

    if (!stat.isFile() && !stat.isDirectory()) {
      throw new Error("仅支持普通文件或目录");
    }

    if (!relative) {
      throw new Error("不能直接压缩整个工作区根目录");
    }

    // 避免把 zip 参数解释为选项
    if (relative.split("/").some((part) => part.startsWith("-"))) {
      throw new Error("文件名不能以 - 开头");
    }

    selected.push(relative);
  }

  const name = `workspace-${new Date()
    .toISOString()
    .replace(/[:.]/g, "-")}.zip`;

  res.writeHead(200, {
    "Content-Type": "application/zip",
    "Content-Disposition": `attachment; filename="${name}"`,
    "Cache-Control": "no-store",
  });

  // -y：归档内保留符号链接本身，而不是跟随到链接目标
  const zip = spawn("zip", ["-q", "-y", "-r", "-", ...selected], {
    cwd: ROOT,
    stdio: ["ignore", "pipe", "pipe"],
  });

  zip.stdout.pipe(res);

  zip.stderr.on("data", (data) => {
    console.error(`zip: ${data}`);
  });

  zip.on("error", (err) => {
    console.error("zip 启动失败:", err);
    res.destroy(err);
  });

  zip.on("close", (code) => {
    if (code !== 0) {
      console.error(`zip 退出码异常: ${code}`);
      res.destroy();
    }
  });
}

const FILES_HTML = String.raw`<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>OpenCode 文件浏览器</title>
  <style>
    :root { color-scheme: dark; }
    body {
      margin: 0; font-family: ui-sans-serif, system-ui, sans-serif;
      background: #10131a; color: #e7edf7;
    }
    main { max-width: 1180px; margin: 0 auto; padding: 24px; }
    h1 { font-size: 22px; margin: 0; }
    .bar, .crumb {
      display: flex; align-items: center; gap: 12px; flex-wrap: wrap;
      margin: 16px 0;
    }
    button, a.btn {
      border: 1px solid #3b465b; background: #1c2533; color: #e7edf7;
      border-radius: 7px; padding: 8px 12px; text-decoration: none;
      cursor: pointer; font-size: 14px;
    }
    button:hover, a.btn:hover { background: #2a374b; }
    .path { color: #aebbd0; word-break: break-all; }
    table { width: 100%; border-collapse: collapse; background: #151b26; }
    th, td { padding: 10px; border-bottom: 1px solid #263044; text-align: left; }
    th { color: #9aaac2; font-weight: 600; }
    tr:hover { background: #1a2230; }
    .name { color: #82b9ff; cursor: pointer; text-decoration: none; }
    .muted { color: #8492aa; }
    .actions { display: flex; gap: 8px; flex-wrap: wrap; }
    dialog {
      width: min(1000px, 92vw); height: min(80vh, 800px);
      background: #111824; color: #e7edf7; border: 1px solid #3b465b;
      border-radius: 10px;
    }
    pre {
      white-space: pre-wrap; overflow: auto; height: calc(100% - 54px);
      background: #0c1018; padding: 14px; border-radius: 7px;
    }
    .error { color: #ff9a9a; }
  </style>
</head>
<body>
  <main>
    <div class="bar">
      <h1>📁 OpenCode 工作区文件</h1>
      <a id="opencodeLink" class="btn">返回 OpenCode</a>
      <button id="zipButton">下载选中项 ZIP</button>
      <button id="refreshButton">刷新</button>
    </div>

    <div class="crumb">
      <button id="upButton">上级目录</button>
      <span class="path" id="pathLabel">加载中…</span>
      <span class="error" id="error"></span>
    </div>

    <table>
      <thead>
        <tr>
          <th style="width:42px"><input id="selectAll" type="checkbox"></th>
          <th>名称</th>
          <th>类型</th>
          <th>大小</th>
          <th>修改时间</th>
          <th>操作</th>
        </tr>
      </thead>
      <tbody id="files"></tbody>
    </table>
  </main>

  <dialog id="previewDialog">
    <button id="closePreview">关闭</button>
    <pre id="previewContent"></pre>
  </dialog>

  <script>
    const BASE = location.pathname.replace(/\/$/, "");
    const COMPONENT_ROOT = BASE.endsWith("/files")
      ? (BASE.slice(0, -"/files".length) || "/")
      : "/";

    const state = { path: "" };
    const tbody = document.getElementById("files");
    const error = document.getElementById("error");
    const pathLabel = document.getElementById("pathLabel");
    const dialog = document.getElementById("previewDialog");
    const previewContent = document.getElementById("previewContent");

    document.getElementById("opencodeLink").href = COMPONENT_ROOT;
    document.getElementById("closePreview").onclick = () => dialog.close();

    function formatSize(size) {
      if (size < 1024) return size + " B";
      if (size < 1024 * 1024) return (size / 1024).toFixed(1) + " KB";
      if (size < 1024 * 1024 * 1024) return (size / 1024 / 1024).toFixed(1) + " MB";
      return (size / 1024 / 1024 / 1024).toFixed(2) + " GB";
    }

    function childPath(parent, name) {
      return parent ? parent + "/" + name : name;
    }

    function go(path) {
      const target = BASE + "/?p=" + encodeURIComponent(path || "");
      history.pushState({}, "", target);
      load();
    }

    function createButton(text, handler) {
      const button = document.createElement("button");
      button.textContent = text;
      button.onclick = handler;
      return button;
    }

    async function load() {
      error.textContent = "";
      const p = new URL(location.href).searchParams.get("p") || "";
      state.path = p;
      pathLabel.textContent = "/" + (p || "");

      try {
        const response = await fetch(
          BASE + "/api/list?p=" + encodeURIComponent(p)
        );

        const data = await response.json();
        if (!response.ok) throw new Error(data.error || "读取目录失败");

        tbody.replaceChildren();

        for (const item of data.files) {
          const tr = document.createElement("tr");

          const checkTd = document.createElement("td");
          if (item.kind !== "symlink") {
            const check = document.createElement("input");
            check.type = "checkbox";
            check.className = "file-check";
            check.value = item.path;
            checkTd.append(check);
          }
          tr.append(checkTd);

          const nameTd = document.createElement("td");
          const name = document.createElement("a");
          name.className = "name";
          name.textContent = item.kind === "directory" ? "📂 " + item.name : "📄 " + item.name;

          if (item.kind === "directory") {
            name.href = BASE + "/?p=" + encodeURIComponent(item.path);
            name.onclick = (event) => {
              event.preventDefault();
              go(item.path);
            };
          } else {
            name.href = BASE + "/api/download?p=" + encodeURIComponent(item.path);
          }

          nameTd.append(name);
          tr.append(nameTd);

          const typeTd = document.createElement("td");
          typeTd.textContent =
            item.kind === "directory" ? "目录" :
            item.kind === "symlink" ? "符号链接（不可访问）" : "文件";
          tr.append(typeTd);

          const sizeTd = document.createElement("td");
          sizeTd.className = "muted";
          sizeTd.textContent = item.kind === "directory" ? "-" : formatSize(item.size);
          tr.append(sizeTd);

          const timeTd = document.createElement("td");
          timeTd.className = "muted";
          timeTd.textContent = new Date(item.modifiedAt).toLocaleString();
          tr.append(timeTd);

          const actionTd = document.createElement("td");
          const actions = document.createElement("div");
          actions.className = "actions";

          if (item.kind === "file") {
            actions.append(createButton("文本预览", async () => {
              try {
                const r = await fetch(
                  BASE + "/api/preview?p=" + encodeURIComponent(item.path)
                );
                const d = await r.json();
                if (!r.ok) throw new Error(d.error || "预览失败");
                previewContent.textContent = d.text;
                dialog.showModal();
              } catch (e) {
                error.textContent = e.message;
              }
            }));

            const download = document.createElement("a");
            download.className = "btn";
            download.textContent = "下载";
            download.href = BASE + "/api/download?p=" + encodeURIComponent(item.path);
            actions.append(download);
          }

          actionTd.append(actions);
          tr.append(actionTd);
          tbody.append(tr);
        }
      } catch (e) {
        error.textContent = e.message;
      }
    }

    document.getElementById("upButton").onclick = () => {
      if (!state.path) return;
      const parts = state.path.split("/");
      parts.pop();
      go(parts.join("/"));
    };

    document.getElementById("refreshButton").onclick = load;

    document.getElementById("selectAll").onchange = (event) => {
      document.querySelectorAll(".file-check").forEach((checkbox) => {
        checkbox.checked = event.target.checked;
      });
    };

    document.getElementById("zipButton").onclick = async () => {
      const paths = [...document.querySelectorAll(".file-check:checked")]
        .map((item) => item.value);

      if (!paths.length) {
        error.textContent = "请先勾选至少一个文件或目录";
        return;
      }

      try {
        error.textContent = "正在生成 ZIP，请稍候…";

        const response = await fetch(BASE + "/api/archive", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ paths })
        });

        if (!response.ok) {
          const data = await response.json();
          throw new Error(data.error || "ZIP 创建失败");
        }

        const blob = await response.blob();
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = "workspace.zip";
        document.body.append(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
        error.textContent = "";
      } catch (e) {
        error.textContent = e.message;
      }
    };

    window.onpopstate = load;
    load();
  </script>
</body>
</html>`;

async function handleFiles(req, res, url) {
  if (!requireAuth(req, res)) return;

  if (url.pathname === "/files") {
    res.writeHead(302, { Location: "/files/" });
    res.end();
    return;
  }

  if (req.method === "GET" && url.pathname === "/files/") {
    res.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "Content-Security-Policy":
        "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:;",
    });
    res.end(FILES_HTML);
    return;
  }

  if (req.method === "GET" && url.pathname === "/files/api/list") {
    await listDirectory(res, url);
    return;
  }

  if (req.method === "GET" && url.pathname === "/files/api/download") {
    await downloadFile(res, url, false);
    return;
  }

  if (req.method === "GET" && url.pathname === "/files/api/preview") {
    await previewText(res, url);
    return;
  }

  if (req.method === "POST" && url.pathname === "/files/api/archive") {
    await archiveFiles(req, res);
    return;
  }

  fail(res, 404, "文件浏览器路径不存在");
}

function proxyToOpenCode(req, res) {
  const upstream = http.request(
    {
      hostname: "127.0.0.1",
      port: OPENCODE_PORT,
      method: req.method,
      path: req.url,
      headers: {
        ...req.headers,
        host: `127.0.0.1:${OPENCODE_PORT}`,
      },
    },
    (upstreamRes) => {
      res.writeHead(upstreamRes.statusCode || 502, upstreamRes.headers);
      upstreamRes.pipe(res);
    },
  );

  upstream.on("error", (err) => {
    console.error("OpenCode 代理失败:", err.message);

    if (!res.headersSent) {
      res.writeHead(502, { "Content-Type": "text/plain; charset=utf-8" });
    }

    res.end("OpenCode 服务暂不可用，请稍后刷新。");
  });

  req.pipe(upstream);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");

  try {
    if (isFilesRoute(url.pathname)) {
      await handleFiles(req, res, url);
    } else {
      proxyToOpenCode(req, res);
    }
  } catch (err) {
    console.error(err);

    if (!res.headersSent) {
      fail(res, 400, err.message || "请求处理失败");
    } else {
      res.destroy();
    }
  }
});

// 兼容 OpenCode 未来可能使用 WebSocket 的情况
server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url, "http://localhost");

  if (isFilesRoute(url.pathname)) {
    socket.destroy();
    return;
  }

  const upstream = net.connect(OPENCODE_PORT, "127.0.0.1");

  upstream.on("connect", () => {
    let headers = `${req.method} ${req.url} HTTP/${req.httpVersion}\r\n`;

    for (let i = 0; i < req.rawHeaders.length; i += 2) {
      headers += `${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}\r\n`;
    }

    headers += "\r\n";

    upstream.write(headers);
    if (head?.length) upstream.write(head);

    socket.pipe(upstream).pipe(socket);
  });

  upstream.on("error", () => socket.destroy());
  socket.on("error", () => upstream.destroy());
});

const opencode = spawn(
  "opencode",
  [
    "web",
    "--port",
    String(OPENCODE_PORT),
    "--hostname",
    "127.0.0.1",
  ],
  {
    cwd: ROOT,
    env: process.env,
    stdio: "inherit",
  },
);

opencode.on("exit", (code, signal) => {
  console.error(`OpenCode 已退出，code=${code}, signal=${signal}`);
  process.exit(code || 1);
});

function shutdown(signal) {
  console.log(`收到 ${signal}，正在停止服务…`);
  server.close(() => process.exit(0));
  opencode.kill(signal);

  setTimeout(() => process.exit(1), 8000).unref();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

server.listen(PUBLIC_PORT, "0.0.0.0", () => {
  console.log(`OpenCode 网关: http://0.0.0.0:${PUBLIC_PORT}`);
  console.log(`文件浏览器: /files，根目录: ${ROOT}`);
});
