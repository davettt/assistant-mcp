// `npx @tiongcreative/assistant-mcp install`: sets the assistant up in Claude Desktop so a
// member never edits JSON by hand. It adds one entry to Claude Desktop's config file (and
// nothing else), keeps a backup, and records a full path to npx, because a desktop app
// does not see the shell's PATH and would otherwise fail to find it. Under a Node version
// manager that path must not name a version, or the next Node upgrade breaks it (launcher).
//
// `uninstall` removes the entry. `status` says whether it is set up.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chatGptStatus, installChatGpt, uninstallChatGpt } from './chatgpt-install.js';

export const SERVER_KEY = 'tiongcreative';
const PACKAGE = '@tiongcreative/assistant-mcp';

/** Claude Desktop's config file on this Mac (TC_CLAUDE_CONFIG overrides it, for tests). */
export function configPath() {
  if (process.env.TC_CLAUDE_CONFIG) return process.env.TC_CLAUDE_CONFIG;
  if (process.platform !== 'darwin') {
    throw new Error('The Tiong Creative apps run on macOS, so this installer does too.');
  }
  return path.join(
    os.homedir(),
    'Library',
    'Application Support',
    'Claude',
    'claude_desktop_config.json',
  );
}

/**
 * How a desktop app should start the server: { command, args, env }. A Node version
 * manager keeps each version in its own folder and removes it on upgrade, so a path into
 * one stops working; use the manager's stable entry point instead. Otherwise, the npx
 * beside the node running this command.
 */
export function launcher(execPath = process.execPath, home = os.homedir()) {
  const npxArgs = ['-y', PACKAGE];
  // nvm: nvm-exec loads nvm and runs the command with the "default" alias's Node.
  const nvmExec = path.join(home, '.nvm', 'nvm-exec');
  if (
    execPath.startsWith(path.join(home, '.nvm', 'versions') + path.sep) &&
    fs.existsSync(nvmExec)
  ) {
    return { command: nvmExec, args: ['npx', ...npxArgs], env: { NODE_VERSION: 'default' } };
  }
  // Volta: its shims in ~/.volta/bin pick the Node it has chosen.
  const voltaNpx = path.join(home, '.volta', 'bin', 'npx');
  if (execPath.startsWith(path.join(home, '.volta') + path.sep) && fs.existsSync(voltaNpx)) {
    return { command: voltaNpx, args: npxArgs, env: {} };
  }
  const candidate = path.join(path.dirname(execPath), 'npx');
  if (fs.existsSync(candidate)) return { command: candidate, args: npxArgs, env: {} };
  throw new Error(`Could not find npx next to node at ${execPath}.`);
}

/** An entry this package wrote, from any version of it, whatever path it recorded. */
export function isOurEntry(args) {
  const tail = JSON.stringify(['-y', PACKAGE]);
  return Array.isArray(args) && JSON.stringify(args.slice(-2)) === tail && args.length <= 3;
}

/** The entry points at a program that is no longer there (e.g. a Node removed on upgrade). */
export function commandMissing(command) {
  return typeof command === 'string' && path.isAbsolute(command) && !fs.existsSync(command);
}

function readConfig(file) {
  if (!fs.existsSync(file)) return { config: {}, existed: false };
  const raw = fs.readFileSync(file, 'utf8');
  if (!raw.trim()) return { config: {}, existed: true };
  try {
    const config = JSON.parse(raw);
    if (!config || typeof config !== 'object' || Array.isArray(config)) {
      throw new Error('not an object');
    }
    return { config, existed: true };
  } catch (err) {
    throw new Error(
      `Claude Desktop's config file could not be read as JSON (${err.message}), so nothing was changed. File: ${file}`,
    );
  }
}

