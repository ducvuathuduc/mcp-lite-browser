// An MCP server that runs entirely inside the page: a `fetch` implementation speaking Streamable HTTP
// (spec 2025-11-25) with real SSE streams. It lets the playground work with zero setup and no network.
// Every byte still goes through mcp-lite-browser's real HTTP/SSE code path.

const WEATHER_APP = `<!doctype html><html><head><meta charset="utf-8"><style>
:root{color-scheme:light dark}
body{margin:0;font:14px/1.4 var(--font-sans,ui-sans-serif,system-ui,sans-serif);color:var(--color-text-primary,#16181d);background:transparent}
.card{padding:18px 20px;border-radius:12px;background:var(--color-background-primary,#fff);border:1px solid var(--color-border-primary,#e3e5e8)}
.top{display:flex;justify-content:space-between;align-items:baseline;gap:12px}
.city{font-weight:600;font-size:15px}.cond{color:var(--color-text-secondary,#5c6370)}
.t{font-size:52px;font-weight:650;letter-spacing:-2px;line-height:1;margin:14px 0 6px}
.days{display:grid;grid-template-columns:repeat(5,1fr);gap:6px;margin-top:14px}
.d{text-align:center;padding:8px 0;border-radius:8px;background:var(--color-background-secondary,#f4f5f7);font-size:12px}
.d b{display:block;font-size:14px;margin-top:2px}
.row{display:flex;gap:8px;margin-top:14px;flex-wrap:wrap}
button{font:inherit;font-size:12px;padding:6px 10px;border-radius:8px;border:1px solid var(--color-border-primary,#d5d8dc);background:var(--color-background-primary,#fff);color:inherit;cursor:pointer}
button:hover{background:var(--color-background-secondary,#f4f5f7)}
.muted{color:var(--color-text-secondary,#5c6370);font-size:12px;margin-top:8px}
</style></head><body><div class="card">
<div class="top"><div class="city" id="city">…</div><div class="cond" id="cond"></div></div>
<div class="t" id="t">–</div><div class="days" id="days"></div>
<div class="row"><button id="refresh">↻ Refresh (app-only tool)</button><button id="full">⤢ Fullscreen</button><button id="ask">Ask the assistant</button></div>
<div class="muted" id="note">Rendered by AppBridge in a sandboxed iframe with a CSP from the resource's _meta.ui.</div>
</div><script>
let id=0;const wait={};let args={};
const req=(method,params)=>{const i=++id;parent.postMessage({jsonrpc:"2.0",id:i,method,params},"*");return new Promise(r=>wait[i]=r)};
const note=(m,p)=>parent.postMessage({jsonrpc:"2.0",method:m,params:p},"*");
function render(r){const s=r.structuredContent;if(!s)return;
 document.getElementById("city").textContent=s.city;document.getElementById("cond").textContent=s.condition;
 document.getElementById("t").textContent=s.temperature+"°C";
 document.getElementById("days").innerHTML=s.forecast.map(f=>'<div class="d">'+f.day+'<b>'+f.high+'°</b></div>').join("");
 note("ui/notifications/size-changed",{height:document.documentElement.scrollHeight});}
addEventListener("message",e=>{const m=e.data;if(!m||m.jsonrpc!=="2.0")return;
 if(m.id!=null&&wait[m.id]){wait[m.id](m);delete wait[m.id];return}
 if(m.method==="ui/notifications/tool-input")args=m.params.arguments||{};
 if(m.method==="ui/notifications/tool-result")render(m.params);
 if(m.method==="ui/notifications/host-context-changed"&&m.params.theme)document.documentElement.style.colorScheme=m.params.theme;
 if(m.method==="ui/resource-teardown")parent.postMessage({jsonrpc:"2.0",id:m.id,result:{}},"*");});
document.getElementById("refresh").onclick=async()=>{const r=await req("tools/call",{name:"refresh_weather",arguments:args});if(r.result)render(r.result);
 note("notifications/message",{level:"info",data:"refresh clicked"});};
document.getElementById("full").onclick=async()=>{const r=await req("ui/request-display-mode",{mode:"fullscreen"});document.getElementById("note").textContent="Host answered display mode: "+r.result.mode;};
document.getElementById("ask").onclick=()=>req("ui/message",{role:"user",content:{type:"text",text:"What should I wear in "+(args.city||"this city")+" today?"}});
req("ui/initialize",{protocolVersion:"2026-01-26",appInfo:{name:"weather-card",version:"1.0.0"},appCapabilities:{availableDisplayModes:["inline","fullscreen"]}})
 .then(r=>{const v=(r.result.hostContext.styles||{}).variables||{};for(const k in v)if(v[k])document.documentElement.style.setProperty(k,v[k]);
 note("ui/notifications/initialized",{});});
</script></body></html>`;

