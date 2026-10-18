// Lists & Notes: checklists and markdown notes. Read-only for now: the app's list
// endpoint replaces the whole file from the request, so writes wait until that is
// hardened (see the plan). Talks to the app's local API with the per-launch token it
// writes while "Allow assistant access" is on (list-manager/assistant-access.js).
import { z } from 'zod';
import { appConnection, apiCall, notAvailable } from '../connection.js';

export const app = {
  id: 'lists-and-notes',
  name: 'Lists & Notes',
  bundleName: 'Lists & Notes',
  dataDir: 'lists-and-notes',
  // The app keeps its files in the data dir itself, not a local_data folder.
  tokenFile: 'assistant.json',
};

function summariseList(l) {
  const items = l.items ?? [];
  return {
    id: l.id,
    name: l.name,
    category: l.category,
    priority: l.priority,
    favourite: l.favorite === true || undefined,
    tags: l.tags?.length ? l.tags : undefined,
    items: items.length,
    done: items.filter((i) => i.completed).length,
    modified: l.metadata?.modified ?? null,
  };
}

function summariseNote(n) {
  return {
    id: n.id,
    title: n.title,
    category: n.category,
    tags: n.tags?.length ? n.tags : undefined,
    favourite: n.favorite === true || undefined,
    preview: n.preview,
    summary: n.content?.tldr || undefined,
    words: n.metadata?.wordCount ?? null,
    modified: n.metadata?.modified ?? null,
  };
}

function matches(text, q) {
  return typeof text === 'string' && text.toLowerCase().includes(q);
}

export const tools = [
  {
    name: 'lists_and_notes_lists',
    description:
      'The lists in Lists & Notes (checklists and plain lists) with their category, how many items each has and how many are done. Give a name to get one list with its items.',
    input: z.object({
      name: z.string().max(75).optional().describe('A list name, for that list with its items'),
      search: z.string().max(100).optional().describe('Case-insensitive match on list names'),
    }),
    async run(input) {
      const conn = await appConnection(app);
      if (!conn.ok) return notAvailable(app, conn);
      const lists = await apiCall(conn, 'GET', '/api/data/lists');
      if (input.name) {
        const wanted = input.name.trim().toLowerCase();
        const list = lists.find((l) => l.name.toLowerCase() === wanted);
        if (!list) {
          return {
            app: app.name,
            found: false,
            message: `No list called "${input.name}". These exist.`,
            lists: lists.map((l) => l.name),
          };
        }
        return {
          app: app.name,
          found: true,
          list: {
            ...summariseList(list),
            items: (list.items ?? []).map((i) => ({
              id: i.id,
              text: i.text,
              done: i.completed === true,
              notes: i.notes || undefined,
            })),
          },
        };
      }
      let out = lists.map(summariseList);
      if (input.search) {
        const q = input.search.toLowerCase();
        out = out.filter((l) => matches(l.name, q));
      }
      return { app: app.name, count: out.length, lists: out };
    },
  },
  {
    name: 'lists_and_notes_notes',
    description:
      'Notes in Lists & Notes: title, category, tags and a short preview of each. Search matches the title, preview, summary and tags. Use lists_and_notes_note for the full text of one note.',
    input: z.object({
      search: z.string().max(100).optional(),
      category: z.string().max(100).optional(),
      limit: z.number().int().min(1).max(200).default(50),
    }),
    async run(input) {
      const conn = await appConnection(app);
      if (!conn.ok) return notAvailable(app, conn);
      let notes = (await apiCall(conn, 'GET', '/api/data/notes')).map(summariseNote);
      if (input.category) {
        const c = input.category.toLowerCase();
        notes = notes.filter((n) => (n.category ?? '').toLowerCase() === c);
      }
      if (input.search) {
        const q = input.search.toLowerCase();
        notes = notes.filter(
          (n) =>
            matches(n.title, q) ||
            matches(n.preview, q) ||
            matches(n.summary, q) ||
            (n.tags ?? []).some((t) => matches(t, q)),
        );
      }
      notes.sort((a, b) => String(b.modified ?? '').localeCompare(String(a.modified ?? '')));
      return { app: app.name, count: notes.length, notes: notes.slice(0, input.limit) };
    },
  },
  {
    name: 'lists_and_notes_note',
    description:
      'The full markdown text of one note in Lists & Notes, by title. If the title does not match, the reply lists the closest titles.',
    input: z.object({ title: z.string().min(1).max(75) }),
    async run(input) {
      const conn = await appConnection(app);
      if (!conn.ok) return notAvailable(app, conn);
      const notes = await apiCall(conn, 'GET', '/api/data/notes');
      const wanted = input.title.trim().toLowerCase();
      const note =
        notes.find((n) => n.title.toLowerCase() === wanted) ??
        notes.find((n) => n.title.toLowerCase().includes(wanted));
      if (!note) {
        return {
          app: app.name,
          found: false,
          message: `No note called "${input.title}". These are close.`,
          titles: notes
            .filter((n) => wanted.split(/\s+/).some((w) => w.length > 2 && matches(n.title, w)))
            .slice(0, 20)
            .map((n) => n.title),
        };
      }
      const full = await apiCall(conn, 'GET', `/api/data/notes/${encodeURIComponent(note.id)}`);
      return {
        app: app.name,
        found: true,
        note: { ...summariseNote(note), preview: undefined, content: full.content },
      };
    },
  },
];

/** Lists & Notes has no dated items, so it adds nothing to "what's on". */
export async function attention() {
  const conn = await appConnection(app);
  if (!conn.ok) return { app: app.name, available: false, reason: conn.reason, items: [] };
  return { app: app.name, available: true, items: [] };
}
