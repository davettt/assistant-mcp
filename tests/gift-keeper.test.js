// End to end: a real Gift Keeper server (../gift-keeper) with a temp data folder, assistant
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
const GIFT_KEEPER = path.join(here, '..', '..', 'gift-keeper');
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

const skip = !fs.existsSync(path.join(GIFT_KEEPER, 'server', 'index.js'));

describe(
  'Gift Keeper through the MCP server',
  { skip: skip && 'gift-keeper checkout not found' },
  () => {
    let root, app, port, client, transport, base;

    async function post(urlPath, body) {
      const res = await fetch(base + urlPath, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) assert.fail(`${urlPath}: ${res.status} ${await res.text()}`);
      return res.json();
    }

    before(async () => {
      root = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-mcp-gk-'));
      port = await freePort();
      base = `http://127.0.0.1:${port}`;
      app = spawn(process.execPath, [path.join(GIFT_KEEPER, 'server', 'index.js')], {
        env: {
          ...process.env,
          PORT: String(port),
          DATA_DIR: path.join(root, 'gift-keeper'),
          NODE_ENV: 'test',
        },
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

    it('exposes the Gift Keeper tools', async () => {
      const { tools } = await client.listTools();
      const names = tools.map((t) => t.name);
      for (const n of [
        'gift_keeper_upcoming',
        'gift_keeper_people',
        'gift_keeper_add_idea',
        'gift_keeper_mark_gift_given',
      ]) {
        assert.ok(names.includes(n), n);
      }
    });

    it('reports not enabled, then reads people and upcoming occasions once on', async () => {
      const off = parse(await client.callTool({ name: 'gift_keeper_people', arguments: {} }));
      assert.equal(off.available, false);
      await fetch(`${base}/api/settings`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ assistantAccess: true }),
      });
      const bob = await post('/api/people', {
        name: 'Bob',
        relationship: 'Friend',
        interests: ['coffee'],
      });
      const soon = new Date();
      soon.setDate(soon.getDate() + 10);
      const soonKey = `${soon.getFullYear()}-${String(soon.getMonth() + 1).padStart(2, '0')}-${String(soon.getDate()).padStart(2, '0')}`;
      await post('/api/occasions', {
        name: "Bob's birthday",
        type: 'birthday',
        date: soonKey,
        recurrence: 'yearly',
        personIds: [bob.id],
        budget: 50,
      });
      const people = parse(
        await client.callTool({ name: 'gift_keeper_people', arguments: { name: 'bob' } }),
      );
      assert.equal(people.count, 1);
      assert.deepEqual(people.people[0].interests, ['coffee']);
      const up = parse(
        await client.callTool({ name: 'gift_keeper_upcoming', arguments: { withinDays: 30 } }),
      );
      assert.equal(up.count, 1);
      assert.equal(up.occasions[0].people[0], 'Bob');
      assert.equal(up.occasions[0].giftChosen, false);
      assert.equal(up.occasions[0].date, soonKey, 'calendar day must not shift with the timezone');
      assert.equal(up.occasions[0].daysUntil, 10);
      const on = parse(await client.callTool({ name: 'whats_on', arguments: { days: 30 } }));
      assert.ok(on.items.some((i) => i.app === 'Gift Keeper' && i.title.includes('Bob')));
    });

    it('adds an idea by person name and lists people on a miss', async () => {
      const miss = parse(
        await client.callTool({
          name: 'gift_keeper_add_idea',
          arguments: { idea: 'Grinder', person: 'Nobody' },
        }),
      );
      assert.equal(miss.added, false);
      assert.deepEqual(miss.people, ['Bob']);
      const out = parse(
        await client.callTool({
          name: 'gift_keeper_add_idea',
          arguments: { idea: 'Hand grinder', person: 'Bob', price: 80, priority: 'high' },
        }),
      );
      assert.equal(out.added, true);
      assert.equal(out.idea.person, 'Bob');
      const ideas = await (await fetch(`${base}/api/ideas`)).json();
      assert.equal(ideas.length, 1);
      assert.equal(ideas[0].name, 'Hand grinder');
    });

    it('lists the ideas pool and gifts at any stage', async () => {
      const ideas = parse(await client.callTool({ name: 'gift_keeper_ideas', arguments: {} }));
      assert.equal(ideas.count, 1);
      assert.equal(ideas.ideas[0].idea, 'Hand grinder');
      assert.equal(ideas.ideas[0].person, 'Bob');
      const byPerson = parse(
        await client.callTool({ name: 'gift_keeper_ideas', arguments: { person: 'nobody' } }),
      );
      assert.equal(byPerson.count, 0);
      const none = parse(await client.callTool({ name: 'gift_keeper_gifts', arguments: {} }));
      assert.equal(none.count, 0, 'no gifts tracked yet');
    });

    it('marks a gift as given', async () => {
      const up = parse(await client.callTool({ name: 'gift_keeper_upcoming', arguments: {} }));
      const occasionId = up.occasions[0].occasionId;
      const people = await (await fetch(`${base}/api/people`)).json();
      const gift = await post('/api/gifts', {
        name: 'Pour-over kettle',
        personId: people[0].id,
        occasionId,
        status: 'bought',
        price: 60,
      });
      const out = parse(
        await client.callTool({
          name: 'gift_keeper_mark_gift_given',
          arguments: { giftId: gift.id },
        }),
      );
      assert.equal(out.changed, 'given');
      assert.equal(out.gift.status, 'given');
      const open = parse(await client.callTool({ name: 'gift_keeper_gifts', arguments: {} }));
      assert.equal(open.count, 0, 'a given gift is not open');
      const given = parse(
        await client.callTool({
          name: 'gift_keeper_gifts',
          arguments: { status: 'given', person: 'Bob' },
        }),
      );
      assert.equal(given.count, 1);
      assert.equal(given.gifts[0].occasion, "Bob's birthday");
    });

    it('adds a person and an occasion, updates a gift, completes the occasion', async () => {
      const dup = parse(
        await client.callTool({ name: 'gift_keeper_add_person', arguments: { name: 'bob' } }),
      );
      assert.equal(dup.added, false);
      const alice = parse(
        await client.callTool({
          name: 'gift_keeper_add_person',
          arguments: { name: 'Alice', relationship: 'Sister', interests: ['hiking'] },
        }),
      );
      assert.equal(alice.added, true);
      const miss = parse(
        await client.callTool({
          name: 'gift_keeper_add_occasion',
          arguments: { name: 'Christmas', date: '2026-12-25', people: ['Alice', 'Zed'] },
        }),
      );
      assert.equal(miss.added, false);
      const occ = parse(
        await client.callTool({
          name: 'gift_keeper_add_occasion',
          arguments: {
            name: 'Christmas',
            date: '2026-12-25',
            people: ['Alice', 'Bob'],
            budget: 100,
            type: 'christmas',
          },
        }),
      );
      assert.equal(occ.added, true);
      assert.equal(occ.occasion.repeats, 'yearly');
      const up = parse(await client.callTool({ name: 'gift_keeper_upcoming', arguments: {} }));
      const bobs = up.occasions.find((o) => o.name === "Bob's birthday");
      const gift = bobs.gifts[0];
      const upd = parse(
        await client.callTool({
          name: 'gift_keeper_update_gift',
          arguments: { giftId: gift.id, status: 'given', price: 65 },
        }),
      );
      assert.equal(upd.gift.status, 'given');
      assert.equal(upd.gift.price, 65);
      const done = parse(
        await client.callTool({
          name: 'gift_keeper_complete_occasion',
          arguments: { occasionId: bobs.occasionId },
        }),
      );
      assert.equal(done.changed, 'completed');
      const after = parse(await client.callTool({ name: 'gift_keeper_upcoming', arguments: {} }));
      assert.ok(
        !after.occasions.some((o) => o.occasionId === bobs.occasionId),
        'a completed occasion leaves upcoming',
      );
    });
  },
);
