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

// A recurring job's period runs from its startDate (moved on when a period is completed)
// to the next cycle date. Mirrors client-manager/server/src/recurrence.js getNextCycleDate,
// since /api/jobs does not return the period end, so keep the two in step.
const CYCLE_DAYS = { weekly: 7, fortnightly: 14 };
const CYCLE_MONTHS = {
  monthly: 1,
  quarterly: 3,
  biannually: 6,
  annually: 12,
  '2-yearly': 24,
  '3-yearly': 36,
};

function nextCycleDate(dateStr, recurrence) {
  const d = new Date(dateStr + 'T00:00:00');
  if (CYCLE_DAYS[recurrence]) {
    d.setDate(d.getDate() + CYCLE_DAYS[recurrence]);
  } else if (CYCLE_MONTHS[recurrence]) {
    const day = d.getDate();
    d.setMonth(d.getMonth() + CYCLE_MONTHS[recurrence]);
    if (d.getDate() !== day) d.setDate(0);
  } else {
    return null;
  }
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function isRecurring(job) {
  return !!(job?.startDate && nextCycleDate(job.startDate, job.recurrence));
}

/** The periods an invoice for this job can cover: past ones, the current one and the next. */
function periodStarts(job) {
  const past = (job.cycleHistory ?? []).map((e) => e.cycleStart).filter(Boolean);
  return [...new Set([...past, job.startDate, nextCycleDate(job.startDate, job.recurrence)])];
}

function jobLine(j, invoices, today) {
  const recurring = isRecurring(j);
  const end = recurring ? nextCycleDate(j.startDate, j.recurrence) : null;
  return {
    id: j.id,
    title: j.title,
    status: j.status,
    description: j.description || undefined,
    location: j.location || undefined,
    tags: j.tags?.length ? j.tags : undefined,
    amount: j.amount,
    amountStatus: j.amountStatus,
    amountPaid: j.amountPaid || undefined,
    startDate: j.startDate ?? undefined,
    endDate: j.endDate || undefined,
    ...(recurring
      ? {
          recurrence: j.recurrence,
          billing: j.billingTiming === 'advance' ? 'in advance' : 'in arrears',
          currentPeriod: { start: j.startDate, end },
          nextRenewal: end,
          daysUntilRenewal: daysBetween(today, end),
          pastPeriods: (j.cycleHistory ?? []).slice(-3).map((e) => ({
            start: e.cycleStart,
            end: e.cycleEnd,
            amount: e.amount,
            amountStatus: e.amountStatus,
            invoices: (e.invoiceNumbers ?? []).filter(Boolean),
          })),
        }
      : {}),
    invoices: invoices
      .filter((i) => (i.jobIds ?? []).includes(j.id))
      .map((i) => ({
        number: i.invoiceNumber,
        status: i.status,
        total: i.totals?.total ?? null,
        balance: i.totals?.balance ?? null,
        period: periodOf(i, j),
      })),
  };
}

/** The period of this job an invoice covers, as start–end, or undefined. */
function periodOf(invoice, job) {
  const start = invoice.periods?.[job.id];
  if (!start || !isRecurring(job)) return undefined;
  return { start, end: nextCycleDate(start, job.recurrence) };
}

function invoiceLine(i, byId, today, jobsById) {
  const jobs = jobsById ? (i.jobIds ?? []).map((id) => jobsById.get(id)).filter(Boolean) : [];
  return {
    id: i.id,
    number: i.invoiceNumber,
    type: i.docType,
    source: i.source === 'external' ? 'external' : undefined,
    client: byId.get(i.clientId)?.name ?? null,
    status: i.status,
    issueDate: i.issueDate,
    dueDate: i.dueDate,
    daysUntilDue: i.dueDate ? daysBetween(today, i.dueDate) : null,
    total: i.totals?.total ?? null,
    paid: i.totals?.amountPaid ?? null,
    balance: i.totals?.balance ?? null,
    jobs: jobs.length
      ? jobs.map((j) => ({ id: j.id, title: j.title, period: periodOf(i, j) }))
      : undefined,
    link: i.externalLink || undefined,
  };
}

/** This app's line in the server's instructions: which tool does which job. */
export const instructions =
  "Client Manager: clients, their jobs, tasks on jobs, reminders, invoices and an activity log. One client's details, jobs and job ids: client_manager_client. A call, meeting or email that happened: client_manager_log_activity. Complete or snooze a reminder: client_manager_update_reminder. An invoice made in another system (Square, Xero), linked to a job and its renewal period: client_manager_add_invoice; existing invoices cannot be changed.";

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
      'Invoices in Client Manager that still have money owing (unpaid, partly paid or overdue), with totals, what has been paid, the balance, and the jobs (and period of a recurring job) each one covers. Quotes and paid invoices are left out unless asked for. To record an invoice made elsewhere (Square, Xero), use client_manager_add_invoice.',
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
      const [{ byId }, jobs, invoices] = await Promise.all([
        clientsByIdAndName(conn),
        apiCall(conn, 'GET', '/api/jobs'),
        apiCall(conn, 'GET', '/api/invoices?totals=1'),
      ]);
      const jobsById = new Map(jobs.map((j) => [j.id, j]));
      const today = todayLocal();
      let list = invoices.map((i) => invoiceLine(i, byId, today, jobsById));
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
      'One client in Client Manager by name: contact details, when they were last contacted, their open reminders, and each job in full: description, status, amount and what is paid, and for a recurring job (a renewal such as a domain or hosting) how often it renews, whether it is billed in advance or arrears, the current period, the next renewal and the last few periods, plus the invoices on the job and the period each covers. If the name does not match, the reply lists the clients.',
    input: z.object({ name: z.string().min(1).max(200) }),
    async run(input) {
      const conn = await appConnection(app);
      if (!conn.ok) return notAvailable(app, conn);
      const { clients, byId, find } = await clientsByIdAndName(conn);
      const client = find(input.name);
      if (!client) return { ...missingClient(input.name, clients), added: undefined };
      const [jobs, reminders, invoices] = await Promise.all([
        apiCall(conn, 'GET', `/api/jobs?clientId=${encodeURIComponent(client.id)}`),
        apiCall(conn, 'GET', `/api/reminders?clientId=${encodeURIComponent(client.id)}`),
        apiCall(conn, 'GET', `/api/invoices?clientId=${encodeURIComponent(client.id)}&totals=1`),
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
        jobs: jobs.map((j) => jobLine(j, invoices, today)),
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
  {
    name: 'client_manager_update_task',
    description:
      'Change a task in Client Manager: move its due date, mark it to do, in progress or done, or edit its title or notes. Use the task id from client_manager_tasks. Only the fields given change.',
    input: z.object({
      taskId: z.string().min(1),
      dueDate: date.nullable().optional().describe('New due date, or null to clear it'),
      status: z.enum(['todo', 'in-progress', 'done']).optional(),
      title: z.string().trim().min(1).max(200).optional(),
      notes: z.string().max(2000).optional(),
    }),
    write: true,
    async run(input) {
      const conn = await appConnection(app);
      if (!conn.ok) return notAvailable(app, conn);
      const { taskId, ...changes } = input;
      if (Object.keys(changes).length === 0) {
        return {
          app: app.name,
          changed: false,
          message: 'Nothing to change: give a due date, status, title or notes.',
        };
      }
      const task = await apiCall(conn, 'PUT', `/api/tasks/${encodeURIComponent(taskId)}`, changes);
      const [{ byId }, jobs] = await Promise.all([
        clientsByIdAndName(conn),
        apiCall(conn, 'GET', '/api/jobs'),
      ]);
      const line = taskLine(task, new Map(jobs.map((j) => [j.id, j])), byId, todayLocal());
      return { app: app.name, changed: true, task: line };
    },
  },
  {
    name: 'client_manager_update_reminder',
    description:
      'Change a reminder in Client Manager: complete it (status "completed"), move its due date, snooze it to a date, or edit its title, notes or priority. Use the reminder id from client_manager_reminders. Completing a recurring reminder makes the app create the next one.',
    input: z.object({
      reminderId: z.string().min(1),
      status: z.enum(['pending', 'completed', 'snoozed']).optional(),
      dueDate: date.optional(),
      snoozedUntil: date.optional().describe('With status "snoozed": the date it comes back'),
      title: z.string().trim().min(1).max(200).optional(),
      notes: z.string().max(2000).optional(),
      priority: z.enum(['normal', 'high']).optional(),
    }),
    write: true,
    async run(input) {
      const conn = await appConnection(app);
      if (!conn.ok) return notAvailable(app, conn);
      const { reminderId, ...changes } = input;
      if (Object.keys(changes).length === 0) {
        return {
          app: app.name,
          changed: false,
          message: 'Nothing to change: give a status, due date, title, notes or priority.',
        };
      }
      if (changes.status === 'completed') changes.completedAt = new Date().toISOString();
      if (changes.status === 'pending') {
        changes.completedAt = null;
        changes.snoozedUntil = null;
      }
      const reminder = await apiCall(
        conn,
        'PUT',
        `/api/reminders/${encodeURIComponent(reminderId)}`,
        changes,
      );
      const { byId } = await clientsByIdAndName(conn);
      const line = reminderLine(reminder, byId, todayLocal());
      return {
        app: app.name,
        changed: true,
        reminder: line,
        note:
          reminder.status === 'completed' && reminder.recurrence && reminder.recurrence !== 'none'
            ? `Recurring (${reminder.recurrence}): Client Manager has created the next one.`
            : undefined,
      };
    },
  },
  {
    name: 'client_manager_add_client',
    description: 'Add a client to Client Manager with optional email, phone and company.',
    input: z.object({
      name: z.string().trim().min(1).max(200),
      email: z.string().email().max(200).optional(),
      phone: z.string().max(50).optional(),
      company: z.string().max(200).optional(),
    }),
    write: true,
    async run(input) {
      const conn = await appConnection(app);
      if (!conn.ok) return notAvailable(app, conn);
      const { find } = await clientsByIdAndName(conn);
      if (find(input.name))
        return { app: app.name, added: false, message: `${input.name} is already a client.` };
      const client = await apiCall(conn, 'POST', '/api/clients', {
        name: input.name,
        ...(input.email ? { email: input.email } : {}),
        ...(input.phone ? { phone: input.phone } : {}),
        ...(input.company ? { company: input.company } : {}),
      });
      return {
        app: app.name,
        added: true,
        client: { id: client.id, name: client.name, email: client.email || undefined },
      };
    },
  },
  {
    name: 'client_manager_add_job',
    description:
      'Add a job for a client in Client Manager, by client name, with an optional description, amount and start date. If the name does not match, the reply lists the clients.',
    input: z.object({
      client: z.string().min(1).max(200),
      title: z.string().trim().min(1).max(200),
      description: z.string().max(5000).optional(),
      amount: z.number().min(0).optional(),
      startDate: date.optional(),
    }),
    write: true,
    async run(input) {
      const conn = await appConnection(app);
      if (!conn.ok) return notAvailable(app, conn);
      const { clients, find } = await clientsByIdAndName(conn);
      const client = find(input.client);
      if (!client) return missingClient(input.client, clients);
      const job = await apiCall(conn, 'POST', '/api/jobs', {
        clientId: client.id,
        title: input.title,
        status: 'active',
        ...(input.description ? { description: input.description } : {}),
        ...(input.amount !== undefined ? { amount: input.amount } : {}),
        ...(input.startDate ? { startDate: input.startDate } : {}),
      });
      return {
        app: app.name,
        added: true,
        job: {
          id: job.id,
          title: job.title,
          client: client.name,
          status: job.status,
          amount: job.amount ?? null,
        },
      };
    },
  },
  {
    name: 'client_manager_update_job',
    description:
      'Change a job in Client Manager: its status (active, on-hold, completed, cancelled), title, description or amount. Use a job id from client_manager_client.',
    input: z.object({
      jobId: z.string().min(1),
      status: z.enum(['active', 'on-hold', 'completed', 'cancelled']).optional(),
      title: z.string().trim().min(1).max(200).optional(),
      description: z.string().max(5000).optional(),
      amount: z.number().min(0).nullable().optional(),
    }),
    write: true,
    async run(input) {
      const conn = await appConnection(app);
      if (!conn.ok) return notAvailable(app, conn);
      const { jobId, ...changes } = input;
      if (Object.keys(changes).length === 0) {
        return {
          app: app.name,
          changed: false,
          message: 'Nothing to change: give a status, title, description or amount.',
        };
      }
      const job = await apiCall(conn, 'PUT', `/api/jobs/${encodeURIComponent(jobId)}`, changes);
      return {
        app: app.name,
        changed: true,
        job: { id: job.id, title: job.title, status: job.status, amount: job.amount ?? null },
      };
    },
  },
  {
    name: 'client_manager_add_invoice',
    description:
      "Record in Client Manager an invoice made in another system (Square, Xero, a PDF), with its own number and total, for a client by name. Link it to one of the client's jobs by title, and for a recurring job to the period it pays for (periodStart, the start date of that period; client_manager_client lists each job's periods). Set paidOn when it has been paid in full. Client Manager then updates the job's paid status. The reply reads the invoice back with its job and period. Invoices made in Client Manager itself are created in the app.",
    input: z.object({
      client: z.string().min(1).max(200),
      number: z.string().trim().min(1).max(50).describe("The invoice's number in the other system"),
      total: z.number().positive().max(1e9),
      job: z.string().min(1).max(200).optional().describe('The job title'),
      periodStart: date
        .optional()
        .describe(
          "For a recurring job: the start of the period it pays for; defaults to the app's choice",
        ),
      issueDate: date.optional().describe('Defaults to today'),
      dueDate: date.optional().describe('Defaults to the issue date'),
      link: z.string().url().max(2000).optional().describe('Where the invoice can be seen'),
      notes: z.string().max(2000).optional(),
      paidOn: date.optional().describe('The day it was paid in full'),
      paymentMethod: z.string().max(50).optional().describe('With paidOn, e.g. Square, card'),
    }),
    write: true,
    async run(input) {
      const conn = await appConnection(app);
      if (!conn.ok) return notAvailable(app, conn);
      const { clients, byId, find } = await clientsByIdAndName(conn);
      const client = find(input.client);
      if (!client) return missingClient(input.client, clients);
      const [jobs, invoices] = await Promise.all([
        apiCall(conn, 'GET', `/api/jobs?clientId=${encodeURIComponent(client.id)}`),
        apiCall(conn, 'GET', '/api/invoices'),
      ]);
      let job;
      if (input.job) {
        const wanted = input.job.trim().toLowerCase();
        job = jobs.find((j) => j.title.toLowerCase() === wanted);
        if (!job) {
          return {
            app: app.name,
            added: false,
            message: `${client.name} has no job called "${input.job}". Choose one of these and try again.`,
            jobs: jobs.map((j) => ({ title: j.title, status: j.status })),
          };
        }
      }
      if (input.periodStart) {
        if (!job || !isRecurring(job)) {
          return {
            app: app.name,
            added: false,
            message: 'periodStart is for an invoice linked to a recurring job.',
          };
        }
        const starts = periodStarts(job);
        if (!starts.includes(input.periodStart)) {
          return {
            app: app.name,
            added: false,
            message: `${job.title} has no period starting ${input.periodStart}. Choose one of these.`,
            periods: starts.map((start) => ({
              start,
              end: nextCycleDate(start, job.recurrence),
            })),
          };
        }
      }
      const number = input.number.trim().toLowerCase();
      if (
        invoices.some(
          (i) =>
            String(i.invoiceNumber ?? '')
              .trim()
              .toLowerCase() === number,
        )
      ) {
        return {
          app: app.name,
          added: false,
          message: `Invoice ${input.number} is already in Client Manager; client_manager_invoices with status "all" shows it.`,
        };
      }
      if (input.paidOn && input.paidOn > todayLocal()) {
        return { app: app.name, added: false, message: 'paidOn cannot be in the future.' };
      }
      const issueDate = input.issueDate ?? todayLocal();
      const created = await apiCall(conn, 'POST', '/api/invoices', {
        source: 'external',
        docType: 'invoice',
        invoiceNumber: input.number,
        clientId: client.id,
        jobIds: job ? [job.id] : [],
        externalTotal: input.total,
        issueDate,
        dueDate: input.dueDate ?? issueDate,
        ...(input.periodStart ? { periods: { [job.id]: input.periodStart } } : {}),
        ...(input.link ? { externalLink: input.link } : {}),
        ...(input.notes ? { notes: input.notes } : {}),
      });
      if (input.paidOn) {
        await apiCall(conn, 'POST', `/api/invoices/${encodeURIComponent(created.id)}/payment`, {
          amount: input.total,
          date: input.paidOn,
          ...(input.paymentMethod ? { method: input.paymentMethod } : {}),
        });
      }
      // Read it back as stored, with the totals and job status the app worked out.
      const [stored, allJobs] = await Promise.all([
        apiCall(conn, 'GET', `/api/invoices?clientId=${encodeURIComponent(client.id)}&totals=1`),
        apiCall(conn, 'GET', '/api/jobs'),
      ]);
      const jobsById = new Map(allJobs.map((j) => [j.id, j]));
      const invoice = stored.find((i) => i.id === created.id);
      const linked = job ? jobsById.get(job.id) : null;
      return {
        app: app.name,
        added: true,
        invoice: invoiceLine(invoice, byId, todayLocal(), jobsById),
        job: linked
          ? { title: linked.title, amountStatus: linked.amountStatus ?? null }
          : undefined,
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
