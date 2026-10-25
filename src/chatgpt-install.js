// ChatGPT desktop and Codex share MCP configuration. Use the CLI shipped with
// ChatGPT to edit it, so other servers and unrelated settings stay intact.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { commandMissing, isOurEntry, launcher, SERVER_KEY } from './install.js';

function cliPath() {
  const relative = path.join('Contents', 'Resources', 'codex-cli', 'bin', 'codex');
  for (const apps of ['/Applications', path.join(os.homedir(), 'Applications')]) {
    const candidate = path.join(apps, 'ChatGPT.app', relative);
    if (fs.existsSync(candidate)) return candidate;
  }
  throw new Error(
    'ChatGPT desktop was not found in Applications. Install it before running this command.',
  );
}

function run(cli, args) {
  try {
    return execFileSync(cli, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (err) {
    const detail = err.stderr?.toString().trim() || err.message;
    throw new Error(`ChatGPT could not update its MCP settings: ${detail}`);
  }
}

function current(cli) {
  const servers = JSON.parse(run(cli, ['mcp', 'list', '--json']));
  if (!Array.isArray(servers)) throw new Error('ChatGPT returned an unexpected MCP server list.');
  return servers.find((server) => server.name === SERVER_KEY) ?? null;
}

/** Our entry, written by any version of this package, whatever npx path it recorded. */
function ours(server) {
  return server?.transport?.type === 'stdio' && isOurEntry(server.transport.args);
}

function matches(server, want) {
  const transport = server?.transport;
  return (
    ours(server) &&
    transport.command === want.command &&
    JSON.stringify(transport.args) === JSON.stringify(want.args) &&
    JSON.stringify(transport.env ?? {}) === JSON.stringify(want.env)
  );
}

export function chatGptStatus(cli = cliPath()) {
  const server = current(cli);
  const command = server?.transport?.command ?? null;
  return {
    installed: !!server,
    managed: ours(server),
    broken: ours(server) && commandMissing(command),
    command,
  };
}

/**
 * Adds the server, or replaces our own entry when it differs (an older npx path after a
 * Node upgrade, say). An entry by that name that this package did not write is left alone.
 */
export function installChatGpt({ allowFresh = false, cli = cliPath() } = {}) {
  const start = launcher();
  const want = {
    ...start,
    env: { ...start.env, ...(allowFresh ? { npm_config_min_release_age: '0' } : {}) },
  };
  const server = current(cli);
  if (matches(server, want)) return { already: true, replaced: false };
  if (server && !ours(server)) {
    throw new Error(
      'An MCP server named "tiongcreative" already exists in ChatGPT. Remove it in ChatGPT settings before installing this one.',
    );
  }
  if (server) run(cli, ['mcp', 'remove', SERVER_KEY]);
  const args = ['mcp', 'add'];
  for (const [key, value] of Object.entries(want.env)) args.push('--env', `${key}=${value}`);
  args.push(SERVER_KEY, '--', want.command, ...want.args);
  run(cli, args);
  return { already: false, replaced: !!server };
}

export function uninstallChatGpt(cli = cliPath()) {
  const server = current(cli);
  if (!server) return { removed: false };
  if (!ours(server)) {
    throw new Error(
      'The "tiongcreative" entry in ChatGPT does not match this package; nothing was removed.',
    );
  }
  run(cli, ['mcp', 'remove', SERVER_KEY]);
  return { removed: true };
}
