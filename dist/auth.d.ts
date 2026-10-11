import { type AuthProvider } from "./client.js";
export interface OAuthTokens {
    access_token: string;
    token_type?: string;
    refresh_token?: string;
    expires_at?: number;
    scope?: string;
}
export interface KeyValueStorage {
    getItem(k: string): string | null;
    setItem(k: string, v: string): void;
    removeItem(k: string): void;
}
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
/** Create a PKCE verifier and its S256 challenge. */
export declare function pkce(): Promise<{
    verifier: string;
    challenge: string;
}>;
/** Parse the parameters of a `WWW-Authenticate: Bearer …` header. */
export declare function parseWwwAuthenticate(header: string | null): Record<string, string>;
/** RFC 8707 canonical resource URI: lowercase scheme and host, no fragment, no trailing slash. */
export declare function canonicalResource(url: string): string;
/** RFC 9728: use `resource_metadata` from the challenge, else the path-aware then root well-known URIs. */
export declare function discoverProtectedResource(serverUrl: string, challenge?: Record<string, string>, f?: typeof fetch): Promise<{
    resource?: string;
    authorization_servers: string[];
    scopes_supported?: string[];
}>;
/** RFC 8414 / OpenID Connect discovery in the order the MCP spec mandates. */
export declare function discoverAuthorizationServer(issuer: string, f?: typeof fetch): Promise<Record<string, any>>;
/** Default `authorize`: open a popup and wait for the callback page to post its URL back. */
export declare function popupAuthorize(url: string): Promise<string>;
/** Call this on your redirect page to hand the result back to the opener (popup flow). */
export declare function completeOAuthPopup(): void;
/**
 * An AuthProvider that runs the full MCP OAuth 2.1 flow on the first 401 and keeps tokens fresh.
 *
 *   const client = new McpClient(url, { auth: oauth({ redirectUri: location.origin + "/callback.html" }) });
 */
export declare class OAuthProvider implements AuthProvider {
    private o;
    private f;
    private store;
    private key;
    private attempts;
    tokens: OAuthTokens | null;
    constructor(options: OAuthOptions);
    headers(): Promise<Record<string, string>>;
    /** Forget stored tokens and client registration for this server. */
    logout(): void;
    onUnauthorized({ status, wwwAuthenticate, url }: {
        status: number;
        wwwAuthenticate: string | null;
        url: string;
    }): Promise<boolean>;
    private client;
    private token;
}
/** Shorthand for `new OAuthProvider(options)`. */
export declare const oauth: (options: OAuthOptions) => OAuthProvider;
