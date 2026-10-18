// Gift Keeper: people, their occasions, gift ideas and gifts.
// Talks to the app's local API with the per-launch token it writes while
// "Allow assistant access" is on (gift-keeper/server/assistant.js).
import { z } from 'zod';
import { appConnection, apiCall, notAvailable } from '../connection.js';
import { todayLocal } from '../dates.js';

export const app = {
  id: 'gift-keeper',
  name: 'Gift Keeper',
  bundleName: 'Gift Keeper',
  dataDir: 'gift-keeper',
};

function summariseOccasion(u) {
  return {
    occasionId: u.occasion.id,
    name: u.occasion.name,
    type: u.occasion.type,
    // nextDate is local midnight as an ISO timestamp; format it in local time, or the
    // calendar day shifts back by one for anyone east of UTC.
    date: todayLocal(new Date(u.nextDate)),
    daysUntil: u.daysUntil,
    people: u.people.map((p) => p.name),
    giftChosen: u.hasGiftSelected,
    openGifts: u.openGiftCount,
    budget: u.budget ?? null,
    spent: u.spent,
    gifts: u.gifts
      .filter((g) => g.status !== 'cancelled')
      .map((g) => ({ id: g.id, name: g.name, status: g.status, price: g.price ?? null })),
  };
}

function summarisePerson(p) {
  return {
    id: p.id,
    name: p.name,
    relationship: p.relationship || undefined,
    interests: p.interests?.length ? p.interests : undefined,
    sizes: p.sizes && Object.keys(p.sizes).length ? p.sizes : undefined,
    preferences: p.preferences || undefined,
    avoid: p.avoid || undefined,
    notes: p.notes || undefined,
  };
}

async function findPerson(conn, name) {
  const people = await apiCall(conn, 'GET', '/api/people');
  const wanted = name.trim().toLowerCase();
  return {
    person: people.find((p) => p.name.toLowerCase() === wanted),
    names: people.map((p) => p.name),
  };
}

