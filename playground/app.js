import { McpClient, AppBridge, bearer, oauth, getUiResourceUri, isModelVisible, VERSION } from "./lib/mcp-lite-browser.min.js";
import { createDemoServer } from "./demo-server.js";

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const pretty = (v) => JSON.stringify(v, null, 2);

const state = { client: null, bridge: null, tools: [], resources: [], prompts: [], tab: "tools", selected: null, log: [], t0: Date.now(), abort: null };

fetch("./lib/size.json").then((r) => r.json()).then((s) => { $("#libsize").textContent = (s["mcp-lite-browser.min.js"].gzip / 1024).toFixed(1) + " kB gzip"; }).catch(() => {});

// ---------------------------------------------------------------- traffic inspector
function logMessage(direction, msg, meta) {
  state.log.push({ direction, msg, ...meta });
  const label = msg.method
    ? `${esc(msg.method)}${msg.id !== undefined ? ` <span class="id">#${esc(msg.id)}</span>` : ""}`
    : msg.error ? `<span class="err">error #${esc(msg.id)} ${esc(msg.error.code)} ${esc(msg.error.message)}</span>` : `result <span class="id">#${esc(msg.id)}</span>`;
  const li = document.createElement("li");
  li.innerHTML = `<details><summary><span class="dir ${direction}">${direction === "out" ? "→" : "←"}</span><span class="m">${label}</span><span class="via">${esc(meta.via)} +${((meta.time - state.t0) / 1000).toFixed(2)}s</span></summary><pre>${esc(pretty(msg))}</pre></details>`;
  const log = $("#log");
  const atBottom = log.scrollTop + log.clientHeight >= log.scrollHeight - 30;
  log.append(li);
  if (atBottom) log.scrollTop = log.scrollHeight;
  $("#n-msgs").textContent = `${state.log.length} message${state.log.length === 1 ? "" : "s"}`;
}
$("#clear-log").onclick = () => { state.log = []; $("#log").innerHTML = ""; $("#n-msgs").textContent = "0 messages"; };
$("#copy-log").onclick = async () => { await navigator.clipboard.writeText(pretty(state.log)); $("#copy-log").textContent = "Copied"; setTimeout(() => ($("#copy-log").textContent = "Copy JSON"), 1200); };

// ---------------------------------------------------------------- elicitation & sampling (human in the loop)
function fieldFor(name, schema = {}, required = false) {
  const id = `f-${name}`;
  const title = esc(schema.title || name) + (required ? ' <span class="req">*</span>' : "");
  let input;
  const def = schema.default;
  if (schema.enum || schema.oneOf) {
    const opts = schema.enum ? schema.enum.map((v) => [v, v]) : schema.oneOf.map((o) => [o.const, o.title || o.const]);
    input = `<select id="${id}" data-name="${esc(name)}" data-type="enum">${opts.map(([v, l]) => `<option value="${esc(v)}" ${v === def ? "selected" : ""}>${esc(l)}</option>`).join("")}</select>`;
  } else if (schema.type === "boolean") {
    input = `<input type="checkbox" id="${id}" data-name="${esc(name)}" data-type="boolean" ${def ? "checked" : ""}>`;
  } else if (schema.type === "number" || schema.type === "integer") {
    input = `<input type="number" id="${id}" data-name="${esc(name)}" data-type="${schema.type}" ${schema.type === "integer" ? 'step="1"' : 'step="any"'} ${schema.minimum !== undefined ? `min="${schema.minimum}"` : ""} ${schema.maximum !== undefined ? `max="${schema.maximum}"` : ""} value="${def ?? ""}">`;
  } else if (schema.type === "string" || !schema.type) {
    input = `<input type="text" id="${id}" data-name="${esc(name)}" data-type="string" value="${esc(def ?? "")}" placeholder="${esc(schema.description || "")}">`;
  } else {
    input = `<textarea id="${id}" data-name="${esc(name)}" data-type="json" rows="3" placeholder="JSON">${def !== undefined ? esc(pretty(def)) : ""}</textarea>`;
  }
  return `<div class="field"><label for="${id}">${title}</label>${input}</div>`;
}
function readFields(root) {
  const out = {};
  for (const el of root.querySelectorAll("[data-name]")) {
    const t = el.dataset.type, name = el.dataset.name;
    if (t === "boolean") { out[name] = el.checked; continue; }
    if (el.value === "") continue;
    if (t === "number" || t === "integer") out[name] = Number(el.value);
    else if (t === "json") out[name] = JSON.parse(el.value);
    else out[name] = el.value;
  }
  return out;
}

