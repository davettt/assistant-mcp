// Due Again: recurring commitments (renewals, maintenance, appointments).
// Talks to the app's local API with the per-launch token it writes while
// "Allow assistant access" is on (due-again/server/assistant.js).
import { z } from 'zod';
import { appConnection, apiCall, notAvailable } from '../connection.js';
import { daysBetween, todayLocal } from '../dates.js';

export const app = {
  id: 'due-again',
  name: 'Due Again',
  bundleName: 'Due Again', // what `open -a` is given
  dataDir: 'due-again',
};

// --- shaping ---

function status(item, today, dueSoonDays) {
  if (item.archived) return 'archived';
  if (!item.nextDue) return item.recurrence?.type === 'once' ? 'done' : 'unscheduled';
  const days = daysBetween(today, item.nextDue);
  if (days < 0) return 'overdue';
  if (days === 0) return 'due-today';
  if (days <= dueSoonDays) return 'due-soon';
  return 'upcoming';
}

function summarise(item, categories, today, dueSoonDays) {
  const days = item.nextDue ? daysBetween(today, item.nextDue) : null;
  return {
    id: item.id,
    title: item.title,
    category: categories.get(item.categoryId) ?? item.categoryId,
    status: status(item, today, dueSoonDays),
    nextDue: item.nextDue,
    daysUntilDue: days,
    recurrence: item.recurrence,
    expectedCost: item.expectedCost,
    currency: item.currency ?? null,
    costVaries: item.costVaries ?? false,
    notes: item.notes || undefined,
  };
}

async function loadContext(conn) {
  const [items, categories, settings] = await Promise.all([
    apiCall(conn, 'GET', '/api/items'),
    apiCall(conn, 'GET', '/api/categories'),
    apiCall(conn, 'GET', '/api/settings'),
  ]);
  return {
    items,
    categories: new Map(categories.map((c) => [c.id, c.name])),
    dueSoonDays: settings.dueSoonDays ?? 14,
    today: todayLocal(),
  };
}

// --- tools ---

