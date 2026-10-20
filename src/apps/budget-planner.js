// Budget Planner: recurring income and expenses, accounts, and what-if scenarios. Needs
// Budget Planner 2.2.0 or later, which gives the assistant its token and the /api/figures
// routes: the period totals, upcoming payments, net worth and scenario results are worked
// out by the app with the same code its window uses, never redone here. Expenses are
// recurring budget items, not a record of spending. The token can add and change expenses
// and scenarios only; there is no delete tool.
import { URLSearchParams } from 'node:url';
import { z } from 'zod';
import { appConnection, apiCall, notAvailable } from '../connection.js';
import { todayLocal as today } from '../dates.js';

export const app = {
  id: 'budget-planner',
  name: 'Budget Planner',
  bundleName: 'Budget Planner',
  dataDir: 'budget-planner',
  // The app keeps its files in the data dir itself, not a local_data folder.
  tokenFile: 'assistant.json',
};

const PERIOD = z.enum(['weekly', 'fortnightly', 'monthly', 'annually']);
const FREQUENCY = z.enum([
  'daily',
  'weekly',
  'fortnightly',
  'monthly',
  'quarterly',
  'six-monthly',
  'annually',
  'one-off',
]);
const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD');

function query(params) {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined) q.set(k, String(v));
  const s = q.toString();
  return s ? `?${s}` : '';
}

function matches(text, q) {
  return typeof text === 'string' && text.toLowerCase().includes(q.toLowerCase());
}

