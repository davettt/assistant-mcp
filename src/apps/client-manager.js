// Client Manager: clients, jobs, tasks, reminders, activity and invoices.
// Talks to the app's local API with the per-launch token it writes while
// "Allow assistant access" is on (client-manager/server/src/assistant.js).
import { z } from 'zod';
import { appConnection, apiCall, notAvailable } from '../connection.js';
import { daysBetween, todayLocal } from '../dates.js';

export const app = {
  id: 'client-manager',
  name: 'Client Manager',
  bundleName: 'Client Manager',
  dataDir: 'client-manager',
  // Client Manager keeps its files in the data dir itself, not a local_data folder.
  tokenFile: 'assistant.json',
};

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

async function clientsByIdAndName(conn) {
  const clients = await apiCall(conn, 'GET', '/api/clients');
  return {
    clients,
    byId: new Map(clients.map((c) => [c.id, c])),
    find(name) {
      const wanted = name.trim().toLowerCase();
      return clients.find((c) => c.name.toLowerCase() === wanted);
    },
  };
}

function missingClient(name, clients) {
  return {
    app: app.name,
    added: false,
    message: `No client called "${name}" in Client Manager. Choose one of these and try again.`,
    clients: clients.map((c) => c.name),
  };
}

function reminderLine(r, byId, today) {
  const due = r.status === 'snoozed' && r.snoozedUntil ? r.snoozedUntil : r.dueDate;
  return {
    id: r.id,
    title: r.title,
    client: byId.get(r.clientId)?.name ?? null,
    dueDate: due,
    daysUntilDue: due ? daysBetween(today, due) : null,
    priority: r.priority,
    status: r.status,
    recurrence: r.recurrence !== 'none' ? r.recurrence : undefined,
    notes: r.notes || undefined,
  };
}

function taskLine(t, jobs, byId, today) {
  const job = jobs.get(t.jobId);
  return {
    id: t.id,
    title: t.title,
    job: job?.title ?? null,
    client: job ? (byId.get(job.clientId)?.name ?? null) : null,
    status: t.status,
    dueDate: t.dueDate,
    daysUntilDue: t.dueDate ? daysBetween(today, t.dueDate) : null,
    notes: t.notes || undefined,
  };
}

function invoiceLine(i, byId, today) {
  return {
    id: i.id,
    number: i.invoiceNumber,
    type: i.docType,
    client: byId.get(i.clientId)?.name ?? null,
    status: i.status,
    issueDate: i.issueDate,
    dueDate: i.dueDate,
    daysUntilDue: i.dueDate ? daysBetween(today, i.dueDate) : null,
    total: i.totals?.total ?? null,
    paid: i.totals?.amountPaid ?? null,
    balance: i.totals?.balance ?? null,
  };
}