export const tools = [
  {
    name: 'due_again_items',
    description:
      'List items in Due Again (recurring commitments such as renewals, insurance, maintenance and appointments) with their status and next due date. Filter by status or look ahead a number of days.',
    input: z.object({
      status: z
        .enum(['overdue', 'due-today', 'due-soon', 'upcoming', 'unscheduled', 'done', 'archived'])
        .optional()
        .describe('Only items with this status'),
      withinDays: z
        .number()
        .int()
        .min(0)
        .max(730)
        .optional()
        .describe('Only items due within this many days (overdue items included)'),
      search: z.string().max(100).optional().describe('Case-insensitive match on the title'),
    }),
    async run(input) {
      const conn = await appConnection(app);
      if (!conn.ok) return notAvailable(app, conn);
      const ctx = await loadContext(conn);
      let list = ctx.items.map((i) => summarise(i, ctx.categories, ctx.today, ctx.dueSoonDays));
      if (input.status) list = list.filter((i) => i.status === input.status);
      else list = list.filter((i) => i.status !== 'archived');
      if (input.withinDays !== undefined) {
        list = list.filter((i) => i.daysUntilDue !== null && i.daysUntilDue <= input.withinDays);
      }
      if (input.search) {
        const q = input.search.toLowerCase();
        list = list.filter((i) => i.title.toLowerCase().includes(q));
      }
      list.sort((a, b) => (a.daysUntilDue ?? Infinity) - (b.daysUntilDue ?? Infinity));
      return { app: app.name, today: ctx.today, count: list.length, items: list };
    },
  },
  {
    name: 'due_again_history',
    description:
      'The completion history of one Due Again item: when it was done, skipped or rescheduled, and what it cost.',
    input: z.object({
      itemId: z.string().min(1),
      limit: z.number().int().min(1).max(100).default(20),
    }),
    async run(input) {
      const conn = await appConnection(app);
      if (!conn.ok) return notAvailable(app, conn);
      const item = await apiCall(conn, 'GET', `/api/items/${encodeURIComponent(input.itemId)}`);
      const history = await apiCall(
        conn,
        'GET',
        `/api/items/${encodeURIComponent(input.itemId)}/occurrences`,
      );
      const live = history.filter((o) => !o.voided && o.outcome !== 'voided');
      return {
        app: app.name,
        item: { id: item.id, title: item.title, nextDue: item.nextDue },
        history: live.slice(-input.limit).reverse(),
      };
    },
  },
  {
    name: 'due_again_complete',
    description:
      'Record that a Due Again item was done. Due Again then works out the next due date from its schedule. Use the item id from due_again_items. Date defaults to today and cannot be in the future.',
    input: z.object({
      itemId: z.string().min(1),
      date: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/)
        .optional()
        .describe('The day it was done, YYYY-MM-DD. Defaults to today.'),
      cost: z.number().min(0).nullable().optional().describe('What it cost, if known'),
      note: z.string().max(500).optional(),
    }),
    write: true,
    async run(input) {
      const conn = await appConnection(app);
      if (!conn.ok) return notAvailable(app, conn);
      const body = {
        date: input.date ?? todayLocal(),
        cost: input.cost ?? null,
        note: input.note ?? '',
      };
      const result = await apiCall(
        conn,
        'POST',
        `/api/items/${encodeURIComponent(input.itemId)}/complete`,
        body,
      );
      return {
        app: app.name,
        changed: 'completed',
        item: { id: result.item.id, title: result.item.title, nextDue: result.item.nextDue },
        occurrence: result.occurrence,
      };
    },
  },
  {
    name: 'due_again_add_item',
    description:
      'Add a new item to Due Again: something that comes due on a date, once or on a schedule (a renewal, a bill, maintenance, an appointment). Give the category by name; if it does not match, the reply lists the categories to choose from. Reminders are days before the due date.',
    input: z.object({
      title: z.string().trim().min(1).max(200),
      category: z.string().min(1).max(50).describe('Category name, e.g. Home, Car, Insurance'),
      nextDue: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/)
        .describe('When it is next due, YYYY-MM-DD'),
      repeat: z
        .enum(['once', 'annual', 'days', 'weeks', 'months', 'years'])
        .default('once')
        .describe('How it repeats; days/weeks/months/years need an interval'),
      interval: z
        .number()
        .int()
        .min(1)
        .max(999)
        .optional()
        .describe('Every N days/weeks/months/years'),
      calculateFrom: z
        .enum(['scheduled', 'completion'])
        .default('scheduled')
        .describe('Whether the next date follows the schedule or the day it was actually done'),
      expectedCost: z.number().min(0).nullable().optional(),
      costVaries: z.boolean().optional().describe('The cost is an estimate that changes each time'),
      reminders: z.array(z.number().int().min(0).max(3650)).max(10).optional(),
      description: z.string().max(2000).optional(),
      notes: z.string().max(10000).optional(),
    }),
    write: true,
    async run(input) {
      const conn = await appConnection(app);
      if (!conn.ok) return notAvailable(app, conn);
      const categories = await apiCall(conn, 'GET', '/api/categories');
      const wanted = input.category.trim().toLowerCase();
      const category = categories.find((c) => c.name.toLowerCase() === wanted);
      if (!category) {
        return {
          app: app.name,
          added: false,
          message: `No category called "${input.category}". Choose one of these and try again.`,
          categories: categories.map((c) => c.name),
        };
      }
      if (['days', 'weeks', 'months', 'years'].includes(input.repeat) && !input.interval) {
        return {
          app: app.name,
          added: false,
          message: `Repeat "${input.repeat}" needs an interval, e.g. every 3 months.`,
        };
      }
      const recurrence =
        input.repeat === 'once' || input.repeat === 'annual'
          ? { type: input.repeat }
          : { type: input.repeat, interval: input.interval };
      const body = {
        title: input.title,
        categoryId: category.id,
        recurrence,
        nextDue: input.nextDue,
        calculateFrom: input.calculateFrom,
        ...(input.expectedCost !== undefined ? { expectedCost: input.expectedCost } : {}),
        ...(input.costVaries !== undefined ? { costVaries: input.costVaries } : {}),
        ...(input.reminders ? { reminders: input.reminders } : {}),
        ...(input.description ? { description: input.description } : {}),
        ...(input.notes ? { notes: input.notes } : {}),
      };
      const item = await apiCall(conn, 'POST', '/api/items', body);
      return {
        app: app.name,
        added: true,
        item: {
          id: item.id,
          title: item.title,
          category: category.name,
          nextDue: item.nextDue,
          recurrence: item.recurrence,
        },
      };
    },
  },
];

/** Lines for the cross-app "what's on" view. */
export async function attention(days) {
  const conn = await appConnection(app);
  if (!conn.ok) return { app: app.name, available: false, reason: conn.reason, items: [] };
  const ctx = await loadContext(conn);
  const items = ctx.items
    .map((i) => summarise(i, ctx.categories, ctx.today, ctx.dueSoonDays))
    .filter((i) => i.daysUntilDue !== null && i.daysUntilDue <= days && i.status !== 'archived')
    .sort((a, b) => a.daysUntilDue - b.daysUntilDue)
    .map((i) => ({
      app: app.name,
      id: i.id,
      title: i.title,
      date: i.nextDue,
      daysUntilDue: i.daysUntilDue,
      status: i.status,
      expectedCost: i.expectedCost,
      currency: i.currency,
    }));
  return { app: app.name, available: true, items };
}
