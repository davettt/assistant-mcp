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
        'client_manager_update_task',
        'client_manager_update_reminder',
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

    it('moves a task to today, marks it done, and completes a reminder', async () => {
      const tasks = parse(await client.callTool({ name: 'client_manager_tasks', arguments: {} }));
      const taskId = tasks.tasks[0].id;
      const today = key(new Date());
      const moved = parse(
        await client.callTool({
          name: 'client_manager_update_task',
          arguments: { taskId, dueDate: today },
        }),
      );
      assert.equal(moved.changed, true);
      assert.equal(moved.task.dueDate, today);
      assert.equal(moved.task.daysUntilDue, 0);
      const done = parse(
        await client.callTool({
          name: 'client_manager_update_task',
          arguments: { taskId, status: 'done' },
        }),
      );
      assert.equal(done.task.status, 'done');
      const open = parse(await client.callTool({ name: 'client_manager_tasks', arguments: {} }));
      assert.equal(open.count, 0, 'a done task leaves the open list');
      const nothing = parse(
        await client.callTool({ name: 'client_manager_update_task', arguments: { taskId } }),
      );
      assert.equal(nothing.changed, false);

      const reminders = parse(
        await client.callTool({ name: 'client_manager_reminders', arguments: {} }),
      );
      const reminderId = reminders.reminders[0].id;
      const completed = parse(
        await client.callTool({
          name: 'client_manager_update_reminder',
          arguments: { reminderId, status: 'completed' },
        }),
      );
      assert.equal(completed.changed, true);
      assert.equal(completed.reminder.status, 'completed');
      const left = parse(
        await client.callTool({ name: 'client_manager_reminders', arguments: {} }),
      );
      assert.equal(left.count, 0, 'a completed reminder leaves the list');
    });

    it('adds a client and a job, and updates the job', async () => {
      const dup = parse(
        await client.callTool({
          name: 'client_manager_add_client',
          arguments: { name: 'jane smith' },
        }),
      );
      assert.equal(dup.added, false);
      const sam = parse(
        await client.callTool({
          name: 'client_manager_add_client',
          arguments: { name: 'Sam Lee', email: 'sam@example.com', company: 'Lee & Co' },
        }),
      );
      assert.equal(sam.added, true);
      const job = parse(
        await client.callTool({
          name: 'client_manager_add_job',
          arguments: { client: 'sam lee', title: 'Logo refresh', amount: 800 },
        }),
      );
      assert.equal(job.added, true);
      assert.equal(job.job.client, 'Sam Lee');
      const upd = parse(
        await client.callTool({
          name: 'client_manager_update_job',
          arguments: { jobId: job.job.id, status: 'on-hold' },
        }),
      );
      assert.equal(upd.job.status, 'on-hold');
      const who = parse(
        await client.callTool({ name: 'client_manager_client', arguments: { name: 'Sam Lee' } }),
      );
      assert.equal(who.jobs[0].status, 'on-hold');
    });

    it('adds a reminder, a task and an activity by names, listing options on a miss', async () => {
      const miss = parse(
        await client.callTool({
          name: 'client_manager_add_reminder',
          arguments: { client: 'Nobody', title: 'x', dueDate: '2027-01-01' },
        }),
      );
      assert.equal(miss.added, false);
      assert.ok(miss.clients.includes('Jane Smith'));
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

    it('records an outside invoice against a renewal period and reads it back', async () => {
      const andre = await post('/api/clients', { name: 'Andre' });
      await post('/api/jobs', {
        clientId: andre.id,
        title: 'example.com.au domain',
        description: 'Domain renewal, 10% discount',
        status: 'active',
        amount: 52,
        recurrence: '2-yearly',
        billingTiming: 'advance',
        startDate: '2026-11-26',
      });
      const call = async (name, args) => parse(await client.callTool({ name, arguments: args }));

      const before = await call('client_manager_client', { name: 'andre' });
      const job = before.jobs[0];
      assert.equal(job.description, 'Domain renewal, 10% discount');
      assert.equal(job.recurrence, '2-yearly');
      assert.equal(job.billing, 'in advance');
      assert.deepEqual(job.currentPeriod, { start: '2026-11-26', end: '2028-11-26' });
      assert.equal(job.nextRenewal, '2028-11-26');

      const badPeriod = await call('client_manager_add_invoice', {
        client: 'Andre',
        number: '000044',
        total: 52,
        job: 'example.com.au domain',
        periodStart: '2026-12-01',
      });
      assert.equal(badPeriod.added, false);
      assert.deepEqual(badPeriod.periods[0], { start: '2026-11-26', end: '2028-11-26' });

      const today = key(new Date());
      const added = await call('client_manager_add_invoice', {
        client: 'Andre',
        number: '000044',
        total: 52,
        job: 'EXAMPLE.COM.AU DOMAIN',
        periodStart: '2026-11-26',
        paidOn: today,
        paymentMethod: 'Square',
        link: 'https://squareup.com/invoices/000044',
      });
      assert.equal(added.added, true, JSON.stringify(added));
      assert.equal(added.invoice.number, '000044');
      assert.equal(added.invoice.source, 'external');
      assert.equal(added.invoice.total, 52);
      assert.equal(added.invoice.status, 'paid');
      assert.deepEqual(added.invoice.jobs[0].period, { start: '2026-11-26', end: '2028-11-26' });

      const again = await call('client_manager_add_invoice', {
        client: 'Andre',
        number: '000044',
        total: 52,
      });
      assert.equal(again.added, false, 'the same number is not recorded twice');

      const after = await call('client_manager_client', { name: 'Andre' });
      assert.deepEqual(after.jobs[0].invoices, [
        {
          number: '000044',
          status: 'paid',
          total: 52,
          balance: 0,
          period: { start: '2026-11-26', end: '2028-11-26' },
        },
      ]);
      const listed = await call('client_manager_invoices', { status: 'paid', client: 'andre' });
      assert.equal(listed.invoices[0].jobs[0].title, 'example.com.au domain');
    });

    it('says which server and app versions are connected', async () => {
      const info = parse(await client.callTool({ name: 'assistant_info', arguments: {} }));
      const { version } = JSON.parse(
        fs.readFileSync(path.join(here, '..', 'package.json'), 'utf8'),
      );
      assert.equal(info.server.version, version);
      const cm = info.apps.find((a) => a.app === 'Client Manager');
      assert.equal(cm.available, true);
      assert.ok(cm.tools.includes('client_manager_add_invoice'));
    });
  },
);
