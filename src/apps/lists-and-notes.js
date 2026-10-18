// Lists & Notes: checklists and markdown notes. Writes need Lists & Notes 1.23.0 or later,
// which gives the assistant its own per-list and per-note routes (the whole-file save is
// window-only). Changing an existing list or note sends the `modified` stamp last read
// (`baseModified`); if the user changed it since, the app refuses and the tool re-reads and
// retries once. Item ids are always sent back, or the app would treat items as new. There
// is no delete tool. Talks to the app's local API with the per-launch token it writes while
// "Allow assistant access" is on (list-manager/assistant-access.js).
import { z } from 'zod';
import { ApiError, appConnection, apiCall, notAvailable } from '../connection.js';

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

const WRITES_FROM = '1.23.0';

function olderThan(version, min) {
  const a = String(version ?? '0')
    .split('.')
    .map(Number);
  const b = min.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((a[i] || 0) !== b[i]) return (a[i] || 0) < b[i];
  }
  return false;
}

/** The app's version must support writes; returns a result to send back, or null. */
function needsUpdate(conn) {
  if (!olderThan(conn.version, WRITES_FROM)) return null;
  return {
    app: app.name,
    changed: false,
    message: `Changing lists and notes needs Lists & Notes ${WRITES_FROM} or later (this Mac has ${conn.version ?? 'an older version'}). Reading still works.`,
  };
}

async function findList(conn, name) {
  const lists = await apiCall(conn, 'GET', '/api/data/lists');
  const wanted = name.trim().toLowerCase();
  return {
    list: lists.find((l) => l.name.toLowerCase() === wanted),
    names: lists.map((l) => l.name),
  };
}

async function findNote(conn, title) {
  const notes = await apiCall(conn, 'GET', '/api/data/notes');
  const wanted = title.trim().toLowerCase();
  return {
    note: notes.find((n) => n.title.toLowerCase() === wanted),
    titles: notes.map((n) => n.title),
  };
}

/** Runs a change against the latest copy; on a 409 (changed in the window) re-reads once. */
async function withRetry(load, change) {
  let current = await load();
  try {
    return await change(current);
  } catch (err) {
    if (!(err instanceof ApiError) || err.status !== 409) throw err;
    current = await load();
    return change(current);
  }
}

