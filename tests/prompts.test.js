// Prompts name tools in their text; a renamed or removed tool must not leave a stale name
// behind, and a prompt must only be offered when the apps it uses are installed.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { PROMPTS, promptsFor } from '../src/prompts.js';
import * as dueAgain from '../src/apps/due-again.js';
import * as giftKeeper from '../src/apps/gift-keeper.js';
import * as clientManager from '../src/apps/client-manager.js';
import * as listsAndNotes from '../src/apps/lists-and-notes.js';
import * as budgetPlanner from '../src/apps/budget-planner.js';
import * as diagramSnap from '../src/apps/diagramsnap.js';

const ALL = [dueAgain, giftKeeper, clientManager, listsAndNotes, budgetPlanner, diagramSnap];
const SERVER_TOOLS = ['whats_on', 'open_app', 'assistant_info'];
const SERVER = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'index.js');
const toolNames = (text) => text.match(/\b[a-z]+(?:_[a-z]+)+\b/g) ?? [];

describe('prompts', () => {
  it('name only tools of the apps they need', () => {
    for (const p of PROMPTS) {
      const apps = p.apps.length ? ALL : ALL.filter((m) => p.apps.includes(m.app.id));
      const known = new Set([...SERVER_TOOLS, ...apps.flatMap((m) => m.tools.map((t) => t.name))]);
      const named = toolNames(p.text({}));
      assert.ok(named.length > 0, `${p.name} names no tools`);
      for (const name of named) assert.ok(known.has(name), `${p.name}: ${name}`);
    }
  });

  it('need only apps that exist', () => {
    const ids = new Set(ALL.map((m) => m.app.id));
    for (const p of PROMPTS) for (const id of p.apps) assert.ok(ids.has(id), `${p.name}: ${id}`);
  });

  it('are offered only for installed apps', () => {
    assert.deepEqual(
      promptsFor([budgetPlanner]).map((p) => p.name),
      ['attention_this_week', 'check_statement', 'review_month_budget'],
    );
    assert.deepEqual(promptsFor([]), []);
  });

  it('read a days argument and fall back on anything else', () => {
    const plan = PROMPTS.find((p) => p.name === 'plan_gifts');
    assert.match(plan.text({ days: '30' }), /withinDays 30\b/);
    assert.match(plan.text({ days: 'soon' }), /withinDays 60\b/);
    assert.match(plan.text({}), /withinDays 60\b/);
  });

  describe('over MCP', () => {
    let root;
    let client;

    before(async () => {
      root = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-mcp-prompts-'));
      fs.mkdirSync(path.join(root, budgetPlanner.app.dataDir));
      fs.mkdirSync(path.join(root, giftKeeper.app.dataDir));
      client = new Client({ name: 'test', version: '0' });
      await client.connect(
        new StdioClientTransport({
          command: process.execPath,
          args: [SERVER],
          env: { ...process.env, TC_DATA_ROOT: root },
        }),
      );
    });

    after(async () => {
      await client?.close();
      fs.rmSync(root, { recursive: true, force: true });
    });

    it('lists the prompts for the installed apps', async () => {
      const { prompts } = await client.listPrompts();
      assert.deepEqual(prompts.map((p) => p.name).sort(), [
        'attention_this_week',
        'check_statement',
        'plan_gifts',
        'review_month_budget',
      ]);
    });

    it('returns a prompt as a user message, with its argument', async () => {
      const result = await client.getPrompt({ name: 'plan_gifts', arguments: { days: '21' } });
      assert.equal(result.messages[0].role, 'user');
      assert.match(result.messages[0].content.text, /withinDays 21\b/);
    });

    it('points assistant_info at the npm page for the latest version', async () => {
      const result = await client.callTool({ name: 'assistant_info', arguments: {} });
      const info = JSON.parse(result.content[0].text);
      assert.equal(info.latestVersion.known, false);
      assert.equal(
        info.latestVersion.checkAt,
        'https://www.npmjs.com/package/@tiongcreative/assistant-mcp',
      );
      assert.equal(info.feedback.page, 'https://tiongcreative.com.au/contact/');
      assert.match(info.feedback.how, /nothing is sent from here/);
    });

    it('sends the common rule about several changes in the instructions', () => {
      assert.match(client.getInstructions(), /show the proposed changes and wait/);
    });
  });
});
