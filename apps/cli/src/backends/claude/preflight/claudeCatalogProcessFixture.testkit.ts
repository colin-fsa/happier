import { readFile } from 'node:fs/promises';

// Exercise the real Agent SDK control transport against its external CLI process boundary.
export const claudeCatalogProcessFixture = String.raw`
const fs = require('node:fs');
const readline = require('node:readline');
const log = (event) => fs.appendFileSync(process.env.HAPPIER_E2E_FAKE_CLAUDE_LOG, JSON.stringify(event) + '\n');
log({ type: 'spawn', pid: process.pid, argv: process.argv.slice(2), cwd: process.cwd(), configDir: process.env.CLAUDE_CONFIG_DIR,
  nestedSession: process.env.CLAUDECODE, refreshToken: process.env.CLAUDE_CODE_OAUTH_REFRESH_TOKEN });
process.on('SIGTERM', () => process.exit(0));
process.on('exit', () => log({ type: 'closed' }));
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const message = JSON.parse(line);
  log(message);
  if (message.type === 'control_request' && message.request.subtype === 'initialize' && !process.env.HAPPIER_E2E_CATALOG_HANG) {
    const commands = JSON.parse(process.env.HAPPIER_E2E_CATALOG_COMMANDS);
    process.stdout.write(JSON.stringify({ type: 'control_response', response: {
      subtype: 'success', request_id: message.request_id,
      response: { commands, models: [], agents: [] }
    } }) + '\n');
  }
  if (message.type === 'user') {
    process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', session_id: 'fixture-session',
      result: 'command accepted', is_error: false, duration_ms: 1, duration_api_ms: 0, num_turns: 1,
      total_cost_usd: 0, usage: { input_tokens: 0, output_tokens: 0 }, modelUsage: {}, permission_denials: [] }) + '\n');
  }
});
`;

async function readEvents(logPath: string): Promise<Array<Record<string, unknown>>> {
  return (await readFile(logPath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
}

export async function waitForClosed(logPath: string): Promise<Array<Record<string, unknown>>> {
  // The SDK's close() is synchronous; process exit settles on the next OS event.
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const events = await readEvents(logPath);
    if (events.some((event) => event.type === 'closed')) return events;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return await readEvents(logPath);
}
