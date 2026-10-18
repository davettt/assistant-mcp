// End to end: a real Client Manager server (../client-manager) with a temp data folder, assistant
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
const CLIENT_MANAGER = path.join(here, '..', '..', 'client-manager');
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

async function waitFor(url, attempts = 50) {
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

const skip = !fs.existsSync(path.join(CLIENT_MANAGER, 'server', 'index.js'));

describe(
  'Client Manager through the MCP server',
  { skip: skip && 'client-manager checkout not found' },
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

    function key(d) {
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    }

    before(async () => {
      root = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-mcp-cm-'));
      port = await freePort();
      base = `http://127.0.0.1:${port}`;
      // Client Manager keeps its files in DATA_DIR itself (no local_data folder).
      app = spawn(process.execPath, [path.join(CLIENT_MANAGER, 'tests', 'test-server.js')], {
        env: {
          ...process.env,
          PORT: String(port),
          DATA_DIR: path.join(root, 'client-manager'),
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

    it('exposes the Client Manager tools', async () => {
      const { tools } = await client.listTools();
      const names = tools.map((t) => t.name);
      for (const n of [
        'client_manager_reminders',
        'client_manager_tasks',
        'client_manager_invoices',
        'client_manager_client',
        'client_manager_add_reminder',
        'client_manager_add_task',
        'client_manager_log_activity',
      ]) {
        assert.ok(names.includes(n), n);
      }
    });

    it('reads reminders, tasks and invoices once access is on', async () => {
      const off = parse(await client.callTool({ name: 'client_manager_reminders', arguments: {} }));
      assert.equal(off.available, false);
      await fetch(`${base}/api/settings`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ assistantAccess: true }),
      });
      const jane = await post('/api/clients', { name: 'Jane Smith', email: 'jane@example.com' });
      const job = await post('/api/jobs', {
        clientId: jane.id,
        title: 'Website redesign',
        status: 'active',
        amount: 4000,
      });
      const soon = new Date();
      soon.setDate(soon.getDate() + 3);
      await post('/api/reminders', {
        clientId: jane.id,
        title: 'Send the proposal',
        dueDate: key(soon),
        priority: 'high',
      });
      await post('/api/tasks', { jobId: job.id, title: 'Draft the homepage', dueDate: key(soon) });
      const due = new Date();
      due.setDate(due.getDate() - 5);
      await post('/api/invoices', {
        clientId: jane.id,
        jobIds: [job.id],
        docType: 'invoice',
        source: 'external',
        externalTotal: 1500,
        issueDate: key(new Date(Date.now() - 20 * 86400000)),
        dueDate: key(due),
      });

      const reminders = parse(
        await client.callTool({ name: 'client_manager_reminders', arguments: { withinDays: 7 } }),
      );
      assert.equal(reminders.count, 1);
      assert.equal(reminders.reminders[0].client, 'Jane Smith');
      assert.equal(reminders.reminders[0].daysUntilDue, 3);

      const tasks = parse(
        await client.callTool({
          name: 'client_manager_tasks',
          arguments: { client: 'jane smith' },
        }),
      );
      assert.equal(tasks.count, 1);
      assert.equal(tasks.tasks[0].job, 'Website redesign');

      const invoices = parse(
        await client.callTool({ name: 'client_manager_invoices', arguments: {} }),
      );
      assert.equal(invoices.count, 1);
      assert.equal(invoices.invoices[0].status, 'overdue');
      assert.equal(invoices.invoices[0].total, 1500);
      assert.equal(invoices.invoices[0].balance, 1500);
      assert.equal(invoices.totalOwing, 1500);

      const who = parse(
        await client.callTool({ name: 'client_manager_client', arguments: { name: 'Jane Smith' } }),
      );
      assert.equal(who.client.email, 'jane@example.com');
      assert.equal(who.jobs[0].title, 'Website redesign');
      assert.equal(who.reminders.length, 1);

      const on = parse(await client.callTool({ name: 'whats_on', arguments: { days: 7 } }));
      const cm = on.items.filter((i) => i.app === 'Client Manager');
      assert.equal(cm.length, 3, JSON.stringify(cm));
      assert.ok(cm.some((i) => i.title.startsWith('Invoice') && i.daysUntilDue === -5));
    });

    it('adds a reminder, a task and an activity by names, listing options on a miss', async () => {
      const miss = parse(
        await client.callTool({
          name: 'client_manager_add_reminder',
          arguments: { client: 'Nobody', title: 'x', dueDate: '2027-01-01' },
        }),
      );
      assert.equal(miss.added, false);
      assert.deepEqual(miss.clients, ['Jane Smith']);
      const rem = parse(
        await client.callTool({
          name: 'client_manager_add_reminder',
          arguments: {
            client: 'jane smith',
            title: 'Follow up on the quote',
            dueDate: '2027-01-15',
            priority: 'high',
          },
        }),
      );
      assert.equal(rem.added, true);
      assert.equal(rem.reminder.client, 'Jane Smith');

      const noJob = parse(
        await client.callTool({
          name: 'client_manager_add_task',
          arguments: { client: 'Jane Smith', job: 'Nope', title: 'x' },
        }),
      );
      assert.equal(noJob.added, false);
      assert.equal(noJob.jobs[0].title, 'Website redesign');
      const task = parse(
        await client.callTool({
          name: 'client_manager_add_task',
          arguments: {
            client: 'Jane Smith',
            job: 'website redesign',
            title: 'Collect the brand assets',
            dueDate: '2027-01-10',
          },
        }),
      );
      assert.equal(task.added, true);
      assert.equal(task.task.job, 'Website redesign');

      const badType = parse(
        await client.callTool({
          name: 'client_manager_log_activity',
          arguments: { client: 'Jane Smith', type: 'telepathy', title: 'x' },
        }),
      );
      assert.equal(badType.added, false);
      assert.ok(badType.types.length > 0);
      const type = badType.types[0];
      const act = parse(
        await client.callTool({
          name: 'client_manager_log_activity',
          arguments: {
            client: 'Jane Smith',
            type: String(type).toUpperCase(),
            title: 'Kick-off call',
            description: 'Agreed scope',
          },
        }),
      );
      assert.equal(act.added, true, JSON.stringify(act));
      assert.equal(act.activity.client, 'Jane Smith');
      const activities = await (await fetch(`${base}/api/activities`)).json();
      assert.equal(activities.length, 1);
    });
  },
);