export const tools = [
  {
    name: 'client_manager_reminders',
    description:
      'Reminders in Client Manager that are still pending or snoozed, with the client each belongs to. Overdue ones have a negative daysUntilDue.',
    input: z.object({
      withinDays: z.number().int().min(0).max(730).optional(),
      client: z.string().max(200).optional().describe('Only reminders for this client name'),
    }),
    async run(input) {
      const conn = await appConnection(app);
      if (!conn.ok) return notAvailable(app, conn);
      const { byId } = await clientsByIdAndName(conn);
      const today = todayLocal();
      let list = (await apiCall(conn, 'GET', '/api/reminders'))
        .filter((r) => r.status !== 'completed')
        .map((r) => reminderLine(r, byId, today));
      if (input.withinDays !== undefined) {
        list = list.filter((r) => r.daysUntilDue !== null && r.daysUntilDue <= input.withinDays);
      }
      if (input.client) {
        const who = input.client.toLowerCase();
        list = list.filter((r) => r.client?.toLowerCase() === who);
      }
      list.sort((a, b) => (a.daysUntilDue ?? Infinity) - (b.daysUntilDue ?? Infinity));
      return { app: app.name, today, count: list.length, reminders: list };
    },
  },
  {
    name: 'client_manager_tasks',
    description:
      'Open tasks in Client Manager (to do or in progress) with their job and client. Filter to those due within a number of days.',
    input: z.object({
      withinDays: z.number().int().min(0).max(730).optional(),
      client: z.string().max(200).optional(),
    }),
    async run(input) {
      const conn = await appConnection(app);
      if (!conn.ok) return notAvailable(app, conn);
      const [{ byId }, jobs, tasks] = await Promise.all([
        clientsByIdAndName(conn),
        apiCall(conn, 'GET', '/api/jobs'),
        apiCall(conn, 'GET', '/api/tasks'),
      ]);
      const jobsById = new Map(jobs.map((j) => [j.id, j]));
      const today = todayLocal();
      let list = tasks
        .filter((t) => t.status !== 'done')
        .map((t) => taskLine(t, jobsById, byId, today));
      if (input.withinDays !== undefined) {
        list = list.filter((t) => t.daysUntilDue !== null && t.daysUntilDue <= input.withinDays);
      }
      if (input.client) {
        const who = input.client.toLowerCase();
        list = list.filter((t) => t.client?.toLowerCase() === who);
      }
      list.sort((a, b) => (a.daysUntilDue ?? Infinity) - (b.daysUntilDue ?? Infinity));
      return { app: app.name, today, count: list.length, tasks: list };
    },
  },
  {
    name: 'client_manager_invoices',
    description:
      'Invoices in Client Manager that still have money owing (unpaid, partly paid or overdue), with totals, what has been paid and the balance. Quotes and paid invoices are left out unless asked for.',
    input: z.object({
      status: z
        .enum(['owing', 'overdue', 'paid', 'quotes', 'all'])
        .default('owing')
        .describe('owing = unpaid, partial and overdue'),
      client: z.string().max(200).optional(),
    }),
    async run(input) {
      const conn = await appConnection(app);
      if (!conn.ok) return notAvailable(app, conn);
      const { byId } = await clientsByIdAndName(conn);
      const today = todayLocal();
      let list = (await apiCall(conn, 'GET', '/api/invoices?totals=1')).map((i) =>
        invoiceLine(i, byId, today),
      );
      const pick = {
        owing: (i) => i.type !== 'quote' && ['unpaid', 'partial', 'overdue'].includes(i.status),
        overdue: (i) => i.status === 'overdue',
        paid: (i) => i.status === 'paid',
        quotes: (i) => i.type === 'quote',
        all: () => true,
      }[input.status];
      list = list.filter(pick);
      if (input.client) {
        const who = input.client.toLowerCase();
        list = list.filter((i) => i.client?.toLowerCase() === who);
      }
      list.sort((a, b) => (a.daysUntilDue ?? Infinity) - (b.daysUntilDue ?? Infinity));
      const owing = list.reduce((sum, i) => sum + (i.balance ?? 0), 0);
      return {
        app: app.name,
        today,
        count: list.length,
        totalOwing: Math.round(owing * 100) / 100,
        invoices: list,
      };
    },
  },
  {
    name: 'client_manager_client',
    description:
      'One client in Client Manager by name: contact details, when they were last contacted, their jobs with status and amounts, and their open reminders. If the name does not match, the reply lists the clients.',
    input: z.object({ name: z.string().min(1).max(200) }),
    async run(input) {
      const conn = await appConnection(app);
      if (!conn.ok) return notAvailable(app, conn);
      const { clients, byId, find } = await clientsByIdAndName(conn);
      const client = find(input.name);
      if (!client) return { ...missingClient(input.name, clients), added: undefined };
      const [jobs, reminders] = await Promise.all([
        apiCall(conn, 'GET', `/api/jobs?clientId=${encodeURIComponent(client.id)}`),
        apiCall(conn, 'GET', `/api/reminders?clientId=${encodeURIComponent(client.id)}`),
      ]);
      const today = todayLocal();
      return {
        app: app.name,
        client: {
          id: client.id,
          name: client.name,
          company: client.company || undefined,
          email: client.email || undefined,
          phone: client.phone || client.mobile || undefined,
          category: client.category || undefined,
          tags: client.tags?.length ? client.tags : undefined,
          lastContactAt: client.lastContactAt ?? null,
        },
        jobs: jobs.map((j) => ({
          id: j.id,
          title: j.title,
          status: j.status,
          amount: j.amount,
          amountStatus: j.amountStatus,
          startDate: j.startDate ?? undefined,
        })),
        reminders: reminders
          .filter((r) => r.status !== 'completed')
          .map((r) => reminderLine(r, byId, today)),
      };
    },
  },
  {
    name: 'client_manager_add_reminder',
    description:
      'Add a reminder in Client Manager for a client, by client name, with a due date. If the name does not match, the reply lists the clients.',
    input: z.object({
      client: z.string().min(1).max(200),
      title: z.string().trim().min(1).max(200),
      dueDate: date.describe('YYYY-MM-DD'),
      notes: z.string().max(2000).optional(),
      priority: z.enum(['normal', 'high']).optional(),
    }),
    write: true,
    async run(input) {
      const conn = await appConnection(app);
      if (!conn.ok) return notAvailable(app, conn);
      const { clients, find } = await clientsByIdAndName(conn);
      const client = find(input.client);
      if (!client) return missingClient(input.client, clients);
      const reminder = await apiCall(conn, 'POST', '/api/reminders', {
        clientId: client.id,
        title: input.title,
        dueDate: input.dueDate,
        ...(input.notes ? { notes: input.notes } : {}),
        ...(input.priority ? { priority: input.priority } : {}),
      });
      return {
        app: app.name,
        added: true,
        reminder: {
          id: reminder.id,
          title: reminder.title,
          client: client.name,
          dueDate: reminder.dueDate,
        },
      };
    },
  },
  {
    name: 'client_manager_add_task',
    description:
      "Add a task to one of a client's jobs in Client Manager. Give the client name and the job title; if either does not match, the reply lists what exists.",
    input: z.object({
      client: z.string().min(1).max(200),
      job: z.string().min(1).max(200).describe('The job title'),
      title: z.string().trim().min(1).max(200),
      dueDate: date.optional(),
      notes: z.string().max(2000).optional(),
    }),
    write: true,
    async run(input) {
      const conn = await appConnection(app);
      if (!conn.ok) return notAvailable(app, conn);
      const { clients, find } = await clientsByIdAndName(conn);
      const client = find(input.client);
      if (!client) return missingClient(input.client, clients);
      const jobs = await apiCall(
        conn,
        'GET',
        `/api/jobs?clientId=${encodeURIComponent(client.id)}`,
      );
      const wanted = input.job.trim().toLowerCase();
      const job = jobs.find((j) => j.title.toLowerCase() === wanted);
      if (!job) {
        return {
          app: app.name,
          added: false,
          message: `${client.name} has no job called "${input.job}". Choose one of these and try again.`,
          jobs: jobs.map((j) => ({ title: j.title, status: j.status })),
        };
      }
      const task = await apiCall(conn, 'POST', '/api/tasks', {
        jobId: job.id,
        title: input.title,
        ...(input.dueDate ? { dueDate: input.dueDate } : {}),
        ...(input.notes ? { notes: input.notes } : {}),
      });
      return {
        app: app.name,
        added: true,
        task: {
          id: task.id,
          title: task.title,
          job: job.title,
          client: client.name,
          dueDate: task.dueDate,
        },
      };
    },
  },
  {
    name: 'client_manager_log_activity',
    description:
      "Record an activity against a client in Client Manager: a call, meeting, email or note, with the date it happened (defaults to today). The type must be one of the app's activity types; an unknown type returns the list.",
    input: z.object({
      client: z.string().min(1).max(200),
      type: z
        .string()
        .min(1)
        .max(50)
        .describe('An activity type name from the app, e.g. call, meeting, email, note'),
      title: z.string().trim().min(1).max(200),
      description: z.string().max(5000).optional(),
      date: date.optional(),
      followUpDate: date.optional(),
    }),
    write: true,
    async run(input) {
      const conn = await appConnection(app);
      if (!conn.ok) return notAvailable(app, conn);
      const [{ clients, find }, settings] = await Promise.all([
        clientsByIdAndName(conn),
        apiCall(conn, 'GET', '/api/settings'),
      ]);
      const client = find(input.client);
      if (!client) return missingClient(input.client, clients);
      const types = (settings.activityTypes ?? []).map((t) =>
        typeof t === 'string' ? t : (t.id ?? t.name),
      );
      const wantedType = input.type.trim().toLowerCase();
      const type = types.find((t) => String(t).toLowerCase() === wantedType);
      if (!type) {
        return {
          app: app.name,
          added: false,
          message: `"${input.type}" is not an activity type in Client Manager. Choose one of these and try again.`,
          types,
        };
      }
      const activity = await apiCall(conn, 'POST', '/api/activities', {
        clientId: client.id,
        type,
        title: input.title,
        ...(input.description ? { description: input.description } : {}),
        ...(input.date ? { date: input.date } : {}),
        ...(input.followUpDate ? { followUpDate: input.followUpDate } : {}),
      });
      return {
        app: app.name,
        added: true,
        activity: {
          id: activity.id,
          type: activity.type,
          title: activity.title,
          client: client.name,
          date: activity.date,
        },
      };
    },
  },
];

