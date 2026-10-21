// End to end: a real DiagramSnap server (../flowsketch) with a temp data folder, assistant
// access turned on through its API, then this MCP server driven over stdio by the SDK client.
// There is no window in the test, so the test plays the window's part where previews are
// concerned: it sends a PNG to the window-only render route, as the window does after it
// draws an assistant's change.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const DIAGRAMSNAP = path.join(here, '..', '..', 'flowsketch');
const SERVER = path.join(here, '..', 'src', 'index.js');
// A 1×1 PNG, standing in for the window's drawing.
const PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

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

const flow = {
  nodes: [
    { id: 'start', type: 'ellipse', label: 'Start', x: 0, y: 0, width: 160, height: 80 },
    { id: 'check', type: 'diamond', label: 'Paid?', x: 0, y: 160, width: 180, height: 120 },
  ],
  edges: [{ id: 'e1', from: 'start', to: 'check' }],
};

const skip = !fs.existsSync(path.join(DIAGRAMSNAP, 'server', 'assistantEdits.js'));

describe(
  'DiagramSnap through the MCP server',
  { skip: skip && 'flowsketch checkout (DiagramSnap 0.7.0 or later) not found' },
  () => {
    let root, app, client, base;
    const raw = (name, args = {}) => client.callTool({ name, arguments: args });
    const call = async (name, args = {}) => parse(await raw(name, args));

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
      root = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-mcp-ds-'));
      const port = await freePort();
      base = `http://127.0.0.1:${port}`;
      const dataDir = path.join(root, 'DiagramSnap');
      fs.mkdirSync(dataDir, { recursive: true });
      // With DATA_DIR set the server waits to be started, as Electron starts it.
      const entry = pathToFileURL(path.join(DIAGRAMSNAP, 'server', 'index.js')).href;
      app = spawn(
        process.execPath,
        [
          '--input-type=module',
          '-e',
          `const m = await import(${JSON.stringify(entry)}); m.startServer(${port});`,
        ],
        {
          cwd: DIAGRAMSNAP,
          env: { ...process.env, DATA_DIR: dataDir, NODE_ENV: 'test' },
          stdio: 'ignore',
        },
      );
      await waitFor(`${base}/api/health`);
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
      app?.kill();
      fs.rmSync(root, { recursive: true, force: true });
    });

    it('exposes read-only and write tools with the right hints', async () => {
      const { tools } = await client.listTools();
      const hint = (n) => tools.find((t) => t.name === n)?.annotations?.readOnlyHint;
      for (const n of ['diagramsnap_list', 'diagramsnap_diagram', 'diagramsnap_deck']) {
        assert.equal(hint(n), true, `${n} is read-only`);
      }
      for (const n of [
        'diagramsnap_create_diagram',
        'diagramsnap_update_diagram',
        'diagramsnap_create_deck',
        'diagramsnap_add_slide',
        'diagramsnap_update_slide',
      ]) {
        assert.equal(hint(n), false, `${n} writes`);
      }
    });

    it('creates, shows and changes a diagram', async () => {
      const off = await call('diagramsnap_list');
      assert.equal(off.available, false);
      await send('PUT', '/api/settings', { assistantAccess: true });

      const created = await call('diagramsnap_create_diagram', {
        name: 'Invoice flow',
        diagramData: flow,
        image: false,
      });
      assert.equal(created.created, true, JSON.stringify(created));

      // Before the window has drawn it: the data, and a note instead of a picture.
      const early = await raw('diagramsnap_diagram', { diagram: 'invoice flow' });
      const earlyBody = parse(early);
      assert.equal(earlyBody.diagramData.nodes.length, 2);
      assert.ok(earlyBody.imageNote);
      assert.equal(early.content.length, 1);

      // The window draws it.
      await send('PUT', `/api/diagrams/${created.id}/render`, {
        sourceUpdatedAt: earlyBody.updatedAt,
        image: PNG,
      });
      const shown = await raw('diagramsnap_diagram', { diagram: 'Invoice flow' });
      const image = shown.content.find((c) => c.type === 'image');
      assert.ok(image, 'the picture comes back as image content');
      assert.equal(image.mimeType, 'image/png');
      assert.equal(image.data, PNG);

      const list = await call('diagramsnap_list', { search: 'invoice' });
      assert.deepEqual(
        list.diagrams.map((d) => [d.name, d.shapes]),
        [['Invoice flow', 2]],
      );

      // A drawing change needs the stamp it was read at.
      const unread = await call('diagramsnap_update_diagram', {
        diagram: 'Invoice flow',
        diagramData: flow,
      });
      assert.equal(unread.changed, false);

      const more = {
        ...flow,
        nodes: [
          ...flow.nodes,
          { id: 'send', type: 'rectangle', label: 'Send', x: 0, y: 340, width: 160, height: 80 },
        ],
        edges: [...flow.edges, { id: 'e2', from: 'check', to: 'send', label: 'No' }],
      };
      const changed = await call('diagramsnap_update_diagram', {
        diagram: 'Invoice flow',
        baseModified: earlyBody.updatedAt,
        diagramData: more,
        image: false,
      });
      assert.equal(changed.changed, true, JSON.stringify(changed));

      // A second change from the same, now old, read is refused, not retried.
      const stale = await call('diagramsnap_update_diagram', {
        diagram: 'Invoice flow',
        baseModified: earlyBody.updatedAt,
        diagramData: flow,
        image: false,
      });
      assert.equal(stale.changed, false);
      assert.match(stale.message, /changed since/);
      const after = await call('diagramsnap_diagram', { diagram: 'Invoice flow', image: false });
      assert.equal(after.diagramData.nodes.length, 3);
      assert.equal(after.diagramData.edges[1].label, 'No');

      // Something drawn by hand on the canvas is not dropped without the user's say-so.
      await send('PUT', `/api/diagrams/${created.id}/render`, {
        sourceUpdatedAt: after.updatedAt,
        image: PNG,
        sceneElements: [{ id: 'scribble', type: 'freedraw' }],
      });
      const guarded = await call('diagramsnap_update_diagram', {
        diagram: 'Invoice flow',
        baseModified: after.updatedAt,
        diagramData: flow,
        image: false,
      });
      assert.equal(guarded.changed, false);
      assert.equal(guarded.drawnElements, 1);
      const discarded = await call('diagramsnap_update_diagram', {
        diagram: 'Invoice flow',
        baseModified: after.updatedAt,
        diagramData: flow,
        discardDrawn: true,
        image: false,
      });
      assert.equal(discarded.changed, true, JSON.stringify(discarded));

      const renamed = await call('diagramsnap_update_diagram', {
        diagram: 'Invoice flow',
        name: 'Invoice process',
      });
      assert.equal(renamed.changed, true);
      assert.equal(renamed.name, 'Invoice process');

      // The app refuses a drawing it cannot use.
      const bad = await raw('diagramsnap_create_diagram', {
        name: 'Broken',
        diagramData: { nodes: flow.nodes, edges: [{ id: 'x', from: 'start', to: 'nowhere' }] },
        image: false,
      });
      assert.equal(bad.isError, true);
    });

    it('creates a deck, adds and changes slides', async () => {
      const deck = await call('diagramsnap_create_deck', {
        name: 'Q4 plan',
        slides: [
          { title: 'Goals', notes: 'Three goals' },
          { title: 'Process', diagramData: flow },
        ],
        images: false,
      });
      assert.equal(deck.created, true, JSON.stringify(deck));
      assert.equal(deck.slides, 2);

      const added = await call('diagramsnap_add_slide', {
        deck: 'Q4 plan',
        title: 'Agenda',
        position: 1,
        image: false,
      });
      assert.equal(added.added, true, JSON.stringify(added));
      assert.equal(added.number, 1);

      const overview = await call('diagramsnap_deck', { deck: 'q4 plan' });
      assert.deepEqual(
        overview.slides.map((s) => s.title),
        ['Agenda', 'Goals', 'Process'],
      );

      const notes = await call('diagramsnap_update_slide', {
        deck: 'Q4 plan',
        slide: 'Goals',
        notes: 'Revenue, retention, release',
        image: false,
      });
      assert.equal(notes.changed, true, JSON.stringify(notes));

      const process = await call('diagramsnap_deck', {
        deck: 'Q4 plan',
        slide: 3,
        images: false,
      });
      assert.equal(process.slide.title, 'Process');
      assert.equal(process.slide.diagramData.nodes.length, 2);
      const redrawn = await call('diagramsnap_update_slide', {
        deck: 'Q4 plan',
        slide: 3,
        baseModified: process.updatedAt,
        diagramData: { nodes: flow.nodes.slice(0, 1) },
        image: false,
      });
      assert.equal(redrawn.changed, true, JSON.stringify(redrawn));

      const missing = await call('diagramsnap_update_slide', {
        deck: 'Q4 plan',
        slide: 9,
        title: 'x',
      });
      assert.equal(missing.changed, false);
      assert.equal(missing.slides.length, 3);

      const whatsOn = await call('whats_on', { days: 7 });
      assert.ok(!whatsOn.unavailable.some((u) => u.app === 'DiagramSnap'));
    });
  },
);
