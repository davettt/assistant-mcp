import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { install, runCli, status, uninstall } from '../src/install.js';

describe('Claude Desktop install command', () => {
  let dir, file;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-install-'));
    file = path.join(dir, 'Claude', 'claude_desktop_config.json');
    process.env.TC_CLAUDE_CONFIG = file;
  });

  afterEach(() => {
    delete process.env.TC_CLAUDE_CONFIG;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('creates the config when Claude Desktop has none, with the full npx path', () => {
    const r = install();
    assert.equal(r.already, false);
    assert.equal(r.backup, null, 'no backup when there was no file');
    const written = JSON.parse(fs.readFileSync(file, 'utf8'));
    const entry = written.mcpServers.tiongcreative;
    assert.ok(path.isAbsolute(entry.command) && entry.command.endsWith('/npx'), entry.command);
    assert.deepEqual(entry.args, ['-y', '@tiongcreative/assistant-mcp']);
    assert.equal(entry.env, undefined, 'no env for a member');
    assert.equal(status().installed, true);
  });

  it('keeps everything else in an existing config and backs it up', () => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      JSON.stringify({ preferences: { theme: 'dark' }, mcpServers: { other: { command: 'x' } } }),
    );
    const r = install();
    assert.ok(r.backup && fs.existsSync(r.backup), 'backup written');
    const written = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.deepEqual(written.preferences, { theme: 'dark' });
    assert.deepEqual(written.mcpServers.other, { command: 'x' });
    assert.ok(written.mcpServers.tiongcreative);
    const again = install();
    assert.equal(again.already, true, 'second install changes nothing');
    assert.equal(fs.readdirSync(path.dirname(file)).filter((f) => f.includes('backup')).length, 1);
  });

  it('refuses to touch a config it cannot parse', () => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{ not json');
    assert.throws(() => install(), /could not be read as JSON/);
    assert.equal(fs.readFileSync(file, 'utf8'), '{ not json', 'file untouched');
    assert.equal(
      runCli(['install'], () => {}),
      1,
    );
  });

  it('uninstall removes only our entry', () => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ mcpServers: { other: { command: 'x' } } }));
    install();
    const r = uninstall();
    assert.equal(r.removed, true);
    const written = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.deepEqual(written.mcpServers, { other: { command: 'x' } });
    assert.equal(uninstall().removed, false);
    assert.equal(status().installed, false);
  });

  it('the CLI prints next steps and a usage line', () => {
    const out = [];
    assert.equal(
      runCli(['install'], (s) => out.push(s)),
      0,
    );
    assert.match(out.join('\n'), /Quit Claude Desktop completely/);
    assert.match(out.join('\n'), /Allow assistant access/);
    const usage = [];
    assert.equal(
      runCli(['wat'], (s) => usage.push(s)),
      2,
    );
    assert.match(usage.join('\n'), /Usage/);
    const fresh = install({ env: { npm_config_min_release_age: '0' } });
    assert.equal(fresh.entry.env.npm_config_min_release_age, '0');
  });
});
