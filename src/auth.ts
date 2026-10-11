// OAuth 2.1 authorization for MCP clients in the browser (spec 2025-11-25 "Authorization"):
// RFC 9728 protected-resource discovery, RFC 8414 / OIDC metadata, PKCE S256, RFC 8707 resource indicators,
// Client ID Metadata Documents, pre-registration or RFC 7591 dynamic registration, refresh and step-up.
import { McpError, type AuthProvider } from "./client.js";

export interface OAuthTokens { access_token: string; token_type?: string; refresh_token?: string; expires_at?: number; scope?: string }

export interface KeyValueStorage { getItem(k: string): string | null; setItem(k: string, v: string): void; removeItem(k: string): void }

export interface OAuthOptions {
  /** Where the authorization server sends the user back. Must be https or localhost. */
  redirectUri: string;
  /** Pre-registered client id (highest priority). */
  clientId?: string;
  clientSecret?: string;
  /** HTTPS URL of your Client ID Metadata Document, used when the AS sets `client_id_metadata_document_supported`. */
  clientMetadataUrl?: string;
  /** Name shown on the consent screen when registering dynamically. */
  clientName?: string;
  /** Scopes to request when the server's challenge names none. */
  scope?: string;
  /** Token storage. Default: `sessionStorage` in browsers, memory elsewhere. */
  storage?: KeyValueStorage;
  /**
   * Send the user to `url` and resolve with the full callback URL (containing `code` and `state`).
   * Default: a popup that the callback page answers with `postMessage` (see `completeOAuthPopup`).
   */
  authorize?: (url: string) => Promise<string>;
  fetch?: typeof fetch;
}

const b64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const random = (n = 32) => b64url(crypto.getRandomValues(new Uint8Array(n)));

/** Create a PKCE verifier and its S256 challenge. */
export async function pkce(): Promise<{ verifier: string; challenge: string }> {
  const verifier = random(32);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return { verifier, challenge: b64url(new Uint8Array(digest)) };
}

/** Parse the parameters of a `WWW-Authenticate: Bearer …` header. */
export function parseWwwAuthenticate(header: string | null): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const m of header.matchAll(/([a-zA-Z_][\w-]*)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^\s,]+))/g)) out[m[1]] = m[2] !== undefined ? m[2].replace(/\\(.)/g, "$1") : m[3];
  return out;
}

/** RFC 8707 canonical resource URI: lowercase scheme and host, no fragment, no trailing slash. */
export function canonicalResource(url: string): string {
  const u = new URL(url, (globalThis as any).location?.href);
  u.hash = "";
  return (u.protocol + "//" + u.host.toLowerCase() + u.pathname + u.search).replace(/\/$/, "");
}

async function getJson(f: typeof fetch, url: string): Promise<any | null> {
  try {
    const r = await f(url, { headers: { accept: "application/json", "mcp-protocol-version": "2025-11-25" } });
    return r.ok ? await r.json() : null;
  } catch { return null; }
}

/** RFC 9728: use `resource_metadata` from the challenge, else the path-aware then root well-known URIs. */
export async function discoverProtectedResource(serverUrl: string, challenge: Record<string, string> = {}, f: typeof fetch = fetch) {
  const u = new URL(serverUrl, (globalThis as any).location?.href);
  const candidates = [
    challenge.resource_metadata,
    u.pathname !== "/" ? `${u.origin}/.well-known/oauth-protected-resource${u.pathname.replace(/\/$/, "")}` : undefined,
    `${u.origin}/.well-known/oauth-protected-resource`,
  ].filter(Boolean) as string[];
  for (const c of candidates) {
    const meta = await getJson(f, c);
    if (meta?.authorization_servers?.length) return meta as { resource?: string; authorization_servers: string[]; scopes_supported?: string[] };
  }
  throw new McpError({ code: 401, message: "No OAuth protected resource metadata found for " + serverUrl });
}

