export interface Env {
  /** Agent state: cursors, pending inflows, decisions, vendor registries, notes. */
  AGENT_KV: KVNamespace;
  /** Hex private key of the agent EOA (wrangler secret). */
  AGENT_PRIVATE_KEY: `0x${string}`;
  /** Anthropic API key (wrangler secret). Without it the agent runs rules-only and holds anything that needs judgement. */
  ANTHROPIC_API_KEY?: string;
  /** Comma-separated chest addresses this agent operates. */
  CHESTS: string;
  /** Where the web app lives; pay links in reminders point here. */
  APP_URL: string;
  /** Comma-separated origins allowed to call the HTTP API. */
  ALLOWED_ORIGINS: string;
}