function onElicit(params) {
  return new Promise((resolve) => {
    const dlg = $("#elicit-dialog");
    $("#elicit-message").textContent = params.message;
    const fields = $("#elicit-fields");
    if (params.mode === "url") {
      fields.innerHTML = `<p>Open <a href="${esc(params.url)}" target="_blank" rel="noopener noreferrer">${esc(params.url)}</a> to continue.</p>`;
    } else {
      const s = params.requestedSchema || {};
      fields.innerHTML = Object.entries(s.properties || {}).map(([k, v]) => fieldFor(k, v, (s.required || []).includes(k))).join("");
    }
    dlg.onclose = () => {
      const action = dlg.returnValue || "cancel";
      resolve(action === "accept" && params.mode !== "url" ? { action, content: readFields(fields) } : { action });
    };
    dlg.showModal();
  });
}

function onSampling(params) {
  return new Promise((resolve, reject) => {
    const dlg = $("#sampling-dialog");
    const text = params.messages.map((m) => `${m.role}: ${[].concat(m.content).map((c) => c.text ?? `[${c.type}]`).join(" ")}`).join("\n");
    $("#sampling-prompt").textContent = (params.systemPrompt ? `system: ${params.systemPrompt}\n` : "") + text;
    $("#sampling-reply").value = "";
    dlg.onclose = () => {
      if (dlg.returnValue !== "send") return reject(Object.assign(new Error("User rejected the sampling request"), { code: -1 }));
      resolve({ role: "assistant", content: { type: "text", text: $("#sampling-reply").value || "(empty)" }, model: "human-in-the-playground", stopReason: "endTurn" });
    };
    dlg.showModal();
  });
}

// ---------------------------------------------------------------- connect
$("#auth").onchange = () => { $("#token").hidden = $("#auth").value !== "bearer"; };

function setStatus(html, kind = "") { $("#status").innerHTML = `<span class="pill"><span class="dot ${kind}"></span>${html}</span>`; }

async function connect(url, { demo = false } = {}) {
  await disconnect();
  state.t0 = Date.now();
  const authMode = $("#auth").value;
  const auth = demo ? undefined
    : authMode === "bearer" ? bearer($("#token").value.trim())
    : authMode === "oauth" ? oauth({ redirectUri: new URL("callback.html", location.href).href, clientMetadataUrl: new URL("oauth-client.json", location.href).href, clientName: "MCP Playground" })
    : undefined;
  const client = new McpClient(url, {
    fetch: demo ? createDemoServer() : undefined,
    auth, onElicit, onSampling, timeout: 120000,
    clientInfo: { name: "mcp-playground", version: VERSION },
    onTraffic: logMessage,
  });
  state.client = client;
  setStatus("connecting…", "busy");
  $("#connect").disabled = true;
  try {
    const init = await client.connect();
    const caps = Object.keys(init.capabilities || {}).join(", ") || "none";
    $("#status").innerHTML = [
      `<span class="pill"><span class="dot ok"></span>${esc(init.serverInfo?.title || init.serverInfo?.name)} ${esc(init.serverInfo?.version || "")}</span>`,
      `<span class="pill">MCP ${esc(client.negotiatedVersion)}</span>`,
      client.sessionId ? `<span class="pill">session ${esc(client.sessionId.slice(0, 12))}…</span>` : `<span class="pill">stateless</span>`,
      `<span class="pill">capabilities: ${esc(caps)}</span>`,
      init.instructions ? `<span class="muted">${esc(init.instructions)}</span>` : "",
    ].join("");
    $("#disconnect").hidden = false;
    if (!demo) client.listen().catch(() => {});
    for (const kind of ["tools", "resources", "prompts"]) client.on(`notifications/${kind}/list_changed`, () => loadLists());
    await loadLists();
    const u = new URL(location.href);
    if (demo) { u.searchParams.delete("url"); u.searchParams.set("demo", "1"); } else { u.searchParams.delete("demo"); u.searchParams.set("url", url); }
    history.replaceState(null, "", u);
  } catch (e) {
    const hint = e instanceof TypeError ? " (network or CORS error: the server must allow this origin and expose Mcp-Session-Id)" : "";
    setStatus(`failed: ${esc(e.message)}${esc(hint)}`, "err");
    state.client = null;
  } finally {
    $("#connect").disabled = false;
  }
}

