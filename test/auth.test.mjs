import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { McpClient, OAuthProvider, oauth, pkce, parseWwwAuthenticate, canonicalResource, discoverAuthorizationServer } from "../dist/index.js";

const memory = () => { const m = new Map(); return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, v), removeItem: (k) => m.delete(k), m }; };

test("pkce() produces a 43-char verifier and its S256 challenge", async () => {
  const { verifier, challenge } = await pkce();
  assert.match(verifier, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(challenge, createHash("sha256").update(verifier).digest("base64url"));
});

test("parseWwwAuthenticate reads quoted and bare parameters", () => {
  assert.deepEqual(
    parseWwwAuthenticate('Bearer error="insufficient_scope", scope="files:read files:write", resource_metadata="https://a/.well-known/oauth-protected-resource", realm=mcp'),
    { error: "insufficient_scope", scope: "files:read files:write", resource_metadata: "https://a/.well-known/oauth-protected-resource", realm: "mcp" },
  );
});

test("canonicalResource lowercases the host and drops fragment and trailing slash", () => {
  assert.equal(canonicalResource("https://MCP.Example.com/mcp/#x"), "https://mcp.example.com/mcp");
  assert.equal(canonicalResource("https://mcp.example.com/"), "https://mcp.example.com");
});

test("authorization server discovery tries the spec's endpoints in order (issuer with path)", async () => {
  const tried = [];
  const f = async (url) => {
    tried.push(url);
    if (url === "https://auth.example.com/tenant1/.well-known/openid-configuration") return Response.json({ authorization_endpoint: "a", token_endpoint: "t" });
    return new Response("", { status: 404 });
  };
  const meta = await discoverAuthorizationServer("https://auth.example.com/tenant1", f);
  assert.equal(meta.token_endpoint, "t");
  assert.deepEqual(tried, [
    "https://auth.example.com/.well-known/oauth-authorization-server/tenant1",
    "https://auth.example.com/.well-known/openid-configuration/tenant1",
    "https://auth.example.com/tenant1/.well-known/openid-configuration",
  ]);
});

// A fake MCP server protected by a fake OAuth 2.1 authorization server.
function world({ pkceMethods = ["S256"], cimd = false, dcr = true, expireFirstToken = false } = {}) {
  const log = { registered: [], tokenRequests: [], authorizeUrls: [] };
  const valid = new Set();
  let issued = 0;
  const fetchImpl = async (url, init = {}) => {
    const u = new URL(url);
    if (u.pathname === "/mcp") {
      const auth = init.headers?.authorization;
      if (!auth || !valid.has(auth.slice(7))) {
        return new Response("", { status: 401, headers: { "www-authenticate": 'Bearer resource_metadata="https://mcp.test/.well-known/oauth-protected-resource/mcp", scope="tools:read"' } });
      }
      const msg = JSON.parse(init.body);
      if (msg.id === undefined) return new Response(null, { status: 202 });
      const result = msg.method === "initialize" ? { protocolVersion: "2025-11-25", capabilities: {}, serverInfo: { name: "secure", version: "1" } } : { tools: [] };
      return Response.json({ jsonrpc: "2.0", id: msg.id, result });
    }
    if (u.pathname === "/.well-known/oauth-protected-resource/mcp") return Response.json({ resource: "https://mcp.test/mcp", authorization_servers: ["https://auth.test"], scopes_supported: ["tools:read", "tools:write"] });
    if (u.pathname === "/.well-known/oauth-authorization-server") return Response.json({
      issuer: "https://auth.test", authorization_endpoint: "https://auth.test/authorize", token_endpoint: "https://auth.test/token",
      ...(dcr ? { registration_endpoint: "https://auth.test/register" } : {}),
      ...(pkceMethods ? { code_challenge_methods_supported: pkceMethods } : {}),
      ...(cimd ? { client_id_metadata_document_supported: true } : {}),
    });
    if (u.pathname === "/register") { const b = JSON.parse(init.body); log.registered.push(b); return Response.json({ client_id: "dyn-123", ...b }); }
    if (u.pathname === "/token") {
      const p = Object.fromEntries(new URLSearchParams(init.body.toString()));
      log.tokenRequests.push(p);
      if (p.grant_type === "authorization_code") {
        const pending = log.pendingAuth;
        if (createHash("sha256").update(p.code_verifier).digest("base64url") !== pending.code_challenge) return new Response("", { status: 400 });
      }
      const access = `at-${++issued}`;
      if (!(expireFirstToken && issued === 1)) valid.add(access);
      return Response.json({ access_token: access, token_type: "Bearer", expires_in: 3600, refresh_token: `rt-${issued}` });
    }
    return new Response("", { status: 404 });
  };
  // Simulates the user approving on the authorization page.
  const authorize = async (url) => {
    log.authorizeUrls.push(url);
    const q = new URL(url).searchParams;
    log.pendingAuth = Object.fromEntries(q);
    return `https://app.test/callback?code=c0de&state=${q.get("state")}`;
  };
  return { fetchImpl, authorize, log, valid };
}

test("full OAuth 2.1 flow: 401 → PRM → AS metadata → DCR → PKCE authorize → token → retry", async () => {
  const w = world();
  const storage = memory();
  const auth = oauth({ redirectUri: "https://app.test/callback", fetch: w.fetchImpl, authorize: w.authorize, storage });
  const c = new McpClient("https://mcp.test/mcp", { fetchImpl: w.fetchImpl, auth });
  const init = await c.connect();
  assert.equal(init.serverInfo.name, "secure");
  const q = new URL(w.log.authorizeUrls[0]).searchParams;
  assert.equal(q.get("client_id"), "dyn-123");
  assert.equal(q.get("code_challenge_method"), "S256");
  assert.equal(q.get("resource"), "https://mcp.test/mcp");
  assert.equal(q.get("scope"), "tools:read", "the challenge's scope wins over scopes_supported");
  assert.equal(w.log.registered[0].token_endpoint_auth_method, "none");
  const tokenReq = w.log.tokenRequests[0];
  assert.equal(tokenReq.grant_type, "authorization_code");
  assert.equal(tokenReq.resource, "https://mcp.test/mcp");
  assert.ok(storage.getItem("mcp-oauth:https://mcp.test/mcp"), "tokens are persisted");
});

test("Client ID Metadata Document is used when the AS supports it (no registration)", async () => {
  const w = world({ cimd: true });
  const auth = new OAuthProvider({ redirectUri: "https://app.test/callback", clientMetadataUrl: "https://app.test/oauth/client.json", fetch: w.fetchImpl, authorize: w.authorize, storage: memory() });
  await new McpClient("https://mcp.test/mcp", { fetchImpl: w.fetchImpl, auth }).connect();
  assert.equal(new URL(w.log.authorizeUrls[0]).searchParams.get("client_id"), "https://app.test/oauth/client.json");
  assert.equal(w.log.registered.length, 0);
});

test("refuses to continue when the AS does not advertise PKCE S256", async () => {
  const w = world({ pkceMethods: null });
  const auth = oauth({ redirectUri: "https://app.test/callback", fetch: w.fetchImpl, authorize: w.authorize, storage: memory() });
  await assert.rejects(() => new McpClient("https://mcp.test/mcp", { fetchImpl: w.fetchImpl, auth }).connect(), /PKCE S256/);
  assert.equal(w.log.authorizeUrls.length, 0);
});

test("state mismatch in the callback is rejected", async () => {
  const w = world();
  const auth = oauth({ redirectUri: "https://app.test/callback", fetch: w.fetchImpl, authorize: async () => "https://app.test/callback?code=x&state=evil", storage: memory() });
  await assert.rejects(() => new McpClient("https://mcp.test/mcp", { fetchImpl: w.fetchImpl, auth }).connect(), /state mismatch/);
});

test("an expired access token is refreshed with the refresh token (no second authorization)", async () => {
  const w = world();
  const auth = oauth({ redirectUri: "https://app.test/callback", fetch: w.fetchImpl, authorize: w.authorize, storage: memory() });
  const c = new McpClient("https://mcp.test/mcp", { fetchImpl: w.fetchImpl, auth });
  await c.connect();
  w.valid.clear(); // the access token expires server-side
  await c.listTools();
  assert.equal(w.log.authorizeUrls.length, 1);
  assert.deepEqual(w.log.tokenRequests.map((r) => r.grant_type), ["authorization_code", "refresh_token"]);
  assert.equal(w.log.tokenRequests[1].refresh_token, "rt-1");
});

test("stored tokens are reused across clients (no new authorization)", async () => {
  const w = world();
  const storage = memory();
  const mk = () => oauth({ redirectUri: "https://app.test/callback", fetch: w.fetchImpl, authorize: w.authorize, storage });
  await new McpClient("https://mcp.test/mcp", { fetchImpl: w.fetchImpl, auth: mk() }).connect();
  await new McpClient("https://mcp.test/mcp", { fetchImpl: w.fetchImpl, auth: mk() }).connect();
  assert.equal(w.log.authorizeUrls.length, 1);
});
