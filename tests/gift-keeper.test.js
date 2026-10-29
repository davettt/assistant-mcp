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
          // The packaged app reports its version; the bare server needs it passed in.
          APP_VERSION: JSON.parse(fs.readFileSync(path.join(GIFT_KEEPER, 'package.json'), 'utf8'))
            .version,
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
        recurrence: 'annual',
        personIds: [bob.id],
        budget: 50,
        startYear: soon.getFullYear() - 30,
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
      assert.equal(up.occasions[0].years, 30);
      assert.equal(up.occasions[0].milestone, true);
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
      const stored = (await (await fetch(`${base}/api/occasions`)).json()).find(
        (o) => o.id === occ.occasion.id,
      );
      assert.equal(stored.recurrence, 'annual', 'the app only repeats annual occasions');
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

    it('adds start years, and shows milestones further ahead than other occasions', async () => {
      const ahead = new Date();
      ahead.setDate(ahead.getDate() + 150);
      const aheadKey = `${ahead.getFullYear()}-${String(ahead.getMonth() + 1).padStart(2, '0')}-${String(ahead.getDate()).padStart(2, '0')}`;
      const fiftieth = parse(
        await client.callTool({
          name: 'gift_keeper_add_occasion',
          arguments: {
            name: "Alice's birthday",
            date: aheadKey,
            people: ['Alice'],
            type: 'Birthday',
            startYear: ahead.getFullYear() - 50,
          },
        }),
      );
      assert.equal(fiftieth.added, true, JSON.stringify(fiftieth));
      assert.equal(fiftieth.occasion.startYear, ahead.getFullYear() - 50);
      const plain = parse(
        await client.callTool({
          name: 'gift_keeper_add_occasion',
          arguments: {
            name: 'Anniversary',
            date: aheadKey,
            people: ['Alice'],
            type: 'anniversary',
            startYear: ahead.getFullYear() - 7,
          },
        }),
      );
      assert.equal(plain.added, true, JSON.stringify(plain));
      const oneOff = parse(
        await client.callTool({
          name: 'gift_keeper_add_occasion',
          arguments: {
            name: 'Graduation',
            date: aheadKey,
            people: ['Alice'],
            repeats: 'one-off',
            type: 'birthday',
            startYear: 2000,
          },
        }),
      );
      assert.equal(oneOff.added, false);
      const up = parse(await client.callTool({ name: 'gift_keeper_upcoming', arguments: {} }));
      const alices = up.occasions.find((o) => o.name === "Alice's birthday");
      assert.ok(alices, 'a milestone shows past the usual 90 days');
      assert.equal(alices.years, 50);
      assert.equal(alices.milestone, true);
      assert.ok(
        !up.occasions.some((o) => o.name === 'Anniversary'),
        'an ordinary occasion 150 days out stays hidden',
      );
    });

    it('changes an idea: renames, reassigns, unassigns and clears fields', async () => {
      const [first] = parse(
        await client.callTool({ name: 'gift_keeper_ideas', arguments: {} }),
      ).ideas;
      const moved = parse(
        await client.callTool({
          name: 'gift_keeper_update_idea',
          arguments: {
            ideaId: first.id,
            idea: 'Burr grinder',
            person: 'alice',
            price: 120,
            notes: 'Ask about colours',
          },
        }),
      );
      assert.equal(moved.changed, true, JSON.stringify(moved));
      assert.equal(moved.idea.name, 'Burr grinder');
      assert.equal(moved.idea.person, 'Alice');
      assert.equal(moved.idea.price, 120);
      const cleared = parse(
        await client.callTool({
          name: 'gift_keeper_update_idea',
          arguments: { ideaId: first.id, person: null, price: null, notes: null },
        }),
      );
      assert.equal(cleared.idea.person, null);
      assert.equal(cleared.idea.price, null);
      assert.equal(cleared.idea.notes, undefined);
      const stored = (await (await fetch(`${base}/api/ideas`)).json()).find(
        (i) => i.id === first.id,
      );
      assert.ok(!('personId' in stored) && !('price' in stored), JSON.stringify(stored));
      const miss = parse(
        await client.callTool({
          name: 'gift_keeper_update_idea',
          arguments: { ideaId: first.id, person: 'Zed' },
        }),
      );
      assert.equal(miss.changed, false);
      assert.ok(miss.people.includes('Bob'));
      const nothing = parse(
        await client.callTool({ name: 'gift_keeper_update_idea', arguments: { ideaId: first.id } }),
      );
      assert.equal(nothing.changed, false);
    });

    it('promotes an idea to a tracked gift for an occasion', async () => {
      const people = await (await fetch(`${base}/api/people`)).json();
      const alice = people.find((p) => p.name === 'Alice');
      await post('/api/occasions', {
        name: 'Housewarming',
        date: '2026-12-05',
        personIds: [alice.id],
      });
      const idea = await post('/api/ideas', { name: 'Olive tree' });
      const call = (args) =>
        client
          .callTool({ name: 'gift_keeper_promote_idea', arguments: { ideaId: idea.id, ...args } })
          .then(parse);
      const noOccasion = await call({ occasion: 'House party' });
      assert.equal(noOccasion.promoted, false);
      assert.ok(noOccasion.occasions.some((o) => o.name === 'Housewarming'));
      const noPerson = await call({ occasion: 'housewarming' });
      assert.equal(noPerson.promoted, false, 'an unassigned idea needs a person');
      const out = await call({ occasion: 'housewarming', person: 'alice' });
      assert.equal(out.promoted, true);
      assert.equal(out.gift.occasion, 'Housewarming');
      assert.equal(out.gift.person, 'Alice');
      assert.equal(out.gift.status, 'idea');
      assert.equal(out.note, undefined);
      const again = await call({ occasion: 'Housewarming', person: 'Alice' });
      assert.equal(again.promoted, false, 'an idea is promoted once');
      const ideas = parse(
        await client.callTool({ name: 'gift_keeper_ideas', arguments: { search: 'olive' } }),
      );
      assert.equal(ideas.ideas[0].promoted, true);
      const gifts = parse(
        await client.callTool({ name: 'gift_keeper_gifts', arguments: { person: 'Alice' } }),
      );
      assert.ok(gifts.gifts.some((g) => g.name === 'Olive tree' && g.occasion === 'Housewarming'));
    });

    it('adds a store and sets it on ideas, promoted gifts and gifts', async () => {
      const tool = (name, args) => client.callTool({ name, arguments: args }).then(parse);
      assert.equal((await tool('gift_keeper_add_store', { name: 'TK Maxx' })).added, true);
      const dup = await tool('gift_keeper_add_store', { name: 'tk maxx' });
      assert.equal(dup.added, false, 'store names are matched ignoring case');
      const miss = await tool('gift_keeper_add_idea', {
        idea: 'Throw rug',
        person: 'Alice',
        store: 'Nowhere',
      });
      assert.equal(miss.added, false);
      assert.ok(miss.stores.includes('TK Maxx'));
      const added = await tool('gift_keeper_add_idea', {
        idea: 'Throw rug',
        person: 'Alice',
        store: 'tk maxx',
      });
      assert.equal(added.idea.store, 'TK Maxx');
      const listed = await tool('gift_keeper_ideas', { search: 'rug' });
      assert.equal(listed.ideas[0].store, 'TK Maxx');
      const cleared = await tool('gift_keeper_update_idea', { ideaId: added.idea.id, store: null });
      assert.equal(cleared.idea.store, undefined);
      const stored = (await (await fetch(`${base}/api/ideas`)).json()).find(
        (i) => i.id === added.idea.id,
      );
      assert.ok(!('storeId' in stored), 'null clears the store');
      await tool('gift_keeper_update_idea', { ideaId: added.idea.id, store: 'TK Maxx' });
      const promoted = await tool('gift_keeper_promote_idea', {
        ideaId: added.idea.id,
        occasion: 'Housewarming',
      });
      assert.equal(promoted.gift.store, 'TK Maxx', "the gift takes the idea's store");
      const olive = (await tool('gift_keeper_gifts', { person: 'Alice' })).gifts.find(
        (g) => g.name === 'Olive tree',
      );
      assert.equal(olive.store, undefined);
      const set = await tool('gift_keeper_update_gift', { giftId: olive.id, store: 'TK Maxx' });
      assert.equal(set.gift.store, 'TK Maxx');
      const after = (await tool('gift_keeper_gifts', { person: 'Alice' })).gifts.find(
        (g) => g.id === olive.id,
      );
      assert.equal(after.store, 'TK Maxx');
      const unset = await tool('gift_keeper_update_gift', { giftId: olive.id, store: null });
      assert.equal(unset.gift.store, null);
    });
  },
);