function same(a, b) {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

function summariseExpense(e, categories) {
  const changes = e.amountChanges ?? [];
  const now = today();
  const upcoming = changes.filter((c) => c.from > now);
  const current = changes.filter((c) => c.from <= now).at(-1)?.amount ?? e.amount;
  return {
    id: e.id,
    name: e.name,
    amount: current,
    frequency: e.frequency,
    category: categories.get(e.categoryId) ?? e.categoryId,
    subcategory: e.subcategory || undefined,
    estimate: e.entryMode === 'quick-estimate' || undefined,
    startDate: e.startDate,
    endDate: e.endDate ?? undefined,
    amountChanges: upcoming.length ? upcoming : undefined,
    active: e.active === false ? false : undefined,
  };
}

async function loadExpenses(conn) {
  const [expenses, cats] = await Promise.all([
    apiCall(conn, 'GET', '/api/expenses'),
    apiCall(conn, 'GET', '/api/categories'),
  ]);
  return { expenses, categories: new Map(cats.map((c) => [c.id, c.name])), cats };
}

/** The expense with this name; when several share it, only one still running counts. */
function findExpense(expenses, name) {
  const now = today();
  const named = expenses.filter((e) => same(e.name, name));
  if (named.length <= 1) return named[0];
  const live = named.filter((e) => e.active !== false && (!e.endDate || e.endDate >= now));
  return live.length === 1 ? live[0] : undefined;
}

async function findScenario(conn, name) {
  const scenarios = await apiCall(conn, 'GET', '/api/scenarios');
  return {
    scenario: scenarios.find((s) => same(s.name, name)),
    names: scenarios.map((s) => s.name),
  };
}

export const tools = [
  {
    name: 'budget_planner_budget',
    description:
      "Budget Planner's figures for one period, as its Budget page shows them: income, expenses, the surplus, each category's total and each expense's amount in the period. Weekly, fortnightly, monthly or annually (the financial year), for the period holding a date (default today). These are projected from the recurring budget items, past or future, not recorded spending.",
    input: z.object({
      period: PERIOD.optional().describe("Defaults to the app's display period"),
      date: DATE.optional().describe('Any day in the wanted period; defaults to today'),
      category: z.string().max(100).optional().describe('Only expenses in this category'),
    }),
    async run(input) {
      const conn = await appConnection(app);
      if (!conn.ok) return notAvailable(app, conn);
      const figures = await apiCall(
        conn,
        'GET',
        `/api/figures/period${query({ period: input.period, date: input.date })}`,
      );
      if (input.category) {
        figures.items = figures.items.filter((i) => same(i.category, input.category));
        figures.categories = figures.categories.filter((c) => same(c.name, input.category));
      }
      return { app: app.name, ...figures };
    },
  },
  {
    name: 'budget_planner_upcoming',
    description:
      'Expense payments in Budget Planner falling due from today through the next few days (default 14, up to 92), with the date and amount of each. Estimates (groceries, fuel) have no payment day and are left out.',
    input: z.object({ days: z.number().int().min(1).max(92).default(14) }),
    async run(input) {
      const conn = await appConnection(app);
      if (!conn.ok) return notAvailable(app, conn);
      const upcoming = await apiCall(
        conn,
        'GET',
        `/api/figures/upcoming${query({ days: input.days })}`,
      );
      return { app: app.name, ...upcoming };
    },
  },
  {
    name: 'budget_planner_expenses',
    description:
      'The expenses set up in Budget Planner: each recurring item with its current amount, frequency, category, start and end dates, and any amount changes still to come. Search matches the name. Use budget_planner_budget for totals in a period.',
    input: z.object({
      search: z.string().max(100).optional(),
      category: z.string().max(100).optional(),
      includeEnded: z.boolean().default(false).describe('Also list items that have ended'),
    }),
    async run(input) {
      const conn = await appConnection(app);
      if (!conn.ok) return notAvailable(app, conn);
      const { expenses, categories } = await loadExpenses(conn);
      const now = today();
      let out = expenses.map((e) => summariseExpense(e, categories));
      if (!input.includeEnded) {
        out = out.filter((e) => e.active !== false && (!e.endDate || e.endDate >= now));
      }
      if (input.category) out = out.filter((e) => same(e.category, input.category));
      if (input.search) out = out.filter((e) => matches(e.name, input.search));
      out.sort((a, b) => a.category.localeCompare(b.category) || a.name.localeCompare(b.name));
      return { app: app.name, count: out.length, expenses: out };
    },
  },
  {
    name: 'budget_planner_accounts',
    description:
      'Open accounts in Budget Planner with their balances, and net worth (assets less what is owed).',
    input: z.object({}),
    async run() {
      const conn = await appConnection(app);
      if (!conn.ok) return notAvailable(app, conn);
      return { app: app.name, ...(await apiCall(conn, 'GET', '/api/figures/accounts')) };
    },
  },
  {
    name: 'budget_planner_scenarios',
    description:
      "Scenarios in Budget Planner (what-ifs such as buying a property). With no name, lists them. With one or more names, gives each one's results as the Affordability page works them out: the loan repayment, total interest and loan-to-value, the surplus before and after, the cash check against the accounts, when it becomes affordable, and the net worth change. Give several names to compare them.",
    input: z.object({
      names: z.array(z.string().min(1).max(100)).max(10).optional(),
      per: PERIOD.optional().describe("The period the surplus is stated in; the app's default"),
      includeArchived: z.boolean().default(false),
    }),
    async run(input) {
      const conn = await appConnection(app);
      if (!conn.ok) return notAvailable(app, conn);
      const scenarios = await apiCall(conn, 'GET', '/api/scenarios');
      if (!input.names?.length) {
        const out = scenarios
          .filter((s) => input.includeArchived || !s.archivedAt)
          .map((s) => ({
            id: s.id,
            name: s.name,
            type: s.type,
            archived: s.archivedAt ? true : undefined,
            targetDate: s.targetDate || undefined,
          }));
        return { app: app.name, count: out.length, scenarios: out };
      }
      const missing = input.names.filter((n) => !scenarios.some((s) => same(s.name, n)));
      if (missing.length) {
        return {
          app: app.name,
          found: false,
          message: `No scenario called ${missing.map((m) => `"${m}"`).join(', ')}.`,
          scenarios: scenarios.map((s) => s.name),
        };
      }
      const results = await Promise.all(
        input.names.map((n) => {
          const s = scenarios.find((x) => same(x.name, n));
          return apiCall(
            conn,
            'GET',
            `/api/figures/scenarios/${encodeURIComponent(s.id)}${query({ per: input.per })}`,
          );
        }),
      );
      return { app: app.name, found: true, results };
    },
  },
  {
    name: 'budget_planner_add_expense',
    description:
      'Add a recurring (or one-off) expense to Budget Planner. The category must already exist; if it does not, the reply lists the categories. Set estimate for a spread-out cost with no payment day, such as groceries or fuel.',
    input: z.object({
      name: z.string().trim().min(1).max(100),
      amount: z.number().min(0).max(1e9),
      frequency: FREQUENCY,
      category: z.string().min(1).max(100),
      subcategory: z.string().max(100).optional(),
      startDate: DATE.optional().describe('First payment; defaults to today'),
      endDate: DATE.optional(),
      estimate: z.boolean().default(false),
    }),
    write: true,
    async run(input) {
      const conn = await appConnection(app);
      if (!conn.ok) return notAvailable(app, conn);
      const { expenses, categories, cats } = await loadExpenses(conn);
      const category = cats.find((c) => same(c.name, input.category) || c.id === input.category);
      if (!category) {
        return {
          app: app.name,
          added: false,
          message: `No category called "${input.category}".`,
          categories: cats.map((c) => ({ name: c.name, subcategories: c.subcategories })),
        };
      }
      if (findExpense(expenses, input.name)) {
        return {
          app: app.name,
          added: false,
          message: `There is already an expense called "${input.name}". Change it instead, or use another name.`,
        };
      }
      const startDate = input.startDate ?? today();
      if (input.endDate && input.endDate < startDate) {
        return { app: app.name, added: false, message: 'The end date is before the start date.' };
      }
      const expense = await apiCall(conn, 'POST', '/api/expenses', {
        name: input.name,
        amount: input.amount,
        frequency: input.frequency,
        categoryId: category.id,
        subcategory: input.subcategory ?? '',
        entryMode: input.estimate ? 'quick-estimate' : 'individual',
        startDate,
        endDate: input.endDate ?? null,
      });
      return { app: app.name, added: true, expense: summariseExpense(expense, categories) };
    },
  },
  {
    name: 'budget_planner_update_expense',
    description:
      "Change an expense in Budget Planner, by name. A new amount starts on a date (default today), so earlier months keep the old amount, the way the app's own change-from-a-date works. Also: rename it, move it to another category, or set the date it stops (endDate; null to keep it going). Changing how often it is paid is done in the app.",
    input: z.object({
      expense: z.string().min(1).max(100).describe('The expense as it is named now'),
      amount: z.number().min(0).max(1e9).optional(),
      from: DATE.optional().describe('When the new amount starts; defaults to today'),
      name: z.string().trim().min(1).max(100).optional().describe('New name'),
      category: z.string().min(1).max(100).optional(),
      subcategory: z.string().max(100).optional(),
      endDate: DATE.nullable().optional(),
    }),
    write: true,
    async run(input) {
      const conn = await appConnection(app);
      if (!conn.ok) return notAvailable(app, conn);
      const { expenses, categories, cats } = await loadExpenses(conn);
      const expense = findExpense(expenses, input.expense);
      if (!expense) {
        const near = expenses.filter((e) =>
          input.expense.split(/\s+/).some((w) => w.length > 2 && matches(e.name, w)),
        );
        return {
          app: app.name,
          changed: false,
          message: `No single expense called "${input.expense}".`,
          expenses: (near.length ? near : expenses).slice(0, 30).map((e) => e.name),
        };
      }
      const body = {};
      if (input.amount !== undefined) {
        const from = input.from ?? today();
        if (expense.endDate && from > expense.endDate) {
          return { app: app.name, changed: false, message: `${expense.name} ends before ${from}.` };
        }
        if (from <= expense.startDate) {
          // No payment before the change, so the amount itself is the new one.
          body.amount = input.amount;
        } else {
          const others = (expense.amountChanges ?? []).filter((c) => c.from !== from);
          body.amountChanges = [...others, { from, amount: input.amount }].sort((a, b) =>
            a.from.localeCompare(b.from),
          );
        }
      }
      if (input.name !== undefined) body.name = input.name;
      if (input.category !== undefined) {
        const category = cats.find((c) => same(c.name, input.category) || c.id === input.category);
        if (!category) {
          return {
            app: app.name,
            changed: false,
            message: `No category called "${input.category}".`,
            categories: cats.map((c) => c.name),
          };
        }
        body.categoryId = category.id;
        if (input.subcategory === undefined) body.subcategory = '';
      }
      if (input.subcategory !== undefined) body.subcategory = input.subcategory;
      if (input.endDate !== undefined) {
        if (input.endDate && input.endDate < expense.startDate) {
          return { app: app.name, changed: false, message: 'The end date is before it starts.' };
        }
        body.endDate = input.endDate;
      }
      if (Object.keys(body).length === 0) {
        return { app: app.name, changed: false, message: 'Nothing to change.' };
      }
      const updated = await apiCall(
        conn,
        'PUT',
        `/api/expenses/${encodeURIComponent(expense.id)}`,
        body,
      );
      return { app: app.name, changed: true, expense: summariseExpense(updated, categories) };
    },
  },
  {
    name: 'budget_planner_update_scenario',
    description:
      "Change a scenario in Budget Planner, by name: its loan (interest rate, price, deposit, term, repayment frequency), the date the money is needed by, the amount kept aside, or its name. The reply gives the scenario's results after the change.",
    input: z.object({
      scenario: z.string().min(1).max(100).describe('The scenario as it is named now'),
      interestRate: z.number().min(0).max(30).optional().describe('Yearly, as a percentage'),
      purchasePrice: z.number().min(0).max(1e10).optional(),
      deposit: z.number().min(0).max(1e10).optional(),
      termYears: z.number().int().min(1).max(50).optional(),
      repaymentFrequency: z.enum(['weekly', 'fortnightly', 'monthly']).optional(),
      targetDate: DATE.nullable().optional(),
      keepAside: z.number().min(0).max(1e10).nullable().optional(),
      name: z.string().trim().min(1).max(100).optional(),
    }),
    write: true,
    async run(input) {
      const conn = await appConnection(app);
      if (!conn.ok) return notAvailable(app, conn);
      const { scenario, names } = await findScenario(conn, input.scenario);
      if (!scenario) {
        return {
          app: app.name,
          changed: false,
          message: `No scenario called "${input.scenario}".`,
          scenarios: names,
        };
      }
      const loanKeys = [
        'interestRate',
        'purchasePrice',
        'deposit',
        'termYears',
        'repaymentFrequency',
      ];
      const loanChange = Object.fromEntries(
        loanKeys.filter((k) => input[k] !== undefined).map((k) => [k, input[k]]),
      );
      const body = {};
      if (Object.keys(loanChange).length) {
        if (!scenario.loanDetails) {
          return {
            app: app.name,
            changed: false,
            message: `${scenario.name} has no loan; add one in the app.`,
          };
        }
        body.loanDetails = { ...scenario.loanDetails, ...loanChange };
      }
      if (input.targetDate !== undefined) body.targetDate = input.targetDate;
      if (input.keepAside !== undefined) body.keepAside = input.keepAside;
      if (input.name !== undefined) body.name = input.name;
      if (Object.keys(body).length === 0) {
        return { app: app.name, changed: false, message: 'Nothing to change.' };
      }
      const updated = await apiCall(
        conn,
        'PUT',
        `/api/scenarios/${encodeURIComponent(scenario.id)}`,
        body,
      );
      const results = await apiCall(
        conn,
        'GET',
        `/api/figures/scenarios/${encodeURIComponent(updated.id)}`,
      );
      return { app: app.name, changed: true, results };
    },
  },
];

/** Expense payments due within the window, for "what's on". */
export async function attention(days) {
  const conn = await appConnection(app);
  if (!conn.ok) return { app: app.name, available: false, reason: conn.reason, items: [] };
  const span = Math.min(Math.max(days, 1), 92);
  const upcoming = await apiCall(conn, 'GET', `/api/figures/upcoming${query({ days: span })}`);
  const items = upcoming.payments.map((p) => ({
    app: app.name,
    id: p.id,
    title: p.name,
    date: p.date,
    amount: p.amount,
    currency: upcoming.currency,
  }));
  return { app: app.name, available: true, items };
}
