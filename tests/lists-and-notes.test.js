// End to end: a real Lists & Notes server (../list-manager) with a temp data folder, assistant
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
const LISTS_AND_NOTES = path.join(here, '..', '..', 'list-manager');
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

const skip = !fs.existsSync(path.join(LISTS_AND_NOTES, 'server.js'));

describe(
  'Lists & Notes through the MCP server',
  { skip: skip && 'list-manager checkout not found' },
  () => {
    let root, app, port, client, transport, base, dataDir;

    async function send(method, urlPath, body) {
      const res = await fetch(base + urlPath, {
        method,
        headers: { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      if (!res.ok) assert.fail(`${method} ${urlPath}: ${res.status} ${await res.text()}`);
      return res.json();
    }

    before(async () => {
      root = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-mcp-ln-'));
      port = await freePort();
      base = `http://127.0.0.1:${port}`;
      // The app keeps its files in DATA_DIR itself; seed what its own test harness seeds.
      dataDir = path.join(root, 'lists-and-notes');
      fs.mkdirSync(path.join(dataDir, 'notes'), { recursive: true });
      fs.mkdirSync(path.join(dataDir, '.trash'), { recursive: true });
      fs.mkdirSync(path.join(dataDir, '.versions'), { recursive: true });
      fs.writeFileSync(path.join(dataDir, 'lists.json'), '[]');
      fs.writeFileSync(path.join(dataDir, 'notes.json'), '[]');
      fs.writeFileSync(path.join(dataDir, 'settings.json'), '{}');
      fs.writeFileSync(path.join(dataDir, 'categories.json'), JSON.stringify(['personal', 'work']));
      fs.writeFileSync(path.join(dataDir, 'ai-config.json'), '{}');
      fs.writeFileSync(path.join(dataDir, '.trash', 'trash.json'), '[]');
      app = spawn(process.execPath, [path.join(LISTS_AND_NOTES, 'server.js')], {
        cwd: LISTS_AND_NOTES,
        env: { ...process.env, PORT: String(port), DATA_DIR: dataDir, NODE_ENV: 'test' },
        stdio: 'ignore',
      });
      await waitFor(`${base}/api/health`);
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

    it('exposes read-only Lists & Notes tools', async () => {
      const { tools } = await client.listTools();
      for (const n of ['lists_and_notes_lists', 'lists_and_notes_notes', 'lists_and_notes_note']) {
        const t = tools.find((x) => x.name === n);
        assert.ok(t, n);
        assert.equal(t.annotations?.readOnlyHint, true, `${n} is read-only`);
      }
    });

    it('reads lists and notes once access is on', async () => {
      const off = parse(await client.callTool({ name: 'lists_and_notes_lists', arguments: {} }));
      assert.equal(off.available, false);
      const settings = await send('GET', '/api/data/settings');
      await send('POST', '/api/data/settings', { ...settings, assistantAccess: true });
      const now = new Date().toISOString();
      await send('POST', '/api/data/lists', [
        {
          id: 'l1',
          name: 'Camping trip',
          category: 'personal',
          priority: 'medium',
          favorite: false,
          tags: ['travel'],
          items: [
            { id: 'i1', text: 'Tent', completed: true, notes: '', addedDate: now, source: 'user' },
            {
              id: 'i2',
              text: 'Torch',
              completed: false,
              notes: 'check batteries',
              addedDate: now,
              source: 'user',
            },
          ],
          metadata: { created: now, modified: now, itemCount: 2, completedCount: 1 },
        },
      ]);
      const note = await send('POST', '/api/data/notes', {
        title: 'Trip ideas',
        category: 'personal',
        tags: ['travel'],
      });
      await send('PUT', `/api/data/notes/${note.id}`, {
        ...note,
        content: '# Trip ideas\n\nVisit the lake at dawn.',
      });

      const lists = parse(await client.callTool({ name: 'lists_and_notes_lists', arguments: {} }));
      assert.equal(lists.count, 1);
      assert.equal(lists.lists[0].items, 2);
      assert.equal(lists.lists[0].done, 1);
      const one = parse(
        await client.callTool({
          name: 'lists_and_notes_lists',
          arguments: { name: 'camping trip' },
        }),
      );
      assert.equal(one.found, true);
      assert.equal(one.list.items[1].text, 'Torch');
      assert.equal(one.list.items[1].done, false);

      const notes = parse(
        await client.callTool({ name: 'lists_and_notes_notes', arguments: { search: 'lake' } }),
      );
      assert.equal(notes.count, 1, JSON.stringify(notes));
      const full = parse(
        await client.callTool({ name: 'lists_and_notes_note', arguments: { title: 'trip ideas' } }),
      );
      assert.equal(full.found, true);
      assert.match(full.note.content, /lake at dawn/);
      const miss = parse(
        await client.callTool({ name: 'lists_and_notes_note', arguments: { title: 'Trip plan' } }),
      );
      assert.equal(miss.found, false);
      assert.deepEqual(miss.titles, ['Trip ideas']);
    });
  },
);