async function disconnect() {
  state.bridge?.destroy(); state.bridge = null;
  if (state.client) await state.client.close().catch(() => {});
  state.client = null; state.tools = []; state.resources = []; state.prompts = []; state.selected = null;
  $("#disconnect").hidden = true;
  renderList();
}

async function loadLists() {
  const c = state.client; const caps = c.serverCapabilities || {};
  const safe = (p) => p.catch(() => []);
  [state.tools, state.resources, state.prompts] = await Promise.all([
    caps.tools ? safe(c.listAllTools()) : [], caps.resources ? safe(c.listAllResources()) : [], caps.prompts ? safe(c.listAllPrompts()) : [],
  ]);
  renderList();
  if (!state.selected && state.tools.length) select("tools", state.tools.find(isModelVisible) || state.tools[0]);
}

$("#connect-form").onsubmit = (e) => { e.preventDefault(); const url = $("#url").value.trim(); if (url) connect(url); };
$("#demo").onclick = () => { $("#url").value = "demo://in-browser/mcp"; connect("http://demo.invalid/mcp", { demo: true }); };
$("#disconnect").onclick = () => { disconnect(); setStatus("Disconnected."); };

// ---------------------------------------------------------------- lists
for (const b of document.querySelectorAll(".tabs button")) b.onclick = () => { state.tab = b.dataset.tab; renderList(); };

function renderList() {
  for (const b of document.querySelectorAll(".tabs button")) b.classList.toggle("on", b.dataset.tab === state.tab);
  for (const k of ["tools", "resources", "prompts"]) $(`#n-${k}`).textContent = state.client ? state[k].length : "";
  const items = state[state.tab];
  const ul = $("#items");
  if (!state.client) { ul.innerHTML = `<li class="empty">Connect to a server to see its ${state.tab}.</li>`; return; }
  if (!items.length) { ul.innerHTML = `<li class="empty">No ${state.tab}.</li>`; return; }
  ul.innerHTML = "";
  for (const it of items) {
    const li = document.createElement("li");
    const tags = state.tab === "tools"
      ? (getUiResourceUri(it) ? '<span class="tag app">MCP App</span>' : "") + (!isModelVisible(it) ? '<span class="tag">app-only</span>' : "")
      : it.mimeType === "text/html;profile=mcp-app" ? '<span class="tag app">MCP App</span>' : "";
    li.innerHTML = `<div class="name">${esc(it.name || it.uri)}${tags}</div><div class="desc">${esc(it.description || it.uri || "")}</div>`;
    if (state.selected === it) li.classList.add("sel");
    li.onclick = () => select(state.tab, it);
    ul.append(li);
  }
}

function select(kind, item) {
  state.selected = item; state.tab = kind; renderList();
  state.bridge?.destroy(); state.bridge = null;
  if (kind === "tools") renderTool(item);
  else if (kind === "resources") renderResource(item);
  else renderPrompt(item);
}