const CITIES = { "Ho Chi Minh City": 32, Hanoi: 27, "Da Nang": 30, Tokyo: 21, Seattle: 14, Berlin: 12 };
const condition = (t) => (t > 30 ? "Hot, scattered storms" : t > 24 ? "Warm, partly cloudy" : t > 16 ? "Mild, clear" : "Cool, light rain");

function weather(city) {
  const base = CITIES[city] ?? 22;
  const jitter = () => Math.round((Math.random() - 0.5) * 4);
  const t = base + jitter();
  const days = ["Mon", "Tue", "Wed", "Thu", "Fri"].map((day) => ({ day, high: base + jitter() }));
  return {
    content: [{ type: "text", text: `${city}: ${t}°C, ${condition(t)}. (Demo data, not a real forecast.)` }],
    structuredContent: { city, temperature: t, condition: condition(t), forecast: days },
  };
}

const TOOLS = [
  {
    name: "get_weather", title: "Get weather",
    description: "Weather card for a city, rendered as an MCP App (demo data).",
    inputSchema: { type: "object", properties: { city: { type: "string", enum: Object.keys(CITIES), default: "Ho Chi Minh City" } }, required: ["city"] },
    _meta: { ui: { resourceUri: "ui://demo/weather.html" } },
  },
  {
    name: "refresh_weather", description: "App-only tool the weather card calls from inside the iframe.",
    inputSchema: { type: "object", properties: { city: { type: "string" } } },
    _meta: { ui: { resourceUri: "ui://demo/weather.html", visibility: ["app"] } },
  },
  {
    name: "long_task", title: "Long task",
    description: "Streams notifications/progress over SSE. Press Cancel to send notifications/cancelled.",
    inputSchema: { type: "object", properties: { steps: { type: "integer", minimum: 1, maximum: 50, default: 8 } } },
  },
  {
    name: "book_table", title: "Book a table",
    description: "Asks you for details mid-call with elicitation/create (form mode).",
    inputSchema: { type: "object", properties: { restaurant: { type: "string", default: "Pho 2000" } } },
  },
  {
    name: "summarize", title: "Summarize (sampling)",
    description: "Asks the client's model for a completion with sampling/createMessage. You play the model.",
    inputSchema: { type: "object", properties: { text: { type: "string", default: "MCP lets apps expose tools to AI models." } } },
  },
  {
    name: "echo", description: "Returns its input, as text and structuredContent.",
    inputSchema: { type: "object", properties: { message: { type: "string", default: "hello" }, loud: { type: "boolean" } }, required: ["message"] },
    outputSchema: { type: "object", properties: { message: { type: "string" } } },
  },
];

const RESOURCES = [
  { uri: "ui://demo/weather.html", name: "weather-card", mimeType: "text/html;profile=mcp-app", description: "The weather MCP App view" },
  { uri: "demo://readme", name: "readme", mimeType: "text/markdown", description: "About this demo server" },
];

const PROMPTS = [{ name: "trip_brief", description: "Packing advice for a trip", arguments: [{ name: "city", required: true }] }];

