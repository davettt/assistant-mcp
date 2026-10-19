// ChatGPT desktop and Codex share MCP configuration. Use the CLI shipped with
// ChatGPT to edit it, so other servers and unrelated settings stay intact.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { npxPath, SERVER_KEY } from './install.js';

const PACKAGE = '@tiongcreative/assistant-mcp';

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

function matches(server, env) {
  const transport = server?.transport;
  return (
    transport?.type === 'stdio' &&
    transport.command === npxPath() &&
    JSON.stringify(transport.args) === JSON.stringify(['-y', PACKAGE]) &&
    JSON.stringify(transport.env ?? {}) === JSON.stringify(env)
  );
}

export function chatGptStatus(cli = cliPath()) {
  const server = current(cli);
  return { installed: !!server, managed: matches(server, server?.transport?.env ?? {}) };
}

export function installChatGpt({ allowFresh = false, cli = cliPath() } = {}) {
  const env = allowFresh ? { npm_config_min_release_age: '0' } : {};
  const server = current(cli);
  if (matches(server, env)) return { already: true };
  if (server) {
    throw new Error(
      'An MCP server named "tiongcreative" already exists in ChatGPT. Remove it in ChatGPT settings before installing this one.',
    );
  }
  const args = ['mcp', 'add'];
  for (const [key, value] of Object.entries(env)) args.push('--env', `${key}=${value}`);
  args.push(SERVER_KEY, '--', npxPath(), '-y', PACKAGE);
  run(cli, args);
  return { already: false };
}

export function uninstallChatGpt(cli = cliPath()) {
  const server = current(cli);
  if (!server) return { removed: false };
  if (!matches(server, server.transport?.env ?? {})) {
    throw new Error(
      'The "tiongcreative" entry in ChatGPT does not match this package; nothing was removed.',
    );
  }
  run(cli, ['mcp', 'remove', SERVER_KEY]);
  return { removed: true };
}
