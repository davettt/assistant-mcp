// TIONGCREATIVE_APPS: a client can load only some apps, so a small local model fits the
// tool list in its context. Unset means every app; a wrong id stops the server.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { selectApps, unknownAppsMessage } from '../src/selection.js';
import * as dueAgain from '../src/apps/due-again.js';
import * as giftKeeper from '../src/apps/gift-keeper.js';
import * as clientManager from '../src/apps/client-manager.js';
import * as listsAndNotes from '../src/apps/lists-and-notes.js';
import * as budgetPlanner from '../src/apps/budget-planner.js';
import * as diagramSnap from '../src/apps/diagramsnap.js';

const ALL = [dueAgain, giftKeeper, clientManager, listsAndNotes, budgetPlanner, diagramSnap];
const SERVER = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'index.js');
const ids = (apps) => apps.map((a) => a.app.id);

describe('selectApps', () => {
  it('chooses every app when unset or empty', () => {
    for (const value of [undefined, '', ' , ']) {
      const s = selectApps(ALL, value);
      assert.deepEqual(ids(s.chosen), ids(ALL));
      assert.deepEqual(s.leftOut, []);
      assert.equal(s.setting, undefined);
    }
  });

  it('chooses the named apps, ignoring case and spaces', () => {
    const s = selectApps(ALL, ' Client-Manager , due-again');
    assert.deepEqual(ids(s.chosen), ['due-again', 'client-manager']);
    assert.equal(s.leftOut.length, 4);
    assert.deepEqual(s.unknown, []);
    assert.equal(s.setting, 'client-manager,due-again');
  });

  it('reports ids that name no app', () => {
    const s = selectApps(ALL, 'client_manager,client-manager');
    assert.deepEqual(s.unknown, ['client_manager']);
    const message = unknownAppsMessage(ALL, s.unknown);
    assert.match(message, /"client_manager"/);
    for (const a of ALL) assert.ok(message.includes(a.app.id), a.app.id);
  });
});

describe('server with TIONGCREATIVE_APPS', () => {
  let root;
  before(() => {
    // Every app counts as installed under TC_DATA_ROOT when its data folder exists.
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-mcp-sel-'));
    for (const a of ALL) fs.mkdirSync(path.join(root, a.app.dataDir));
  });
  after(() => fs.rmSync(root, { recursive: true, force: true }));

  async function connect(apps) {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [SERVER],
      env: {
        ...process.env,
        TC_DATA_ROOT: root,
        TC_RUNNING_APPS: '',
        ...(apps === undefined ? {} : { TIONGCREATIVE_APPS: apps }),
      },
    });
    const client = new Client({ name: 'test', version: '0' });
    await client.connect(transport);
    return client;
  }

  it('loads every app when unset', async () => {
    const client = await connect(undefined);
    try {
      const names = (await client.listTools()).tools.map((t) => t.name);
      for (const a of ALL) assert.ok(names.includes(a.tools[0].name), a.app.id);
      const info = JSON.parse(
        (await client.callTool({ name: 'assistant_info', arguments: {} })).content[0].text,
      );
      assert.equal(info.appsSetting, undefined);
    } finally {
      await client.close();
    }
  });

  it('loads only the chosen app, and says which were left out', async () => {
    const client = await connect('client-manager');
    try {
      const { tools } = await client.listTools();
      const own = tools.filter((t) => !clientManager.tools.some((c) => c.name === t.name));
      // Only the shared tools besides Client Manager's own.
      assert.deepEqual(own.map((t) => t.name).sort(), [
        'assistant_info',
        'feedback',
        'open_app',
        'routine',
        'whats_on',
      ]);
      const openApp = tools.find((t) => t.name === 'open_app');
      assert.deepEqual(openApp.inputSchema.properties.app.enum, ['client-manager']);

      const instructions = client.getInstructions();
      assert.match(instructions, /Client Manager:/);
      assert.doesNotMatch(instructions, /^Due Again:/m);
      assert.match(instructions, /Not loaded on this connection.*Due Again/);

      const info = JSON.parse(
        (await client.callTool({ name: 'assistant_info', arguments: {} })).content[0].text,
      );
      assert.deepEqual(
        info.apps.map((a) => a.app),
        ['Client Manager'],
      );
      assert.deepEqual(info.notInstalled, []);
      assert.equal(info.appsSetting.value, 'client-manager');
      assert.equal(info.appsSetting.leftOut.length, 5);
      for (const p of info.routines.names)
        assert.ok(!/gift|budget|diagram|note/i.test(p.name), p.name);
    } finally {
      await client.close();
    }
  });

  it('refuses to start with an id that names no app', () => {
    const run = spawnSync(process.execPath, [SERVER], {
      env: { ...process.env, TC_DATA_ROOT: root, TIONGCREATIVE_APPS: 'client_manager' },
      input: '',
      encoding: 'utf8',
      timeout: 10000,
    });
    assert.equal(run.status, 1);
    assert.match(run.stderr, /TIONGCREATIVE_APPS: no app with the id "client_manager"/);
  });
});
