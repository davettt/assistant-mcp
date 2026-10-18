// Gift Keeper: people, their occasions, gift ideas and gifts.
// Talks to the app's local API with the per-launch token it writes while
// "Allow assistant access" is on (gift-keeper/server/assistant.js).
import { z } from 'zod';
import { appConnection, apiCall, notAvailable } from '../connection.js';

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
    date: u.nextDate.slice(0, 10),
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