/** Lines for the cross-app "what's on" view: reminders, dated tasks and invoices owing. */
export async function attention(days) {
  const conn = await appConnection(app);
  if (!conn.ok) return { app: app.name, available: false, reason: conn.reason, items: [] };
  const [{ byId }, reminders, jobs, tasks, invoices] = await Promise.all([
    clientsByIdAndName(conn),
    apiCall(conn, 'GET', '/api/reminders'),
    apiCall(conn, 'GET', '/api/jobs'),
    apiCall(conn, 'GET', '/api/tasks'),
    apiCall(conn, 'GET', '/api/invoices?totals=1'),
  ]);
  const jobsById = new Map(jobs.map((j) => [j.id, j]));
  const today = todayLocal();
  const items = [];
  for (const r of reminders.filter((x) => x.status !== 'completed')) {
    const line = reminderLine(r, byId, today);
    if (line.daysUntilDue !== null && line.daysUntilDue <= days) {
      items.push({
        app: app.name,
        id: line.id,
        title: `Reminder: ${line.title}${line.client ? ` (${line.client})` : ''}`,
        date: line.dueDate,
        daysUntilDue: line.daysUntilDue,
        status: line.priority === 'high' ? 'high priority' : line.status,
        expectedCost: null,
        currency: null,
      });
    }
  }
  for (const t of tasks.filter((x) => x.status !== 'done')) {
    const line = taskLine(t, jobsById, byId, today);
    if (line.daysUntilDue !== null && line.daysUntilDue <= days) {
      items.push({
        app: app.name,
        id: line.id,
        title: `Task: ${line.title}${line.job ? ` (${line.job}${line.client ? `, ${line.client}` : ''})` : ''}`,
        date: line.dueDate,
        daysUntilDue: line.daysUntilDue,
        status: line.status,
        expectedCost: null,
        currency: null,
      });
    }
  }
  for (const i of invoices) {
    const line = invoiceLine(i, byId, today);
    const owing = line.type !== 'quote' && ['unpaid', 'partial', 'overdue'].includes(line.status);
    if (owing && line.daysUntilDue !== null && line.daysUntilDue <= days) {
      items.push({
        app: app.name,
        id: line.id,
        title:
          `Invoice ${line.number ?? ''} ${line.status}${line.client ? ` (${line.client})` : ''}`.trim(),
        date: line.dueDate,
        daysUntilDue: line.daysUntilDue,
        status: line.status,
        expectedCost: line.balance,
        currency: null,
      });
    }
  }
  items.sort((a, b) => a.daysUntilDue - b.daysUntilDue);
  return { app: app.name, available: true, items };
}
