/**
 * Binance Agent OS OAuth: Client ID Metadata Document (CIMD / SEP-991).
 *
 * The Agent OS auth server does NOT support RFC 7591 Dynamic Client Registration
 * — its `/.well-known/oauth-authorization-server` has no `registration_endpoint`,
 * so the stock `agents` SDK flow fails with
 *   "Incompatible auth server: does not support dynamic client registration".
 *
 * It DOES advertise `client_id_metadata_document_supported: true`. In that mode
 * the `client_id` is simply an HTTPS URL that serves a JSON document describing
 * this client; the auth server fetches and trusts it. No registration, no secret.
 *
 * This provider makes two changes to the base DO provider:
 *  1. exposes `clientMetadataUrl` so the MCP SDK takes the CIMD branch and never
 *     attempts DCR;
 *  2. embeds this DO's instance name (the phone hash) inside the OAuth `state`
 *     nonce, so one fixed redirect URI (`/oauth/callback` — the only entry in the
 *     CIMD document's `redirect_uris`) can be routed back to the correct
 *     per-phone Durable Object.
 */

import { DurableObjectOAuthClientProvider } from "agents/mcp/do-oauth-client-provider";

/** Path (non-root, HTTPS) where the Worker serves the client-metadata document. */
export const CLIENT_METADATA_PATH = "/.well-known/mcp-client";

/** Fixed redirect URI for every user; the callback router recovers the DO from `state`. */
export const OAUTH_CALLBACK_PATH = "/oauth/callback";

export class CimdOAuthClientProvider extends DurableObjectOAuthClientProvider {
  /** The hosted client-metadata document URL, used verbatim as the `client_id`. */
  get clientMetadataUrl(): string {
    return `${new URL(this.baseRedirectUrl).origin}${CLIENT_METADATA_PATH}`;
  }

  /**
   * `state` = `<phoneHash>~<uuid>.<serverId>` — exactly one dot so the SDK's
   * `{nonce}.{serverId}` parser still works, and the hash is recoverable from the
   * callback query string before the DO is even loaded.
   */
  override async state(): Promise<string> {
    const serverId = this.serverId;
    const nonce = `${this.clientName}~${crypto.randomUUID()}`;
    await this.storage.put(this.stateKey(nonce), { nonce, serverId, createdAt: Date.now() });
    return `${nonce}.${serverId}`;
  }
}

/** Recover the DO instance name (phone hash) from an OAuth `state` value. */
export function phoneHashFromOAuthState(state: string | null): string | null {
  if (!state) return null;
  const nonce = state.split(".")[0] ?? "";
  const hash = nonce.split("~")[0] ?? "";
  return /^[0-9a-f]{64}$/.test(hash) ? hash : null;
}

/**
 * The client-metadata document body. `client_id` MUST equal the URL it is served
 * from; `redirect_uris` MUST list every callback the auth server will be asked to
 * honour — here just the one fixed path.
 */
export function clientMetadataDocument(origin: string): Record<string, unknown> {
  return {
    client_id: `${origin}${CLIENT_METADATA_PATH}`,
    client_name: "BinaText",
    client_uri: origin,
    redirect_uris: [`${origin}${OAUTH_CALLBACK_PATH}`],
    grant_types: ["authorization_code"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
    application_type: "web",
  };
}
