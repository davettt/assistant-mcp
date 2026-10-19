import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { chatGptStatus, installChatGpt, uninstallChatGpt } from '../src/chatgpt-install.js';
import { npxPath } from '../src/install.js';

describe('ChatGPT desktop install command', () => {
  let dir, cli, state;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-chatgpt-install-'));
    state = path.join(dir, 'servers.json');
    cli = path.join(dir, 'codex');
    process.env.TC_FAKE_MCP_STATE = state;
    fs.writeFileSync(
      cli,
      `#!${process.execPath}\n` +
        String.raw`
const fs = require('node:fs');
const file = process.env.TC_FAKE_MCP_STATE;
const servers = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : [];
const args = process.argv.slice(2);
if (args[0] !== 'mcp') process.exit(2);
if (args[1] === 'list') process.stdout.write(JSON.stringify(servers));
else if (args[1] === 'add') {
  const nameIndex = args.indexOf('tiongcreative');
  const separator = args.indexOf('--');
  const env = {};
  for (let i = 2; i < nameIndex; i++) {
    if (args[i] === '--env') {
      const [key, value] = args[++i].split('=');
      env[key] = value;
    }
  }
  servers.push({ name: 'tiongcreative', transport: { type: 'stdio', command: args[separator + 1], args: args.slice(separator + 2), env } });
  fs.writeFileSync(file, JSON.stringify(servers));
} else if (args[1] === 'remove') {
  fs.writeFileSync(file, JSON.stringify(servers.filter((server) => server.name !== args[2])));
} else process.exit(2);
`,
    );
    fs.chmodSync(cli, 0o755);
  });

  afterEach(() => {
    delete process.env.TC_FAKE_MCP_STATE;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('registers the local stdio command and leaves other servers alone', () => {
    fs.writeFileSync(state, JSON.stringify([{ name: 'other', transport: { type: 'stdio' } }]));
    assert.deepEqual(installChatGpt({ cli }), { already: false });
    const servers = JSON.parse(fs.readFileSync(state, 'utf8'));
    assert.equal(servers[0].name, 'other');
    assert.deepEqual(servers[1].transport, {
      type: 'stdio',
      command: npxPath(),
      args: ['-y', '@tiongcreative/assistant-mcp'],
      env: {},
    });
    assert.deepEqual(installChatGpt({ cli }), { already: true });
    assert.deepEqual(chatGptStatus(cli), { installed: true, managed: true });
    assert.deepEqual(uninstallChatGpt(cli), { removed: true });
    assert.deepEqual(JSON.parse(fs.readFileSync(state, 'utf8')), [servers[0]]);
  });

  it('passes the optional npm release-age setting and protects an unrelated entry', () => {
    installChatGpt({ cli, allowFresh: true });
    assert.equal(
      JSON.parse(fs.readFileSync(state, 'utf8'))[0].transport.env.npm_config_min_release_age,
      '0',
    );
    fs.writeFileSync(
      state,
      JSON.stringify([
        { name: 'tiongcreative', transport: { type: 'stdio', command: 'other', args: [] } },
      ]),
    );
    assert.throws(() => installChatGpt({ cli }), /already exists/);
    assert.throws(() => uninstallChatGpt(cli), /does not match/);
  });
});
