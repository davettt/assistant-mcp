// End to end: a real Due Again server (../due-again) with a temp data folder, assistant
// access turned on through its API, then this MCP server driven over stdio by the SDK
// client, the way Claude Desktop drives it.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const DUE_AGAIN = path.join(here, '..', '..', 'due-again');
const SERVER = path.join(here, '..', 'src', 'index.js');

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
    s.on('error', reject);
  });
}

async function waitFor(url, attempts = 200) {
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`${url} did not come up`);
}

function parse(result) {
  assert.ok(!result.isError, `tool failed: ${result.content?.[0]?.text}`);
  return JSON.parse(result.content[0].text);
}

const skip = !fs.existsSync(path.join(DUE_AGAIN, 'server', 'index.js'));

describe(
  'Due Again through the MCP server',
  { skip: skip && 'due-again checkout not found' },
  () => {
    let root, app, port, client, transport;

    before(async () => {
      root = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-mcp-'));
      port = await freePort();
      // DATA_DIR/local_data is where Due Again keeps its files and the token.
      app = spawn(process.execPath, [path.join(DUE_AGAIN, 'server', 'index.js')], {
        env: {
          ...process.env,
          PORT: String(port),
          DATA_DIR: path.join(root, 'due-again'),
          NODE_ENV: 'test',
        },
        stdio: 'ignore',
      });
      await waitFor(`http://127.0.0.1:${port}/api/health`);

      transport = new StdioClientTransport({
        command: process.execPath,
        args: [SERVER],
        env: { ...process.env, TC_DATA_ROOT: root },
      });
      client = new Client({ name: 'test', version: '0' });
      await client.connect(transport);
    });

    after(async () => {
      await client?.close();
      app?.kill();
      fs.rmSync(root, { recursive: true, force: true });
    });

    it('lists the Due Again tools and the shared ones', async () => {
      const { tools } = await client.listTools();
      const names = tools.map((t) => t.name);
      for (const n of [
        'whats_on',
        'open_app',
        'due_again_items',
        'due_again_history',
        'due_again_add_item',
        'due_again_complete',
      ]) {
        assert.ok(names.includes(n), n);
      }
      // Only Due Again exists under this test's data root, so no other app's tools are offered.
      assert.ok(
        !names.some((n) => n.startsWith('gift_keeper_') || n.startsWith('client_manager_')),
        'uninstalled apps offer no tools',
      );
      const readOnly = tools.find((t) => t.name === 'due_again_items').annotations?.readOnlyHint;
      assert.equal(readOnly, true);
    });

    it('reports Due Again as not enabled before the setting is on', async () => {
      const out = parse(await client.callTool({ name: 'due_again_items', arguments: {} }));
      assert.equal(out.available, false);
      assert.equal(out.reason, 'not-enabled');
      const on = parse(await client.callTool({ name: 'whats_on', arguments: { days: 30 } }));
      assert.ok(on.unavailable.some((u) => u.app === 'Due Again' && u.reason === 'not-enabled'));
    });

    it('reads items once assistant access is on', async () => {
      const base = `http://127.0.0.1:${port}`;
      let res = await fetch(`${base}/api/settings`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ assistantAccess: true }),
      });
      assert.equal(res.status, 200);
      const cats = await (await fetch(`${base}/api/categories`)).json();
      const soon = new Date();
      soon.setDate(soon.getDate() + 3);
      // Local calendar day: the UTC day is behind local time for part of every day in Australia.
      const nextDue = `${soon.getFullYear()}-${String(soon.getMonth() + 1).padStart(2, '0')}-${String(soon.getDate()).padStart(2, '0')}`;
      res = await fetch(`${base}/api/items`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          title: 'Car insurance',
          categoryId: cats[0].id,
          recurrence: { type: 'annual' },
          nextDue,
          expectedCost: 900,
        }),
      });
      assert.equal(res.status, 201, await res.text());

      const out = parse(await client.callTool({ name: 'due_again_items', arguments: {} }));
      assert.equal(out.available, undefined);
      assert.equal(out.count, 1);
      assert.equal(out.items[0].title, 'Car insurance');
      assert.equal(out.items[0].status, 'due-soon');
      assert.equal(out.items[0].daysUntilDue, 3);

      const on = parse(await client.callTool({ name: 'whats_on', arguments: { days: 7 } }));
      assert.equal(on.count, 1);
      assert.equal(on.items[0].app, 'Due Again');
      assert.ok(!on.unavailable.some((u) => u.app === 'Due Again'));
    });

    it('records a completion and the next due date moves on', async () => {
      const items = parse(await client.callTool({ name: 'due_again_items', arguments: {} }));
      const id = items.items[0].id;
      const out = parse(
        await client.callTool({
          name: 'due_again_complete',
          arguments: { itemId: id, cost: 910, note: 'paid online' },
        }),
      );
      assert.equal(out.changed, 'completed');
      assert.ok(out.item.nextDue > items.items[0].nextDue, 'next due did not advance');
      const history = parse(
        await client.callTool({ name: 'due_again_history', arguments: { itemId: id } }),
      );
      assert.equal(history.history.length, 1);
      assert.equal(history.history[0].cost, 910);
    });

    it('adds an item, resolving the category by name, and lists categories on a miss', async () => {
      const miss = parse(
        await client.callTool({
          name: 'due_again_add_item',
          arguments: { title: 'Car rego', category: 'No Such Category', nextDue: '2027-03-01' },
        }),
      );
      assert.equal(miss.added, false);
      assert.ok(miss.categories.length > 0);
      const category = miss.categories[0];
      const out = parse(
        await client.callTool({
          name: 'due_again_add_item',
          arguments: {
            title: 'Car rego',
            category: category.toLowerCase(),
            nextDue: '2027-03-01',
            repeat: 'annual',
            expectedCost: 900,
            reminders: [14, 1],
          },
        }),
      );
      assert.equal(out.added, true);
      assert.equal(out.item.title, 'Car rego');
      assert.equal(out.item.category, category);
      assert.deepEqual(out.item.recurrence, { type: 'annual' });
      const items = parse(
        await client.callTool({ name: 'due_again_items', arguments: { search: 'rego' } }),
      );
      assert.equal(items.count, 1);
      const needsInterval = parse(
        await client.callTool({
          name: 'due_again_add_item',
          arguments: { title: 'Filter', category, nextDue: '2027-01-01', repeat: 'months' },
        }),
      );
      assert.equal(needsInterval.added, false);
      assert.match(needsInterval.message, /interval/);
    });

    it('moves an item, reschedules one occurrence and skips one', async () => {
      const items = parse(await client.callTool({ name: 'due_again_items', arguments: {} }));
      const id = items.items[0].id;
      const moved = parse(
        await client.callTool({
          name: 'due_again_update_item',
          arguments: { itemId: id, nextDue: '2027-06-01', notes: 'moved by the assistant' },
        }),
      );
      assert.equal(moved.changed, true);
      assert.equal(moved.item.nextDue, '2027-06-01');
      const nothing = parse(
        await client.callTool({ name: 'due_again_update_item', arguments: { itemId: id } }),
      );
      assert.equal(nothing.changed, false);
      const re = parse(
        await client.callTool({
          name: 'due_again_reschedule',
          arguments: { itemId: id, date: '2027-06-15' },
        }),
      );
      assert.equal(re.changed, 'rescheduled');
      assert.equal(re.item.nextDue, '2027-06-15');
      const skipped = parse(
        await client.callTool({ name: 'due_again_skip', arguments: { itemId: id } }),
      );
      assert.equal(skipped.changed, 'skipped');
      assert.ok(skipped.item.nextDue > '2027-06-15', 'skip moves the next due on');
    });

    it('refuses a completion dated in the future with the app’s message', async () => {
      const items = parse(await client.callTool({ name: 'due_again_items', arguments: {} }));
      const result = await client.callTool({
        name: 'due_again_complete',
        arguments: { itemId: items.items[0].id, date: '2999-01-01' },
      });
      assert.equal(result.isError, true);
      assert.match(result.content[0].text, /future/);
    });

    it('loses access when the setting is turned off', async () => {
      await fetch(`http://127.0.0.1:${port}/api/settings`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ assistantAccess: false }),
      });
      const out = parse(await client.callTool({ name: 'due_again_items', arguments: {} }));
      assert.equal(out.available, false);
      assert.equal(out.reason, 'not-enabled');
    });
  },
);