// ---------------------------------------------------------------- tool detail
function renderTool(tool) {
  const s = tool.inputSchema || {};
  const props = Object.entries(s.properties || {});
  const ui = getUiResourceUri(tool);
  $("#detail").innerHTML = `
    <h2>${esc(tool.name)}</h2>
    <p class="about">${esc(tool.description || "")}${ui ? ` <span class="tag app">renders ${esc(ui)}</span>` : ""}${!isModelVisible(tool) ? ' <span class="tag">visibility: app only</span>' : ""}</p>
    <form id="tool-form">${props.map(([k, v]) => fieldFor(k, v, (s.required || []).includes(k))).join("") || '<p class="muted">No arguments.</p>'}
      <div class="actions"><button class="primary" type="submit" id="run">Run tool</button><button type="button" id="cancel" hidden>Cancel</button>
      <div class="progress" hidden id="progress"><i></i></div><span class="progress-label" id="progress-label"></span></div>
    </form><div id="out"></div>`;
  $("#tool-form").onsubmit = async (e) => {
    e.preventDefault();
    let args;
    try { args = readFields($("#tool-form")); } catch (err) { return showResult({ error: "Invalid JSON: " + err.message }); }
    runTool(tool, args);
  };
}

async function runTool(tool, args) {
  const ac = new AbortController();
  state.abort = ac;
  $("#run").disabled = true; $("#cancel").hidden = false;
  $("#cancel").onclick = () => ac.abort(new Error("Cancelled from the playground"));
  $("#progress").hidden = false; $("#progress > i").style.width = "0"; $("#progress-label").textContent = "running…";
  $("#out").innerHTML = "";
  const ui = getUiResourceUri(tool);
  try {
    const onProgress = (p) => {
      if (p.total) $("#progress > i").style.width = `${Math.round((p.progress / p.total) * 100)}%`;
      $("#progress-label").textContent = p.message || `${p.progress}${p.total ? "/" + p.total : ""}`;
    };
    let result;
    if (ui) {
      const wrap = document.createElement("div");
      wrap.className = "result";
      wrap.innerHTML = `<h4><span>MCP App · ${esc(ui)}</span><span>sandboxed iframe</span></h4><div class="app-wrap"><iframe class="app-frame" title="MCP App view"></iframe></div>`;
      $("#out").append(wrap);
      const iframe = wrap.querySelector("iframe");
      const read = await state.client.readResource(ui, { signal: ac.signal });
      state.bridge = new AppBridge(iframe, {
        client: state.client, tools: state.tools, hostContext: hostContext(tool),
        onSize: (h) => { if (h) iframe.style.height = `${Math.min(h + 4, 900)}px`; },
        onMessage: async (p) => { chatNote(`The app sent a message to the conversation: “${p.content?.text ?? ""}”`); },
        onUpdateModelContext: async (p) => { chatNote(`The app updated the model context: ${JSON.stringify(p.structuredContent ?? p.content)}`); },
        onRequestDisplayMode: (mode) => { setDisplayMode(wrap.querySelector(".app-wrap"), mode); return mode; },
        onLog: (p) => chatNote(`App log [${p.level}]: ${typeof p.data === "string" ? p.data : JSON.stringify(p.data)}`),
      });
      state.bridge.loadResource(read.contents[0]);
      state.bridge.sendToolInput(args);
      result = await state.client.callTool(tool.name, args, { signal: ac.signal, onProgress });
      state.bridge.sendToolResult(result);
    } else {
      result = await state.client.callTool(tool.name, args, { signal: ac.signal, onProgress });
    }
    showResult(result);
  } catch (e) {
    state.bridge?.sendToolCancelled(e.message);
    showResult({ error: `${e.message}${e.code !== undefined ? ` (code ${e.code})` : ""}` });
  } finally {
    $("#run") && ($("#run").disabled = false);
    $("#cancel") && ($("#cancel").hidden = true);
    $("#progress-label") && ($("#progress-label").textContent = ac.signal.aborted ? "cancelled" : "done");
    state.abort = null;
  }
}

function hostContext(tool) {
  const dark = matchMedia("(prefers-color-scheme: dark)").matches;
  const css = getComputedStyle(document.documentElement);
  const v = (n) => css.getPropertyValue(n).trim();
  return {
    toolInfo: { tool }, theme: dark ? "dark" : "light", displayMode: "inline", availableDisplayModes: ["inline", "fullscreen"],
    containerDimensions: { maxHeight: 900 }, locale: navigator.language, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone, platform: "web",
    deviceCapabilities: { touch: matchMedia("(pointer: coarse)").matches, hover: matchMedia("(hover: hover)").matches },
    styles: { variables: {
      "--color-background-primary": v("--panel"), "--color-background-secondary": v("--soft"), "--color-text-primary": v("--ink"),
      "--color-text-secondary": v("--ink-2"), "--color-border-primary": v("--line"), "--font-sans": v("--sans"), "--font-mono": v("--mono"),
    } },
  };
}