export function createDemoServer({ latency = 60 } = {}) {
  const enc = new TextEncoder();
  const sessionId = "demo-" + Math.random().toString(36).slice(2, 10);
  let eventSeq = 0;
  let serverReqSeq = 0;
  const waitingForClient = new Map(); // server→client request id → resolve
  const running = new Map(); // client request id → { cancelled }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json", "mcp-session-id": sessionId } });

  function sseResponse(run) {
    let controller;
    const stream = new ReadableStream({ start(c) { controller = c; } });
    const send = (msg) => controller.enqueue(enc.encode(`id: ${sessionId}-${++eventSeq}\nevent: message\ndata: ${JSON.stringify(msg)}\n\n`));
    controller.enqueue(enc.encode(`id: ${sessionId}-${++eventSeq}\ndata:\n\n`)); // priming event (spec 2025-11-25)
    run(send).finally(() => controller.close());
    return new Response(stream, { headers: { "content-type": "text/event-stream", "mcp-session-id": sessionId } });
  }

  const askClient = (send, method, params) => {
    const id = `srv-${++serverReqSeq}`;
    return new Promise((resolve) => { waitingForClient.set(id, resolve); send({ jsonrpc: "2.0", id, method, params }); });
  };

  async function callTool(msg, send) {
    const { name, arguments: args = {} } = msg.params;
    const token = msg.params._meta?.progressToken;
    const state = { cancelled: false };
    running.set(msg.id, state);
    try {
      switch (name) {
        case "get_weather":
        case "refresh_weather":
          await sleep(latency * 3);
          return weather(args.city || "Ho Chi Minh City");
        case "long_task": {
          const steps = Math.max(1, Math.min(50, args.steps || 8));
          for (let i = 1; i <= steps; i++) {
            await sleep(400);
            if (state.cancelled) return null; // spec: no response after cancellation
            if (token !== undefined) send({ jsonrpc: "2.0", method: "notifications/progress", params: { progressToken: token, progress: i, total: steps, message: `Step ${i} of ${steps}` } });
          }
          return { content: [{ type: "text", text: `Finished ${steps} steps.` }] };
        }
        case "book_table": {
          const r = await askClient(send, "elicitation/create", {
            mode: "form",
            message: `Booking at ${args.restaurant || "Pho 2000"}: how many people, and when?`,
            requestedSchema: {
              type: "object",
              properties: {
                guests: { type: "integer", title: "Guests", minimum: 1, maximum: 12, default: 2 },
                time: { type: "string", title: "Time", enum: ["18:00", "19:00", "20:00"], default: "19:00" },
                outdoor: { type: "boolean", title: "Outdoor seating", default: false },
              },
              required: ["guests", "time"],
            },
          });
          if (r.error) return { isError: true, content: [{ type: "text", text: `Client error: ${r.error.message}` }] };
          if (r.result.action !== "accept") return { content: [{ type: "text", text: `Booking ${r.result.action}ed by the user.` }] };
          const c = r.result.content;
          return { content: [{ type: "text", text: `Booked ${c.guests} at ${c.time}${c.outdoor ? ", outdoors" : ""} (demo, nothing was reserved).` }], structuredContent: c };
        }
        case "summarize": {
          const r = await askClient(send, "sampling/createMessage", {
            messages: [{ role: "user", content: { type: "text", text: `Summarize in one sentence: ${args.text || ""}` } }],
            maxTokens: 100, systemPrompt: "You are a concise assistant.",
          });
          if (r.error) return { isError: true, content: [{ type: "text", text: `Sampling failed: ${r.error.message}` }] };
          return { content: [{ type: "text", text: `Model (${r.result.model}) says: ${r.result.content.text}` }] };
        }
        case "echo":
          return { content: [{ type: "text", text: args.loud ? String(args.message).toUpperCase() : String(args.message) }], structuredContent: { message: args.message } };
        default:
          throw Object.assign(new Error(`Unknown tool: ${name}`), { code: -32602 });
      }
    } finally {
      running.delete(msg.id);
    }
  }

  async function handle(msg) {
    switch (msg.method) {
      case "initialize":
        return {
          protocolVersion: ["2025-11-25", "2025-06-18", "2025-03-26"].includes(msg.params.protocolVersion) ? msg.params.protocolVersion : "2025-11-25",
          capabilities: { tools: { listChanged: false }, resources: {}, prompts: {}, logging: {} },
          serverInfo: { name: "in-browser-demo", title: "In-browser demo server", version: "1.0.0" },
          instructions: "A fake MCP server running inside this page. No network involved.",
        };
      case "ping": return {};
      case "tools/list": return { tools: TOOLS };
      case "resources/list": return { resources: RESOURCES };
      case "resources/read":
        if (msg.params.uri === "ui://demo/weather.html") {
          return { contents: [{ uri: msg.params.uri, mimeType: "text/html;profile=mcp-app", text: WEATHER_APP, _meta: { ui: { prefersBorder: false, csp: {} } } }] };
        }
        if (msg.params.uri === "demo://readme") return { contents: [{ uri: msg.params.uri, mimeType: "text/markdown", text: "# In-browser demo\nThis server is a `fetch` function. Try every tool, then point the playground at your own server." }] };
        throw Object.assign(new Error("Resource not found"), { code: -32002 });
      case "prompts/list": return { prompts: PROMPTS };
      case "prompts/get": return { messages: [{ role: "user", content: { type: "text", text: `I'm travelling to ${msg.params.arguments?.city || "somewhere"}. What should I pack?` } }] };
      case "logging/setLevel": return {};
      default: throw Object.assign(new Error(`Method not found: ${msg.method}`), { code: -32601 });
    }
  }

  return async function demoFetch(_url, init = {}) {
    await sleep(latency);
    const method = (init.method || "GET").toUpperCase();
    if (method === "GET") return new Response(null, { status: 405 });
    if (method === "DELETE") return new Response(null, { status: 204 });
    const msg = JSON.parse(init.body);
    if (msg.method === undefined) { // a response to one of our requests
      waitingForClient.get(msg.id)?.(msg);
      waitingForClient.delete(msg.id);
      return new Response(null, { status: 202 });
    }
    if (msg.id === undefined) { // notification
      if (msg.method === "notifications/cancelled") { const r = running.get(msg.params.requestId); if (r) r.cancelled = true; }
      return new Response(null, { status: 202, headers: { "mcp-session-id": sessionId } });
    }
    if (msg.method === "tools/call") {
      return sseResponse(async (send) => {
        try {
          const result = await callTool(msg, send);
          if (result) send({ jsonrpc: "2.0", id: msg.id, result });
        } catch (e) {
          send({ jsonrpc: "2.0", id: msg.id, error: { code: e.code || -32603, message: e.message } });
        }
      });
    }
    try { return json({ jsonrpc: "2.0", id: msg.id, result: await handle(msg) }); }
    catch (e) { return json({ jsonrpc: "2.0", id: msg.id, error: { code: e.code || -32603, message: e.message } }); }
  };
}
