import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { test } from 'node:test';
import {
  DEFAULT_TIMEZONE,
  hashToken,
  mcpEnvironment,
  parseMcpTokens,
  parseTimeZone,
} from '../src/mcp/config.js';
import { householdDay } from '../src/mcp/today.js';

// MCP configuration: member tokens, the household timezone, the token script
// and startup. No database. The criteria named below are those of the MCP
// server task.

const run = promisify(execFile);
const apiRoot = fileURLToPath(new URL('..', import.meta.url));
const hash = (token: string) => createHash('sha256').update(token).digest('hex');

test('TASKS_MCP_TOKENS parses email:hash entries, lowercasing both (AC-10)', () => {
  assert.deepEqual(parseMcpTokens(undefined), []);
  assert.deepEqual(parseMcpTokens(''), []);
  assert.deepEqual(parseMcpTokens('   '), []);
  const a = hash('a');
  const b = hash('b');
  const parsed = parseMcpTokens(` One@Example.test:${a.toUpperCase()} ,one@example.test:${b}`);
  assert.deepEqual(
    parsed.map((entry) => [entry.email, entry.hash.toString('hex')]),
    [
      ['one@example.test', a],
      ['one@example.test', b],
    ],
  );
  assert.equal(hashToken('a'), a);
});

test('a malformed TASKS_MCP_TOKENS fails without repeating its value (AC-10)', () => {
  const valid = `one@example.test:${hash('a')}`;
  const cases = [
    'one@example.test',
    `one@example.test:${hash('a').slice(1)}`,
    `one@example.test:${hash('a')}0`,
    `one@example.test:${hash('a').replace(/./, 'g')}`,
    `:${hash('a')}`,
    `not-an-email:${hash('a')}`,
    `one @example.test:${hash('a')}`,
    `${valid},`,
    `${valid},,${valid.replace('one', 'two')}`,
    `one@example.test:plain-token-instead-of-a-hash`,
    // One token for two members.
    `${valid},two@example.test:${hash('a')}`,
  ];
  for (const value of cases) {
    assert.throws(
      () => parseMcpTokens(value),
      (error: Error) => {
        assert.match(error.message, /^TASKS_MCP_TOKENS entry \d+ /);
        assert.ok(!error.message.includes('example.test'), error.message);
        assert.ok(!error.message.includes(hash('a').slice(0, 16)), error.message);
        return true;
      },
      value,
    );
  }
});

test('TASKS_TIMEZONE defaults to America/Toronto and an invalid zone fails (AC-8)', () => {
  assert.equal(DEFAULT_TIMEZONE, 'America/Toronto');
  assert.equal(parseTimeZone(undefined), 'America/Toronto');
  assert.equal(parseTimeZone(' '), 'America/Toronto');
  assert.equal(parseTimeZone('Europe/Warsaw'), 'Europe/Warsaw');
  assert.equal(parseTimeZone('UTC'), 'UTC');
  assert.equal(parseTimeZone(' America/Toronto '), 'America/Toronto');
  for (const value of ['Mars/Olympus_Mons', 'America/Torronto', 'Toronto', '+25:00']) {
    assert.throws(() => parseTimeZone(value), /TASKS_TIMEZONE must be an IANA time zone name/, value);
  }
  assert.deepEqual(mcpEnvironment({}), { tokens: [], timeZone: 'America/Toronto' });
});

test('the household day follows the timezone, not UTC or the process timezone (AC-8)', () => {
  const lateEvening = new Date('2026-03-10T03:00:00Z');
  assert.deepEqual(householdDay(lateEvening, 'America/Toronto'), {
    today: '2026-03-09',
    weekday: 'Monday',
    timezone: 'America/Toronto',
  });
  assert.equal(householdDay(lateEvening, 'UTC').today, '2026-03-10');
  assert.equal(householdDay(new Date('2026-03-09T23:30:00Z'), 'Pacific/Auckland').today, '2026-03-10');
  // Midnight in Toronto is 04:00 UTC in daylight saving time (EDT) and 05:00
  // UTC in standard time (EST).
  assert.equal(householdDay(new Date('2026-11-01T03:59:00Z'), 'America/Toronto').today, '2026-10-31');
  assert.equal(householdDay(new Date('2026-11-01T04:00:00Z'), 'America/Toronto').today, '2026-11-01');
  assert.equal(householdDay(new Date('2026-12-01T04:59:00Z'), 'America/Toronto').today, '2026-11-30');
  assert.equal(householdDay(new Date('2026-12-01T05:00:00Z'), 'America/Toronto').today, '2026-12-01');
});

