// End to end: a real Budget Planner server (../budget-planner) with a temp data folder,
// assistant access turned on through its API, then this MCP server driven over stdio by the
// SDK client, the way Claude Desktop drives it.
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
const BUDGET_PLANNER = path.join(here, '..', '..', 'budget-planner');
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

const skip = !fs.existsSync(path.join(BUDGET_PLANNER, 'server', 'figures.js'));

describe(
  'Budget Planner through the MCP server',
  { skip: skip && 'budget-planner checkout (2.2.0 or later) not found' },
  () => {
    let root, app, client, base;
    const call = async (name, args = {}) => parse(await client.callTool({ name, arguments: args }));

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
      root = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-mcp-bp-'));
      const port = await freePort();
      base = `http://127.0.0.1:${port}`;
      const dataDir = path.join(root, 'budget-planner');
      fs.mkdirSync(dataDir, { recursive: true });
      app = spawn(process.execPath, [path.join(BUDGET_PLANNER, 'server', 'index.js')], {
        cwd: BUDGET_PLANNER,
        env: { ...process.env, PORT: String(port), DATA_DIR: dataDir, NODE_ENV: 'test' },
        stdio: 'ignore',
      });
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
      for (const n of [
        'budget_planner_budget',
        'budget_planner_upcoming',
        'budget_planner_expenses',
        'budget_planner_accounts',
        'budget_planner_scenarios',
      ]) {
        assert.equal(hint(n), true, `${n} is read-only`);
      }
      for (const n of [
        'budget_planner_add_expense',
        'budget_planner_update_expense',
        'budget_planner_update_scenario',
        'budget_planner_add_scenario',
        'budget_planner_update_balances',
      ]) {
        assert.equal(hint(n), false, `${n} writes`);
      }
    });

    it('reports access off, then reads and changes the budget', async () => {
      const off = await call('budget_planner_budget');
      assert.equal(off.available, false);
      await send('PUT', '/api/settings', { assistantAccess: true });

      const badCat = await call('budget_planner_add_expense', {
        name: 'Rent',
        amount: 600,
        frequency: 'weekly',
        category: 'Nowhere',
      });
      assert.equal(badCat.added, false);
      assert.ok(badCat.categories.length > 0);
      const cats = await send('GET', '/api/categories');
      const added = await call('budget_planner_add_expense', {
        name: 'Rent',
        amount: 600,
        frequency: 'weekly',
        category: cats[0].name,
        startDate: '2026-01-05',
      });
      assert.equal(added.added, true, JSON.stringify(added));
      const dup = await call('budget_planner_add_expense', {
        name: 'rent',
        amount: 1,
        frequency: 'weekly',
        category: cats[0].name,
      });
      assert.equal(dup.added, false);

      // March 2026 has five Mondays on the weekly cycle from 5 January.
      const march = await call('budget_planner_budget', { period: 'monthly', date: '2026-03-15' });
      assert.equal(march.items.find((i) => i.name === 'Rent').amount, 3000);

      const raised = await call('budget_planner_update_expense', {
        expense: 'Rent',
        amount: 650,
        from: '2026-04-01',
      });
      assert.equal(raised.changed, true, JSON.stringify(raised));
      const april = await call('budget_planner_budget', { period: 'monthly', date: '2026-04-15' });
      const marchAgain = await call('budget_planner_budget', {
        period: 'monthly',
        date: '2026-03-15',
      });
      assert.equal(
        april.items.find((i) => i.name === 'Rent').amount,
        2600,
        'four at the new amount',
      );
      assert.equal(
        marchAgain.items.find((i) => i.name === 'Rent').amount,
        3000,
        'earlier months keep the old amount',
      );

      const list = await call('budget_planner_expenses', { search: 'ren' });
      assert.equal(list.count, 1);
      const missing = await call('budget_planner_update_expense', { expense: 'Gym', amount: 5 });
      assert.equal(missing.changed, false);

      const upcoming = await call('budget_planner_upcoming', { days: 14 });
      const rentDue = upcoming.payments.filter((p) => p.name === 'Rent');
      assert.ok(rentDue.length >= 2, JSON.stringify(upcoming));

      const accounts = await call('budget_planner_accounts');
      assert.equal(typeof accounts.netWorth, 'number');

      const whatsOn = await call('whats_on', { days: 14 });
      assert.ok(JSON.stringify(whatsOn).includes('Rent'), 'payments show in whats_on');
    });

    it('reviews, compares and changes scenarios', async () => {
      await send('POST', '/api/scenarios', {
        name: 'Flat',
        type: 'loan',
        loanDetails: {
          purchasePrice: 650000,
          deposit: 130000,
          interestRate: 6.22,
          termYears: 30,
          repaymentFrequency: 'monthly',
        },
        removedExpenseIds: [],
        removedIncomeIds: [],
        additionalExpenses: [],
      });
      await send('POST', '/api/scenarios', {
        name: 'Stay put',
        type: 'general',
        loanDetails: null,
        removedExpenseIds: [],
        removedIncomeIds: [],
        additionalExpenses: [
          { name: 'Holiday', amount: 3000, frequency: 'annually', categoryId: '' },
        ],
      });
      const listed = await call('budget_planner_scenarios');
      assert.equal(listed.count, 2);
      const compared = await call('budget_planner_scenarios', {
        names: ['flat', 'Stay put'],
        per: 'monthly',
      });
      assert.equal(compared.results.length, 2);
      const flat = compared.results[0];
      assert.equal(flat.loan.principal, 520000);
      assert.ok(Math.abs(flat.loan.repayment - 3191.6) < 1, String(flat.loan.repayment));
      assert.equal(compared.results[1].loan, null);

      const rate = await call('budget_planner_update_scenario', {
        scenario: 'Flat',
        interestRate: 5.89,
      });
      assert.equal(rate.changed, true, JSON.stringify(rate));
      assert.equal(rate.results.loan.interestRate, 5.89);
      assert.ok(rate.results.loan.repayment < flat.loan.repayment, 'a lower rate costs less');
      const noLoan = await call('budget_planner_update_scenario', {
        scenario: 'Stay put',
        interestRate: 5,
      });
      assert.equal(noLoan.changed, false);
      const miss = await call('budget_planner_scenarios', { names: ['Beach house'] });
      assert.equal(miss.found, false);
    });

    it('copies a scenario at a new price and edits its own costs', async () => {
      const cats = await send('GET', '/api/categories');
      const strata = await call('budget_planner_update_scenario', {
        scenario: 'Flat',
        expenses: [
          { name: 'Strata', amount: 1200, frequency: 'quarterly', category: cats[0].name },
          { name: 'Stamp duty', amount: 25000, frequency: 'one-off', category: cats[0].name },
        ],
      });
      assert.equal(strata.changed, true, JSON.stringify(strata));
      assert.equal(strata.costs.length, 2);
      assert.equal(strata.costs[1].category, undefined, 'a one-off cost has no category');

      const copy = await call('budget_planner_add_scenario', {
        name: 'Flat 590k',
        copyFrom: 'flat',
        purchasePrice: 590000,
        expenses: [
          { name: 'strata', amount: 1100 },
          { name: 'Water', amount: 300, frequency: 'quarterly' },
        ],
      });
      assert.equal(copy.added, true, JSON.stringify(copy));
      assert.equal(copy.results.loan.principal, 460000, 'the copied deposit stays');
      assert.equal(copy.results.loan.interestRate, 5.89, 'the copied rate stays');
      const stored = (await send('GET', '/api/scenarios')).find((s) => s.name === 'Flat 590k');
      assert.deepEqual(
        stored.additionalExpenses.map((e) => [e.name, e.amount]),
        [
          ['Strata', 1100],
          ['Stamp duty', 25000],
          ['Water', 300],
        ],
      );
      const original = (await send('GET', '/api/scenarios')).find((s) => s.name === 'Flat');
      assert.equal(original.additionalExpenses[0].amount, 1200, 'the source is unchanged');

      const removed = await call('budget_planner_update_scenario', {
        scenario: 'Flat 590k',
        expenses: [
          { name: 'Stamp duty', remove: true },
          { name: 'Water', rename: 'Water rates' },
        ],
      });
      assert.deepEqual(
        removed.costs.map((c) => c.name),
        ['Strata', 'Water rates'],
      );

      const dup = await call('budget_planner_add_scenario', { name: 'flat', copyFrom: 'Flat' });
      assert.equal(dup.added, false);
      const bare = await call('budget_planner_add_scenario', { name: 'House', purchasePrice: 1e6 });
      assert.equal(bare.added, false);
      assert.match(bare.message, /deposit/);
      const newCost = await call('budget_planner_update_scenario', {
        scenario: 'Flat',
        expenses: [{ name: 'Insurance' }],
      });
      assert.equal(newCost.changed, false, 'a new cost needs an amount and a frequency');
      const general = await call('budget_planner_add_scenario', {
        name: 'Gap year',
        type: 'general',
        expenses: [{ name: 'Travel', amount: 15000, frequency: 'one-off' }],
      });
      assert.equal(general.added, true, JSON.stringify(general));
      assert.equal(general.results.loan, null);
    });

    it('sets balances on Budget Planner 2.3.0, and says what is needed before', async () => {
      const account = await send('POST', '/api/accounts', {
        name: 'Everyday',
        type: 'transaction',
        balance: 1000,
      });
      const { version } = JSON.parse(
        fs.readFileSync(path.join(BUDGET_PLANNER, 'package.json'), 'utf8'),
      );
      const [major, minor] = version.split('.').map(Number);
      const result = await call('budget_planner_update_balances', {
        balances: [{ account: 'everyday', balance: 2345.67 }],
      });
      if (major < 2 || (major === 2 && minor < 3)) {
        assert.equal(result.changed, false);
        assert.match(result.message, /2\.3\.0/);
        return;
      }
      assert.equal(result.changed, true, JSON.stringify(result));
      const stored = (await send('GET', '/api/accounts')).find((a) => a.id === account.id);
      assert.equal(stored.balance, 2345.67);
      const miss = await call('budget_planner_update_balances', {
        balances: [{ account: 'Nowhere', balance: 1 }],
      });
      assert.equal(miss.changed, false);
      assert.ok(miss.accounts.some((a) => a.name === 'Everyday'));
    });
  },
);