function writeConfig(file, config, existed) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let backup = null;
  if (existed) {
    backup = `${file}.backup-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    fs.copyFileSync(file, backup);
  }
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(config, null, 2) + '\n');
  fs.renameSync(tmp, file);
  return backup;
}

export function install({ env } = {}) {
  const file = configPath();
  const { config, existed } = readConfig(file);
  const run = launcher();
  const entry = { command: run.command, args: run.args };
  const allEnv = { ...run.env, ...env };
  if (Object.keys(allEnv).length) entry.env = allEnv;
  const servers =
    config.mcpServers && typeof config.mcpServers === 'object' ? config.mcpServers : {};
  const already = JSON.stringify(servers[SERVER_KEY]) === JSON.stringify(entry);
  config.mcpServers = { ...servers, [SERVER_KEY]: entry };
  const backup = already ? null : writeConfig(file, config, existed);
  return { file, backup, already, entry };
}

export function uninstall() {
  const file = configPath();
  const { config, existed } = readConfig(file);
  if (!existed || !config.mcpServers || !(SERVER_KEY in config.mcpServers)) {
    return { file, removed: false };
  }
  const rest = { ...config.mcpServers };
  delete rest[SERVER_KEY];
  config.mcpServers = rest;
  const backup = writeConfig(file, config, true);
  return { file, removed: true, backup };
}

export function status() {
  const file = configPath();
  try {
    const { config, existed } = readConfig(file);
    const entry = existed ? config.mcpServers?.[SERVER_KEY] : undefined;
    return {
      file,
      installed: !!entry,
      broken: !!entry && commandMissing(entry.command),
      entry: entry ?? null,
    };
  } catch (err) {
    return { file, installed: false, error: err.message };
  }
}

const NEXT_STEPS = [
  '1. Quit Claude Desktop completely and open it again.',
  '2. The first time you chat, allow the "tiongcreative" server when Claude Desktop asks.',
  '3. In each Tiong Creative app, open Settings and turn on "Allow assistant access".',
  '4. With the apps open, ask Claude what is on this week.',
];

/** Runs the command and returns the process exit code. Prints with the given writer. */
export function runCli(args, print = console.log) {
  const [command, client] = args;
  try {
    if (client === 'chatgpt' && ['install', 'uninstall', 'status'].includes(command)) {
      if (command === 'install') {
        const result = installChatGpt({ allowFresh: args.includes('--allow-fresh') });
        print(
          result.already
            ? 'The Tiong Creative assistant is already set up in ChatGPT.'
            : result.replaced
              ? 'Updated the Tiong Creative assistant in ChatGPT.'
              : 'Added the Tiong Creative assistant to ChatGPT.',
        );
        print(
          '\nNext:\n1. Restart the ChatGPT desktop app.\n2. Open each Tiong Creative app and turn on "Allow assistant access" in Settings.\n3. Type /mcp in ChatGPT to check the connection.',
        );
      } else if (command === 'uninstall') {
        const result = uninstallChatGpt();
        print(
          result.removed
            ? 'Removed the Tiong Creative assistant from ChatGPT. Restart ChatGPT to finish.'
            : 'The Tiong Creative assistant was not set up in ChatGPT.',
        );
      } else {
        const result = chatGptStatus();
        print(
          result.broken
            ? `Set up in ChatGPT, but it starts the assistant with ${result.command}, which is no longer on this Mac (Node was probably upgraded). Run install chatgpt again.`
            : result.managed
              ? 'Set up in ChatGPT.'
              : result.installed
                ? 'ChatGPT has a different MCP server named "tiongcreative".'
                : 'Not set up in ChatGPT.',
        );
      }
      return 0;
    }
    if (
      client &&
      client !== '--allow-fresh' &&
      ['install', 'uninstall', 'status'].includes(command)
    ) {
      throw new Error('Choose "chatgpt" as the client, or omit it for Claude Desktop.');
    }
    if (command === 'install') {
      const env = {};
      // Developer convenience: `install --allow-fresh` passes npm's release-age override
      // through to the server entry, for Macs that refuse packages younger than a few days.
      if (args.includes('--allow-fresh')) env.npm_config_min_release_age = '0';
      const r = install({ env });
      print(
        r.already
          ? `The Tiong Creative assistant is already set up in Claude Desktop (${r.file}).`
          : `Added the Tiong Creative assistant to Claude Desktop.\n  Config: ${r.file}${r.backup ? `\n  Backup of the previous file: ${r.backup}` : ''}`,
      );
      print('\nNext:\n' + NEXT_STEPS.join('\n'));
      return 0;
    }
    if (command === 'uninstall') {
      const r = uninstall();
      print(
        r.removed
          ? `Removed the Tiong Creative assistant from Claude Desktop (${r.file}). Restart Claude Desktop to finish.`
          : `The Tiong Creative assistant was not set up in Claude Desktop (${r.file}), so nothing changed.`,
      );
      return 0;
    }
    if (command === 'status') {
      const r = status();
      if (r.error) print(r.error);
      else
        print(
          r.broken
            ? `Set up in Claude Desktop, but it starts the assistant with ${r.entry.command}, which is no longer on this Mac (Node was probably upgraded). Run install again.`
            : r.installed
              ? `Set up in Claude Desktop: ${r.file}`
              : `Not set up in Claude Desktop (${r.file}).`,
        );
      return 0;
    }
    print(
      `Usage:\n  npx ${PACKAGE} install              add the assistant to Claude Desktop\n  npx ${PACKAGE} install chatgpt      add it to ChatGPT desktop\n  npx ${PACKAGE} uninstall [chatgpt] remove it from the chosen client\n  npx ${PACKAGE} status [chatgpt]    check the chosen client\n\nWith no command, this runs the MCP server itself.`,
    );
    return command === 'help' || command === '--help' ? 0 : 2;
  } catch (err) {
    print(`Could not finish: ${err.message}`);
    return 1;
  }
}