function itemMatches(item, text) {
  return item.text.trim().toLowerCase() === text.trim().toLowerCase();
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
  {
    name: 'lists_and_notes_add_items',
    description:
      'Add items to an existing list in Lists & Notes, by list name. Items are added unticked at the end. If the list does not exist, the reply lists the lists.',
    input: z.object({
      list: z.string().min(1).max(75),
      items: z.array(z.string().trim().min(1).max(2000)).min(1).max(100),
    }),
    write: true,
    async run(input) {
      const conn = await appConnection(app);
      if (!conn.ok) return notAvailable(app, conn);
      const old = needsUpdate(conn);
      if (old) return old;
      const { list, names } = await findList(conn, input.list);
      if (!list)
        return {
          app: app.name,
          changed: false,
          message: `No list called "${input.list}".`,
          lists: names,
        };
      const updated = await apiCall(
        conn,
        'POST',
        `/api/data/lists/${encodeURIComponent(list.id)}/items`,
        {
          items: input.items.map((text) => ({ text })),
        },
      );
      return { app: app.name, changed: true, list: summariseList(updated), added: input.items };
    },
  },
  {
    name: 'lists_and_notes_update_items',
    description:
      "Tick off, untick, reword or add notes to items on a list in Lists & Notes. Name the list and each item by its current text. Items not mentioned are left as they are. If an item's text does not match, the reply lists the items.",
    input: z.object({
      list: z.string().min(1).max(75),
      changes: z
        .array(
          z.object({
            item: z.string().min(1).max(2000).describe('The item as it reads now'),
            done: z.boolean().optional(),
            text: z.string().trim().min(1).max(2000).optional().describe('New wording'),
            notes: z.string().max(2000).optional(),
          }),
        )
        .min(1)
        .max(100),
    }),
    write: true,
    async run(input) {
      const conn = await appConnection(app);
      if (!conn.ok) return notAvailable(app, conn);
      const old = needsUpdate(conn);
      if (old) return old;
      const first = await findList(conn, input.list);
      if (!first.list)
        return {
          app: app.name,
          changed: false,
          message: `No list called "${input.list}".`,
          lists: first.names,
        };
      const id = first.list.id;
      const load = async () =>
        (await apiCall(conn, 'GET', '/api/data/lists')).find((l) => l.id === id);
      return withRetry(load, async (list) => {
        if (!list)
          return { app: app.name, changed: false, message: 'That list has just been removed.' };
        const items = (list.items ?? []).map((i) => ({ ...i }));
        const missing = input.changes
          .filter((c) => !items.some((i) => itemMatches(i, c.item)))
          .map((c) => c.item);
        if (missing.length) {
          return {
            app: app.name,
            changed: false,
            message: `No item reading ${missing.map((m) => `"${m}"`).join(', ')} on ${list.name}.`,
            items: items.map((i) => i.text),
          };
        }
        for (const c of input.changes) {
          const item = items.find((i) => itemMatches(i, c.item));
          if (c.done !== undefined) item.completed = c.done;
          if (c.text !== undefined) item.text = c.text;
          if (c.notes !== undefined) item.notes = c.notes;
        }
        const updated = await apiCall(conn, 'PATCH', `/api/data/lists/${encodeURIComponent(id)}`, {
          items,
          baseModified: list.metadata?.modified,
        });
        return { app: app.name, changed: true, list: summariseList(updated) };
      });
    },
  },
  {
    name: 'lists_and_notes_add_list',
    description:
      'Create a new list in Lists & Notes with optional first items. The category must already exist in the app; if it does not, the reply lists the categories.',
    input: z.object({
      name: z.string().trim().min(1).max(75),
      items: z.array(z.string().trim().min(1).max(2000)).max(100).optional(),
      category: z.string().max(100).optional().describe('Defaults to personal'),
      tags: z.array(z.string().max(50)).max(10).optional(),
    }),
    write: true,
    async run(input) {
      const conn = await appConnection(app);
      if (!conn.ok) return notAvailable(app, conn);
      const old = needsUpdate(conn);
      if (old) return old;
      const [{ list: existing }, categories] = await Promise.all([
        findList(conn, input.name),
        apiCall(conn, 'GET', '/api/data/categories'),
      ]);
      if (existing)
        return {
          app: app.name,
          added: false,
          message: `There is already a list called "${input.name}".`,
        };
      const category = input.category
        ? categories.find((c) => c.toLowerCase() === input.category.trim().toLowerCase())
        : 'personal';
      if (!category)
        return {
          app: app.name,
          added: false,
          message: `No category called "${input.category}".`,
          categories,
        };
      const list = await apiCall(conn, 'POST', '/api/data/lists/add', {
        name: input.name,
        category,
        ...(input.tags ? { tags: input.tags } : {}),
        items: (input.items ?? []).map((text) => ({ text, completed: false, notes: '' })),
      });
      return { app: app.name, added: true, list: summariseList(list) };
    },
  },
  {
    name: 'lists_and_notes_add_note',
    description:
      'Create a note in Lists & Notes with a title and markdown content. The category must already exist; if it does not, the reply lists the categories.',
    input: z.object({
      title: z.string().trim().min(1).max(75),
      content: z.string().max(200000).default(''),
      category: z.string().max(100).optional().describe('Defaults to personal'),
      tags: z.array(z.string().max(50)).max(10).optional(),
    }),
    write: true,
    async run(input) {
      const conn = await appConnection(app);
      if (!conn.ok) return notAvailable(app, conn);
      const old = needsUpdate(conn);
      if (old) return old;
      const categories = await apiCall(conn, 'GET', '/api/data/categories');
      const category = input.category
        ? categories.find((c) => c.toLowerCase() === input.category.trim().toLowerCase())
        : 'personal';
      if (!category)
        return {
          app: app.name,
          added: false,
          message: `No category called "${input.category}".`,
          categories,
        };
      const note = await apiCall(conn, 'POST', '/api/data/notes', {
        title: input.title,
        category,
        content: input.content,
        ...(input.tags ? { tags: input.tags } : {}),
      });
      return { app: app.name, added: true, note: summariseNote(note) };
    },
  },
  {
    name: 'lists_and_notes_update_note',
    description:
      "Change a note in Lists & Notes, by title: add text to the end (append), replace its text, or rename it. If the user edits the note at the same moment, the change is applied to their latest version; the app keeps the previous text in the note's history.",
    input: z.object({
      title: z.string().min(1).max(75).describe('The note as it is titled now'),
      append: z.string().max(200000).optional().describe('Text added on a new line at the end'),
      content: z.string().max(200000).optional().describe('Replaces the whole text'),
      newTitle: z.string().trim().min(1).max(75).optional(),
    }),
    write: true,
    async run(input) {
      const conn = await appConnection(app);
      if (!conn.ok) return notAvailable(app, conn);
      const old = needsUpdate(conn);
      if (old) return old;
      if (
        input.append === undefined &&
        input.content === undefined &&
        input.newTitle === undefined
      ) {
        return {
          app: app.name,
          changed: false,
          message: 'Nothing to change: give text to append, new content or a new title.',
        };
      }
      if (input.append !== undefined && input.content !== undefined) {
        return {
          app: app.name,
          changed: false,
          message: 'Give either append or content, not both.',
        };
      }
      const first = await findNote(conn, input.title);
      if (!first.note)
        return {
          app: app.name,
          changed: false,
          message: `No note called "${input.title}".`,
          titles: first.titles,
        };
      const id = first.note.id;
      const load = () => apiCall(conn, 'GET', `/api/data/notes/${encodeURIComponent(id)}`);
      return withRetry(load, async (note) => {
        const body = { baseModified: note.metadata?.modified };
        if (input.content !== undefined) body.content = input.content;
        if (input.append !== undefined) {
          const current = typeof note.content === 'string' ? note.content : '';
          body.content = current
            ? `${current.replace(/\s+$/, '')}\n\n${input.append}`
            : input.append;
        }
        if (input.newTitle !== undefined) body.title = input.newTitle;
        const updated = await apiCall(
          conn,
          'PUT',
          `/api/data/notes/${encodeURIComponent(id)}`,
          body,
        );
        return { app: app.name, changed: true, note: summariseNote(updated) };
      });
    },
  },
];

/** Lists & Notes has no dated items, so it adds nothing to "what's on". */
export async function attention() {
  const conn = await appConnection(app);
  if (!conn.ok) return { app: app.name, available: false, reason: conn.reason, items: [] };
  return { app: app.name, available: true, items: [] };
}