/** RFC 8414 / OpenID Connect discovery in the order the MCP spec mandates. */
export async function discoverAuthorizationServer(issuer: string, f: typeof fetch = fetch) {
  const u = new URL(issuer);
  const path = u.pathname.replace(/\/$/, "");
  const candidates = path
    ? [`${u.origin}/.well-known/oauth-authorization-server${path}`, `${u.origin}/.well-known/openid-configuration${path}`, `${u.origin}${path}/.well-known/openid-configuration`]
    : [`${u.origin}/.well-known/oauth-authorization-server`, `${u.origin}/.well-known/openid-configuration`];
  for (const c of candidates) {
    const meta = await getJson(f, c);
    if (meta?.authorization_endpoint && meta?.token_endpoint) return meta as Record<string, any>;
  }
  throw new McpError({ code: 401, message: "No authorization server metadata found for " + issuer });
}

/** Default `authorize`: open a popup and wait for the callback page to post its URL back. */
export function popupAuthorize(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const w = window.open(url, "mcp-oauth", "popup,width=520,height=720");
    if (!w) return reject(new McpError({ code: 401, message: "Popup blocked: call connect() from a click handler" }));
    const onMsg = (ev: MessageEvent) => {
      if (ev.origin !== location.origin || ev.data?.type !== "mcp-oauth-callback") return;
      cleanup(); resolve(ev.data.url);
    };
    const timer = setInterval(() => { if (w.closed) { cleanup(); reject(new McpError({ code: 401, message: "Authorization window closed" })); } }, 500);
    const cleanup = () => { clearInterval(timer); window.removeEventListener("message", onMsg); try { w.close(); } catch { /* ignore */ } };
    window.addEventListener("message", onMsg);
  });
}

/** Call this on your redirect page to hand the result back to the opener (popup flow). */
export function completeOAuthPopup(): void {
  window.opener?.postMessage({ type: "mcp-oauth-callback", url: location.href }, location.origin);
}

const memoryStorage = (): KeyValueStorage => {
  const m = new Map<string, string>();
  return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => void m.set(k, v), removeItem: (k) => void m.delete(k) };
};

/**
 * An AuthProvider that runs the full MCP OAuth 2.1 flow on the first 401 and keeps tokens fresh.
 *
 *   const client = new McpClient(url, { auth: oauth({ redirectUri: location.origin + "/callback.html" }) });
 */
export class OAuthProvider implements AuthProvider {
  private o: OAuthOptions;
  private f: typeof fetch;
  private store: KeyValueStorage;
  private key = "";
  private attempts = 0;
  tokens: OAuthTokens | null = null;

  constructor(options: OAuthOptions) {
    this.o = options;
    const f = options.fetch;
    this.f = f ? f : (...a: Parameters<typeof fetch>) => globalThis.fetch(...a);
    this.store = options.storage || (globalThis as any).sessionStorage || memoryStorage();
  }

  async headers(): Promise<Record<string, string>> {
    return this.tokens?.access_token ? { authorization: `Bearer ${this.tokens.access_token}` } : {};
  }

  /** Forget stored tokens and client registration for this server. */
  logout(): void { if (this.key) { this.store.removeItem(this.key); this.store.removeItem(this.key + ":client"); } this.tokens = null; }