test('the token script prints a token once and a config entry holding only its hash (AC-10)', async () => {
  const { stdout } = await run('node', ['--import', 'tsx', 'scripts/mcp-token.ts', 'One@Example.test'], { cwd: apiRoot });
  const lines = stdout.split('\n').map((line) => line.trim()).filter(Boolean);
  const token = lines.find((line) => /^[A-Za-z0-9_-]{43}$/.test(line));
  assert.ok(token, 'a 43-character base64url token (32 bytes)');
  assert.equal(stdout.split(token).length - 1, 1, 'the token is printed once');
  const entry = lines.find((line) => line.startsWith('one@example.test:'));
  assert.equal(entry, `one@example.test:${hash(token)}`);
  assert.deepEqual(
    parseMcpTokens(entry).map((parsed) => [parsed.email, parsed.hash.toString('hex')]),
    [['one@example.test', hash(token)]],
  );
  assert.ok(!entry.includes(token));
  // A new token every run.
  const second = await run('node', ['--import', 'tsx', 'scripts/mcp-token.ts', 'one@example.test'], { cwd: apiRoot });
  assert.ok(!second.stdout.includes(token));
  for (const args of [[], ['not an email'], ['one@example.test', 'extra']]) {
    await assert.rejects(run('node', ['--import', 'tsx', 'scripts/mcp-token.ts', ...args], { cwd: apiRoot }), (error: { code: number }) => {
      assert.equal(error.code, 2);
      return true;
    });
  }
});

// Starts the real entry point with fixture settings (no database is
// contacted before the configuration is read) and returns how it ended.
async function startApi(extra: Record<string, string>) {
  const env = {
    PATH: process.env.PATH ?? '',
    NODE_ENV: 'development',
    DATABASE_URL: 'postgresql://fixture:fixture-only@127.0.0.1:1/unused',
    BETTER_AUTH_SECRET: 'fixture-session-secret-at-least-32-characters',
    BETTER_AUTH_URL: 'http://localhost:5173',
    CENTRAL_AUTH_ISSUER: 'http://localhost:9/api/auth',
    CENTRAL_AUTH_CLIENT_ID: 'tasks',
    CENTRAL_AUTH_CLIENT_SECRET: 'fixture-client-secret',
    // A port nothing should be using, in case startup got that far.
    API_PORT: '1',
    ...extra,
  };
  try {
    await run('node', ['--import', 'tsx', 'src/index.ts'], { cwd: apiRoot, env, timeout: 20_000 });
    return { code: 0, stderr: '' };
  } catch (error) {
    const { code, stderr } = error as { code: number; stderr: string };
    return { code, stderr };
  }
}

test('an invalid TASKS_TIMEZONE or TASKS_MCP_TOKENS stops API startup with a clear error (AC-8, AC-10)', async () => {
  const zone = await startApi({ TASKS_TIMEZONE: 'Mars/Olympus_Mons' });
  assert.notEqual(zone.code, 0);
  assert.match(zone.stderr, /TASKS_TIMEZONE must be an IANA time zone name such as America\/Toronto/);
  const secretHash = hash('fixture-token');
  const tokens = await startApi({ TASKS_MCP_TOKENS: `one@example.test:${secretHash.slice(2)}` });
  assert.notEqual(tokens.code, 0);
  assert.match(tokens.stderr, /TASKS_MCP_TOKENS entry 1 must be <member email>:<SHA-256 hex of the token>/);
  assert.ok(!tokens.stderr.includes(secretHash.slice(2, 30)));
  assert.ok(!tokens.stderr.includes('one@example.test'));
});
