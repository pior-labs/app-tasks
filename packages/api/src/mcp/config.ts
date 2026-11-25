import { createHash } from 'node:crypto';

// The MCP endpoint's configuration, read once at startup (src/index.ts and the
// e2e server). A mistake fails startup instead of quietly disabling a member
// or using the wrong day. Error messages never repeat a configured value from
// TASKS_MCP_TOKENS.

// A member token: who it acts as, and the SHA-256 of the token. The server
// never stores the token itself (D-2).
export type MemberToken = { email: string; hash: Buffer };

// The hex SHA-256 of a token, as it appears in TASKS_MCP_TOKENS.
export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

const EMAIL = /^[^\s@:,]+@[^\s@:,]+$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;

// TASKS_MCP_TOKENS is a comma-separated list of
// `<member email>:<sha256 hex of token>`. Unset or empty means no tokens: the
// endpoint then refuses every request. An email may appear more than once, so
// an old and a new token can both work while a client switches over; one
// token hash may not stand for two emails.
export function parseMcpTokens(raw: string | undefined): MemberToken[] {
  const value = raw?.trim() ?? '';
  if (!value) return [];
  const tokens: MemberToken[] = [];
  const seen = new Set<string>();
  value.split(',').forEach((part, index) => {
    const entry = part.trim();
    const separator = entry.lastIndexOf(':');
    const email = entry.slice(0, separator).trim().toLowerCase();
    const hash = entry.slice(separator + 1).trim().toLowerCase();
    if (separator < 0 || !EMAIL.test(email) || !SHA256_HEX.test(hash)) {
      throw new Error(
        `TASKS_MCP_TOKENS entry ${index + 1} must be <member email>:<SHA-256 hex of the token>, separated by commas`,
      );
    }
    if (seen.has(hash)) throw new Error(`TASKS_MCP_TOKENS entry ${index + 1} repeats the token of an earlier entry`);
    seen.add(hash);
    tokens.push({ email, hash: Buffer.from(hash, 'hex') });
  });
  return tokens;
}

// The household's timezone decides what "today" is for the MCP tools (D-3).
export const DEFAULT_TIMEZONE = 'America/Toronto';
export function parseTimeZone(raw: string | undefined): string {
  const value = raw?.trim() || DEFAULT_TIMEZONE;
  try {
    // Throws a RangeError for a name the runtime's time zone data does not know.
    new Intl.DateTimeFormat('en-US', { timeZone: value });
  } catch {
    throw new Error(`TASKS_TIMEZONE must be an IANA time zone name such as ${DEFAULT_TIMEZONE}; "${value}" is not one`);
  }
  return value;
}

export type McpConfig = { tokens: MemberToken[]; timeZone: string };
export function mcpEnvironment(environment: NodeJS.ProcessEnv = process.env): McpConfig {
  return {
    tokens: parseMcpTokens(environment.TASKS_MCP_TOKENS),
    timeZone: parseTimeZone(environment.TASKS_TIMEZONE),
  };
}