function setDisplayMode(wrap, mode) {
  wrap.classList.toggle("fullscreen", mode === "fullscreen");
  document.querySelector(".app-close")?.remove();
  if (mode === "fullscreen") {
    const b = document.createElement("button");
    b.className = "app-close"; b.textContent = "Exit fullscreen";
    b.onclick = () => { setDisplayMode(wrap, "inline"); state.bridge?.setHostContext({ displayMode: "inline" }); };
    document.body.append(b);
  }
}

function chatNote(text) {
  const d = document.createElement("div");
  d.className = "chat-note"; d.textContent = text;
  $("#out")?.append(d);
}

function showResult(r) {
  const out = $("#out"); if (!out) return;
  const box = document.createElement("div");
  if (r.error) { box.className = "result error"; box.innerHTML = `<h4><span>Error</span></h4><pre>${esc(r.error)}</pre>`; out.append(box); return; }
  box.className = "result" + (r.isError ? " error" : "");
  const text = (r.content || []).map((c) => (c.type === "text" ? c.text : `[${c.type}${c.mimeType ? " " + c.mimeType : ""}]`)).join("\n");
  box.innerHTML = `<h4><span>${r.isError ? "Tool error (isError: true)" : "Result · content"}</span></h4><pre>${esc(text || "(empty)")}</pre>`
    + (r.structuredContent ? `<h4><span>structuredContent</span></h4><pre>${esc(pretty(r.structuredContent))}</pre>` : "")
    + (r.messages ? `<h4><span>messages</span></h4><pre>${esc(pretty(r.messages))}</pre>` : "");
  out.append(box);
}

// ---------------------------------------------------------------- resources & prompts
async function renderResource(res) {
  $("#detail").innerHTML = `<h2>${esc(res.name || res.uri)}</h2><p class="about"><code>${esc(res.uri)}</code> ${esc(res.mimeType || "")}<br>${esc(res.description || "")}</p><div id="out"></div>`;
  try {
    const r = await state.client.readResource(res.uri);
    const c = r.contents[0] || {};
    if (c.mimeType === "text/html;profile=mcp-app") {
      const wrap = document.createElement("div");
      wrap.className = "result";
      wrap.innerHTML = `<h4><span>MCP App preview (no tool data)</span><span>CSP enforced</span></h4><div class="app-wrap"><iframe class="app-frame" title="MCP App view"></iframe></div>`;
      $("#out").append(wrap);
      const iframe = wrap.querySelector("iframe");
      state.bridge = new AppBridge(iframe, { client: state.client, tools: state.tools, hostContext: hostContext(undefined), onSize: (h) => { if (h) iframe.style.height = `${h + 4}px`; } });
      state.bridge.loadResource(c);
    }
    showResult({ content: [{ type: "text", text: c.text ?? (c.blob ? `[base64 blob, ${c.blob.length} chars]` : "") }], structuredContent: c._meta ? { _meta: c._meta } : undefined });
  } catch (e) { showResult({ error: e.message }); }
}

function renderPrompt(p) {
  $("#detail").innerHTML = `<h2>${esc(p.name)}</h2><p class="about">${esc(p.description || "")}</p>
    <form id="prompt-form">${(p.arguments || []).map((a) => fieldFor(a.name, { type: "string", description: a.description }, a.required)).join("")}
    <div class="actions"><button class="primary" type="submit">Get prompt</button></div></form><div id="out"></div>`;
  $("#prompt-form").onsubmit = async (e) => {
    e.preventDefault();
    try { showResult({ content: [], messages: (await state.client.getPrompt(p.name, readFields($("#prompt-form")))).messages }); }
    catch (err) { showResult({ error: err.message }); }
  };
}

// ---------------------------------------------------------------- deep links
const params = new URLSearchParams(location.search);
if (params.get("url")) { $("#url").value = params.get("url"); connect(params.get("url")); }
else if (params.get("demo")) $("#demo").click();