export const tools = [
  {
    name: 'gift_keeper_upcoming',
    description:
      'Upcoming occasions in Gift Keeper (birthdays, anniversaries, holidays and custom dates) with who they are for, whether a gift has been chosen, the budget and what has been spent so far.',
    input: z.object({
      withinDays: z
        .number()
        .int()
        .min(0)
        .max(730)
        .optional()
        .describe('Only occasions within this many days'),
      person: z.string().max(100).optional().describe("Only occasions for this person's name"),
    }),
    async run(input) {
      const conn = await appConnection(app);
      if (!conn.ok) return notAvailable(app, conn);
      let list = (await apiCall(conn, 'GET', '/api/upcoming')).map(summariseOccasion);
      if (input.withinDays !== undefined)
        list = list.filter((u) => u.daysUntil <= input.withinDays);
      if (input.person) {
        const who = input.person.toLowerCase();
        list = list.filter((u) => u.people.some((n) => n.toLowerCase() === who));
      }
      return { app: app.name, count: list.length, occasions: list };
    },
  },
  {
    name: 'gift_keeper_people',
    description:
      'The people in Gift Keeper with what helps choose a gift: relationship, interests, sizes, preferences and things to avoid. Give a name for one person, or leave it out for everyone.',
    input: z.object({ name: z.string().max(100).optional() }),
    async run(input) {
      const conn = await appConnection(app);
      if (!conn.ok) return notAvailable(app, conn);
      const people = await apiCall(conn, 'GET', '/api/people');
      let list = people.filter((p) => !p.archived);
      if (input.name) {
        const who = input.name.toLowerCase();
        list = list.filter((p) => p.name.toLowerCase() === who);
      }
      return { app: app.name, count: list.length, people: list.map(summarisePerson) };
    },
  },
  {
    name: 'gift_keeper_ideas',
    description:
      "Gift ideas saved in Gift Keeper: the pool of possible gifts, including ones not yet tied to an occasion. Filter by person's name or search the idea text. This is where to look before suggesting something new.",
    input: z.object({
      person: z.string().max(100).optional(),
      search: z.string().max(100).optional(),
    }),
    async run(input) {
      const conn = await appConnection(app);
      if (!conn.ok) return notAvailable(app, conn);
      const [ideas, people, occasions] = await Promise.all([
        apiCall(conn, 'GET', '/api/ideas'),
        apiCall(conn, 'GET', '/api/people'),
        apiCall(conn, 'GET', '/api/occasions'),
      ]);
      const personName = new Map(people.map((p) => [p.id, p.name]));
      const occasionName = new Map(occasions.map((o) => [o.id, o.name]));
      let list = ideas.map((i) => ({
        id: i.id,
        idea: i.name,
        person: i.personId ? (personName.get(i.personId) ?? null) : null,
        occasion: i.occasionId ? (occasionName.get(i.occasionId) ?? null) : null,
        price: i.price ?? null,
        priority: i.priority ?? 'normal',
        url: i.url || undefined,
        notes: i.notes || undefined,
        added: i.dateAdded ?? null,
      }));
      if (input.person) {
        const who = input.person.toLowerCase();
        list = list.filter((i) => i.person?.toLowerCase() === who);
      }
      if (input.search) {
        const q = input.search.toLowerCase();
        list = list.filter(
          (i) => i.idea.toLowerCase().includes(q) || (i.notes ?? '').toLowerCase().includes(q),
        );
      }
      return { app: app.name, count: list.length, ideas: list };
    },
  },
  {
    name: 'gift_keeper_gifts',
    description:
      'Gifts being tracked in Gift Keeper at any stage (idea, shortlisted, ordered, bought, arrived, wrapped, given, cancelled), with who and which occasion each is for. Filter by person or status. Given and cancelled gifts are left out unless asked for.',
    input: z.object({
      person: z.string().max(100).optional(),
      status: z
        .enum([
          'open',
          'idea',
          'shortlisted',
          'ordered',
          'bought',
          'arrived',
          'wrapped',
          'given',
          'cancelled',
          'all',
        ])
        .default('open')
        .describe('open = everything not yet given or cancelled'),
    }),
    async run(input) {
      const conn = await appConnection(app);
      if (!conn.ok) return notAvailable(app, conn);
      const [gifts, people, occasions] = await Promise.all([
        apiCall(conn, 'GET', '/api/gifts'),
        apiCall(conn, 'GET', '/api/people'),
        apiCall(conn, 'GET', '/api/occasions'),
      ]);
      const personName = new Map(people.map((p) => [p.id, p.name]));
      const occasionName = new Map(occasions.map((o) => [o.id, o.name]));
      let list = gifts.map((g) => ({
        id: g.id,
        name: g.name,
        status: g.status,
        person: g.personId ? (personName.get(g.personId) ?? null) : null,
        occasion: g.occasionId ? (occasionName.get(g.occasionId) ?? null) : null,
        price: g.price ?? null,
        plannedDate: g.plannedDate ?? null,
        notes: g.notes || undefined,
      }));
      if (input.status === 'open')
        list = list.filter((g) => !['given', 'cancelled'].includes(g.status));
      else if (input.status !== 'all') list = list.filter((g) => g.status === input.status);
      if (input.person) {
        const who = input.person.toLowerCase();
        list = list.filter((g) => g.person?.toLowerCase() === who);
      }
      return { app: app.name, count: list.length, gifts: list };
    },
  },
  {
    name: 'gift_keeper_add_idea',
    description:
      'Save a gift idea in Gift Keeper for a person, by name. If the name does not match, the reply lists the people to choose from. Optional link, price, notes and priority.',
    input: z.object({
      idea: z.string().trim().min(1).max(200),
      person: z.string().min(1).max(100),
      url: z.string().url().max(2000).optional(),
      price: z.number().min(0).optional(),
      notes: z.string().max(2000).optional(),
      priority: z.enum(['low', 'normal', 'high']).optional(),
    }),
    write: true,
    async run(input) {
      const conn = await appConnection(app);
      if (!conn.ok) return notAvailable(app, conn);
      const { person, names } = await findPerson(conn, input.person);
      if (!person) {
        return {
          app: app.name,
          added: false,
          message: `No one called "${input.person}" in Gift Keeper. Choose one of these and try again.`,
          people: names,
        };
      }
      const body = {
        name: input.idea,
        personId: person.id,
        ...(input.url ? { url: input.url } : {}),
        ...(input.price !== undefined ? { price: input.price } : {}),
        ...(input.notes ? { notes: input.notes } : {}),
        ...(input.priority ? { priority: input.priority } : {}),
      };
      const idea = await apiCall(conn, 'POST', '/api/ideas', body);
      return {
        app: app.name,
        added: true,
        idea: { id: idea.id, name: idea.name, person: person.name, priority: idea.priority },
      };
    },
  },
  {
    name: 'gift_keeper_mark_gift_given',
    description: 'Mark a gift in Gift Keeper as given. Use a gift id from gift_keeper_upcoming.',
    input: z.object({ giftId: z.string().min(1) }),
    write: true,
    async run(input) {
      const conn = await appConnection(app);
      if (!conn.ok) return notAvailable(app, conn);
      const gift = await apiCall(
        conn,
        'POST',
        `/api/gifts/${encodeURIComponent(input.giftId)}/mark-given`,
      );
      return {
        app: app.name,
        changed: 'given',
        gift: { id: gift.id, name: gift.name, status: gift.status },
      };
    },
  },
  {
    name: 'gift_keeper_update_gift',
    description:
      'Change a gift in Gift Keeper: its status (idea, shortlisted, ordered, bought, arrived, wrapped, given, cancelled), price, name or notes. Use a gift id from gift_keeper_upcoming.',
    input: z.object({
      giftId: z.string().min(1),
      status: z
        .enum([
          'idea',
          'shortlisted',
          'ordered',
          'bought',
          'arrived',
          'wrapped',
          'given',
          'cancelled',
        ])
        .optional(),
      price: z.number().min(0).nullable().optional(),
      name: z.string().trim().min(1).max(200).optional(),
      notes: z.string().max(2000).optional(),
    }),
    write: true,
    async run(input) {
      const conn = await appConnection(app);
      if (!conn.ok) return notAvailable(app, conn);
      const { giftId, ...changes } = input;
      if (Object.keys(changes).length === 0) {
        return {
          app: app.name,
          changed: false,
          message: 'Nothing to change: give a status, price, name or notes.',
        };
      }
      const gift = await apiCall(conn, 'PUT', `/api/gifts/${encodeURIComponent(giftId)}`, changes);
      return {
        app: app.name,
        changed: true,
        gift: { id: gift.id, name: gift.name, status: gift.status, price: gift.price ?? null },
      };
    },
  },
  {
    name: 'gift_keeper_add_person',
    description: 'Add a person to Gift Keeper, with optional relationship, interests and notes.',
    input: z.object({
      name: z.string().trim().min(1).max(100),
      relationship: z.string().max(100).optional(),
      interests: z.array(z.string().max(100)).max(50).optional(),
      notes: z.string().max(2000).optional(),
    }),
    write: true,
    async run(input) {
      const conn = await appConnection(app);
      if (!conn.ok) return notAvailable(app, conn);
      const { names } = await findPerson(conn, input.name);
      if (names.some((n) => n.toLowerCase() === input.name.trim().toLowerCase())) {
        return { app: app.name, added: false, message: `${input.name} is already in Gift Keeper.` };
      }
      const person = await apiCall(conn, 'POST', '/api/people', {
        name: input.name,
        ...(input.relationship ? { relationship: input.relationship } : {}),
        ...(input.interests ? { interests: input.interests } : {}),
        ...(input.notes ? { notes: input.notes } : {}),
      });
      return { app: app.name, added: true, person: summarisePerson(person) };
    },
  },
  {
    name: 'gift_keeper_add_occasion',
    description:
      'Add an occasion in Gift Keeper (a birthday, anniversary, holiday or custom date) for one or more people by name, yearly or one-off, with an optional budget. If a name does not match, the reply lists the people.',
    input: z.object({
      name: z.string().trim().min(1).max(200),
      date: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/)
        .describe('YYYY-MM-DD; for a yearly occasion, the next one'),
      people: z.array(z.string().min(1).max(100)).min(1).max(20),
      repeats: z.enum(['yearly', 'one-off']).default('yearly'),
      type: z.string().max(50).optional().describe('e.g. birthday, anniversary, christmas, custom'),
      budget: z.number().min(0).optional(),
    }),
    write: true,
    async run(input) {
      const conn = await appConnection(app);
      if (!conn.ok) return notAvailable(app, conn);
      const people = await apiCall(conn, 'GET', '/api/people');
      const ids = [];
      const missing = [];
      for (const wanted of input.people) {
        const p = people.find((x) => x.name.toLowerCase() === wanted.trim().toLowerCase());
        if (p) ids.push(p.id);
        else missing.push(wanted);
      }
      if (missing.length) {
        return {
          app: app.name,
          added: false,
          message: `No one called ${missing.map((m) => `"${m}"`).join(', ')} in Gift Keeper.`,
          people: people.map((p) => p.name),
        };
      }
      const occasion = await apiCall(conn, 'POST', '/api/occasions', {
        name: input.name,
        date: input.date,
        personIds: ids,
        recurrence: input.repeats,
        ...(input.type ? { type: input.type } : {}),
        ...(input.budget !== undefined ? { budget: input.budget } : {}),
      });
      return {
        app: app.name,
        added: true,
        occasion: {
          id: occasion.id,
          name: occasion.name,
          date: occasion.date,
          repeats: occasion.recurrence,
          people: input.people,
        },
      };
    },
  },
  {
    name: 'gift_keeper_complete_occasion',
    description:
      'Mark an occasion in Gift Keeper as done for this year, so it leaves the upcoming list until next time. Use an occasion id from gift_keeper_upcoming. The app refuses while a gift for it is still open (not given or cancelled), so settle those first with gift_keeper_update_gift.',
    input: z.object({ occasionId: z.string().min(1) }),
    write: true,
    async run(input) {
      const conn = await appConnection(app);
      if (!conn.ok) return notAvailable(app, conn);
      const occasion = await apiCall(
        conn,
        'POST',
        `/api/occasions/${encodeURIComponent(input.occasionId)}/complete`,
        {},
      );
      return {
        app: app.name,
        changed: 'completed',
        occasion: {
          id: occasion.id,
          name: occasion.name,
          completedYears: occasion.completedYears ?? [],
        },
      };
    },
  },
];

/** Lines for the cross-app "what's on" view. */
export async function attention(days) {
  const conn = await appConnection(app);
  if (!conn.ok) return { app: app.name, available: false, reason: conn.reason, items: [] };
  const upcoming = (await apiCall(conn, 'GET', '/api/upcoming')).map(summariseOccasion);
  const items = upcoming
    .filter((u) => u.daysUntil <= days)
    .map((u) => ({
      app: app.name,
      id: u.occasionId,
      title: `${u.name}${u.people.length ? ` (${u.people.join(', ')})` : ''}`,
      date: u.date,
      daysUntilDue: u.daysUntil,
      status: u.giftChosen ? 'gift chosen' : 'no gift yet',
      expectedCost: u.budget,
      currency: null,
    }));
  return { app: app.name, available: true, items };
}