  async onUnauthorized({ status, wwwAuthenticate, url }: { status: number; wwwAuthenticate: string | null; url: string }): Promise<boolean> {
    const resource = canonicalResource(url);
    if (this.key !== "mcp-oauth:" + resource) {
      this.key = "mcp-oauth:" + resource;
      const saved = this.store.getItem(this.key);
      if (saved && !this.tokens) { this.tokens = JSON.parse(saved); return true; }
    }
    if (++this.attempts > 3) { this.attempts = 0; return false; } // step-up retry limit
    const challenge = parseWwwAuthenticate(wwwAuthenticate);
    const prm = await discoverProtectedResource(url, challenge, this.f);
    const as = await discoverAuthorizationServer(prm.authorization_servers[0], this.f);
    if (!(as.code_challenge_methods_supported || []).includes("S256")) {
      throw new McpError({ code: 401, message: "Authorization server does not advertise PKCE S256; refusing to continue" });
    }
    const client = await this.client(as);
    // On 401 try a refresh first; a 403 insufficient_scope needs a new authorization (step-up).
    if (status === 401 && this.tokens?.refresh_token) {
      if (await this.token(as, client, { grant_type: "refresh_token", refresh_token: this.tokens.refresh_token }, resource)) { this.attempts = 0; return true; }
    }
    const scope = challenge.scope || prm.scopes_supported?.join(" ") || this.o.scope;
    const { verifier, challenge: codeChallenge } = await pkce();
    const state = random(16);
    const q = new URLSearchParams({
      response_type: "code", client_id: client.client_id, redirect_uri: this.o.redirectUri,
      code_challenge: codeChallenge, code_challenge_method: "S256", state, resource,
      ...(scope ? { scope } : {}),
    });
    const authorizeUrl = as.authorization_endpoint + (as.authorization_endpoint.includes("?") ? "&" : "?") + q;
    const callback = new URL(await (this.o.authorize || popupAuthorize)(authorizeUrl));
    if (callback.searchParams.get("state") !== state) throw new McpError({ code: 401, message: "OAuth state mismatch" });
    const err = callback.searchParams.get("error");
    if (err) throw new McpError({ code: 401, message: `OAuth error: ${err} ${callback.searchParams.get("error_description") || ""}`.trim() });
    const code = callback.searchParams.get("code");
    if (!code) throw new McpError({ code: 401, message: "OAuth callback has no code" });
    const ok = await this.token(as, client, { grant_type: "authorization_code", code, redirect_uri: this.o.redirectUri, code_verifier: verifier }, resource);
    if (ok) this.attempts = 0;
    return ok;
  }

  private async client(as: Record<string, any>): Promise<{ client_id: string; client_secret?: string }> {
    if (this.o.clientId) return { client_id: this.o.clientId, client_secret: this.o.clientSecret };
    if (this.o.clientMetadataUrl && as.client_id_metadata_document_supported) return { client_id: this.o.clientMetadataUrl };
    const saved = this.store.getItem(this.key + ":client");
    if (saved) return JSON.parse(saved);
    if (!as.registration_endpoint) throw new McpError({ code: 401, message: "No client id: the server supports neither Client ID Metadata Documents nor dynamic registration. Pass clientId." });
    const r = await this.f(as.registration_endpoint, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_name: this.o.clientName || "mcp-lite-browser", redirect_uris: [this.o.redirectUri],
        grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none",
      }),
    });
    if (!r.ok) throw new McpError({ code: r.status, message: "Dynamic client registration failed: HTTP " + r.status });
    const info = await r.json();
    this.store.setItem(this.key + ":client", JSON.stringify(info));
    return info;
  }

  private async token(as: Record<string, any>, client: { client_id: string; client_secret?: string }, params: Record<string, string>, resource: string): Promise<boolean> {
    const body = new URLSearchParams({ ...params, client_id: client.client_id, resource, ...(client.client_secret ? { client_secret: client.client_secret } : {}) });
    const r = await this.f(as.token_endpoint, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" }, body });
    if (!r.ok) { if (params.grant_type === "refresh_token") return false; throw new McpError({ code: r.status, message: "Token request failed: HTTP " + r.status }); }
    const t = await r.json();
    this.tokens = {
      ...t,
      refresh_token: t.refresh_token || (params.grant_type === "refresh_token" ? params.refresh_token : undefined),
      expires_at: t.expires_in ? Date.now() + t.expires_in * 1000 : undefined,
    };
    this.store.setItem(this.key, JSON.stringify(this.tokens));
    return true;
  }
}

/** Shorthand for `new OAuthProvider(options)`. */
export const oauth = (options: OAuthOptions) => new OAuthProvider(options);
