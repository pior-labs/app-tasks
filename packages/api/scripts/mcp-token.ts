import { randomBytes } from 'node:crypto';
import { hashToken, parseMcpTokens } from '../src/mcp/config.js';

// Creates an MCP member token: pnpm --filter @tasks/api mcp:token <member email>
//
// Prints the token once, for the member's MCP client, and the TASKS_MCP_TOKENS
// entry, which holds only its SHA-256. Nothing is written anywhere; the token
// cannot be shown again, so a lost token is replaced by a new one.
const [email, ...rest] = process.argv.slice(2);
if (!email || rest.length > 0) {
  console.error('Usage: pnpm --filter @tasks/api mcp:token <member email>');
  process.exit(2);
}
// 32 random bytes, base64url: 43 characters with no padding (D-2).
const token = randomBytes(32).toString('base64url');
const entry = `${email.trim().toLowerCase()}:${hashToken(token)}`;
try {
  // The same check the API makes at startup.
  parseMcpTokens(entry);
} catch {
  console.error('The member email must look like name@example.com, without spaces, commas or colons.');
  process.exit(2);
}
console.log(`MCP token for ${email.trim().toLowerCase()}. It is shown only now; give it to the member's MCP client:`);
console.log('');
console.log(`  ${token}`);
console.log('');
console.log('Add this entry to TASKS_MCP_TOKENS (comma-separated with any others) and redeploy:');
console.log('');
console.log(`  ${entry}`);
