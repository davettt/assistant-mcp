// Lists & Notes: checklists and markdown notes. Writes need Lists & Notes 1.23.0 or later,
// which gives the assistant its own per-list and per-note routes (the whole-file save is
// window-only). Changing an existing list or note sends the `modified` stamp last read
// (`baseModified`); if the user changed it since, the app refuses and the tool re-reads and
// retries once. Item ids are always sent back, or the app would treat items as new. Adding
// and renaming categories needs 1.24.0, which lets the token use those two routes. There
// is no delete tool. Talks to the app's local API with the per-launch token it writes while
// "Allow assistant access" is on (list-manager/assistant-access.js).
import { z } from 'zod';
import { ApiError, appConnection, apiCall, notAvailable, olderThan } from '../connection.js';

export const app = {
  id: 'lists-and-notes',
  name: 'Lists & Notes',
  bundleName: 'Lists & Notes',
  dataDir: 'lists-and-notes',
  // The app keeps its files in the data dir itself, not a local_data folder.
  tokenFile: 'assistant.json',
};

// Lists & Notes 1.25.0 archives with a flag (`archived`, `archivedAt`) and keeps the real
// category. Before that, archiving meant filing under an "archive" category, which 1.25.0
// converts at start-up; both count here, so older apps hide their archive too.
function isArchived(r) {
  return (
    r.archived === true ||
    (typeof r.category === 'string' && r.category.split('/')[0].trim().toLowerCase() === 'archive')
  );
}

const SCOPE = z
  .enum(['current', 'archive', 'all'])
  .default('current')
  .describe(
    'current (default) leaves archived ones out, as the app does; archive for only archived ones; all for both',
  );

/** Keeps the records in scope; says how many archived ones also match when they are left out. */
function inScope(records, scope) {
  if (scope === 'all') return { kept: records };
  const kept = records.filter((r) => isArchived(r) === (scope === 'archive'));
  return { kept, other: records.length - kept.length };
}

function archiveHint(scope, other, kind) {
  if (scope !== 'current' || !other) return undefined;
  return `${other} more ${kind} in the archive match; ask with scope "archive" or "all" to see them.`;
}

function archiveFields(r) {
  if (!isArchived(r)) return {};
  return { archived: true, archivedAt: r.archivedAt ?? undefined };
}

function summariseList(l) {
  const items = l.items ?? [];
  return {
    id: l.id,
    name: l.name,
    category: l.category,
    ...archiveFields(l),
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
    ...archiveFields(n),
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
const CATEGORY_WRITES_FROM = '1.24.0';
const ARCHIVE_FROM = '1.25.0';

/** What needs a newer app than some have, for assistant_info. */
export const needs = [
  { version: WRITES_FROM, for: 'Changing lists and notes' },
  { version: CATEGORY_WRITES_FROM, for: 'Adding and renaming categories' },
  { version: ARCHIVE_FROM, for: 'Archiving and unarchiving lists and notes' },
];

/** The app's version must support writes; returns a result to send back, or null. */
function needsUpdate(conn, min = WRITES_FROM, what = 'Changing lists and notes') {
  if (!olderThan(conn.version, min)) return null;
  return {
    app: app.name,
    changed: false,
    message: `${what} needs Lists & Notes ${min} or later (this Mac has ${conn.version ?? 'an older version'}). Reading still works.`,
  };
}

function findCategory(categories, name) {
  const wanted = name.trim().toLowerCase();
  return categories.find((c) => c.toLowerCase() === wanted);
}

/**
 * Where a list or note is going: a category (which must exist), into or out of the archive,
 * or both. From 1.25.0 the archive is a flag and the "archive" category is hidden, so asking
 * for that category archives instead (older apps still have it as a real category).
 * Returns { category, archived } or { result } to send back.
 */
async function resolvePlace(conn, input) {
  let { archived } = input;
  let category;
  const flagArchive = !olderThan(conn.version, ARCHIVE_FROM);
  if (input.category !== undefined) {
    if (flagArchive && isArchived({ category: input.category })) {
      if (archived === false)
        return {
          result: {
            app: app.name,
            changed: false,
            message: 'To bring it out of the archive, give the category it should go back to.',
          },
        };
      archived = true;
    } else {
      const categories = await apiCall(conn, 'GET', '/api/data/categories');
      category = findCategory(categories, input.category);
      if (!category)
        return {
          result: {
            app: app.name,
            changed: false,
            message: `No category called "${input.category}".`,
            categories,
          },
        };
    }
  }
  if (archived !== undefined && !flagArchive) {
    return {
      result: {
        app: app.name,
        changed: false,
        message: `Archiving and unarchiving need Lists & Notes ${ARCHIVE_FROM} or later (this Mac has ${conn.version ?? 'an older version'}). On this version, move it to the archive category instead.`,
      },
    };
  }
  return { category, archived };
}

/**
 * Coming out of the archive needs a real category. A record archived before 1.25.0 still
 * sits in the old archive category, so without one the app refuses; ask first instead.
 */
async function needsCategoryToUnarchive(conn, record, place) {
  if (place.archived !== false || place.category !== undefined) return null;
  if (!isArchived({ category: record.category })) return null;
  return {
    app: app.name,
    changed: false,
    message:
      'This was archived by filing it in the old archive category, so it has no category to go back to. Give one of these.',
    categories: await apiCall(conn, 'GET', '/api/data/categories'),
  };
}

/** The fields a PUT or PATCH sends for a place. */
function placeFields(place) {
  return {
    ...(place.category !== undefined ? { category: place.category } : {}),
    ...(place.archived !== undefined ? { archived: place.archived } : {}),
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

/** This app's line in the server's instructions: which tool does which job. */
export const instructions =
  "Lists & Notes: lists (with items) and notes, each in one category. Change a note's text, title or category: lists_and_notes_update_note. Move a list to another category, or archive or unarchive a list or note: lists_and_notes_move. Tick, untick or reword items: lists_and_notes_update_items. A category must exist before anything goes in it: lists_and_notes_add_category. Archived lists and notes are left out of lists_and_notes_lists and lists_and_notes_notes unless scope is archive or all.";

export const tools = [
  {
    name: 'lists_and_notes_lists',
    description:
      'The lists in Lists & Notes (checklists and plain lists) with their category, how many items each has and how many are done. Archived lists are left out unless scope says otherwise. Give a name to get one list with its items, archived or not.',
    input: z.object({
      name: z.string().max(75).optional().describe('A list name, for that list with its items'),
      search: z.string().max(100).optional().describe('Case-insensitive match on list names'),
      scope: SCOPE,
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
      let found = lists;
      if (input.search) {
        const q = input.search.toLowerCase();
        found = found.filter((l) => matches(l.name, q));
      }
      const { kept, other } = inScope(found, input.scope);
      return {
        app: app.name,
        count: kept.length,
        lists: kept.map(summariseList),
        hint: archiveHint(input.scope, other, other === 1 ? 'list' : 'lists'),
      };
    },
  },
  {
    name: 'lists_and_notes_notes',
    description:
      'Notes in Lists & Notes: title, category, tags and a short preview of each. Search matches the title, preview, summary and tags. Archived notes are left out unless scope says otherwise. Use lists_and_notes_note for the full text of one note.',
    input: z.object({
      search: z.string().max(100).optional(),
      category: z.string().max(100).optional(),
      scope: SCOPE,
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
      const { kept, other } = inScope(notes, input.scope);
      kept.sort((a, b) => String(b.modified ?? '').localeCompare(String(a.modified ?? '')));
      return {
        app: app.name,
        count: kept.length,
        notes: kept.slice(0, input.limit),
        hint: archiveHint(input.scope, other, other === 1 ? 'note' : 'notes'),
      };
    },
  },
  {
    name: 'lists_and_notes_note',
    description:
      'The full markdown text of one note in Lists & Notes, by title, archived or not (an archived note says so). If the title does not match, the reply lists the closest titles.',
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
      "Tick off, untick, reword or add notes to items on a list in Lists & Notes. Name the list and each item by its current text. Items not mentioned are left as they are. If an item's text does not match, the reply lists the items. To move the list to another category, use lists_and_notes_move.",
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
      "Change a note in Lists & Notes, by title: add text to the end (append), replace its text, rename it, move it to another category (which must already exist; if it does not, the reply lists the categories), or archive or unarchive it. Any of these can be done in one call. If the user edits the note at the same moment, the change is applied to their latest version; the app keeps the previous text in the note's history. lists_and_notes_move archives lists as well as notes.",
    input: z.object({
      title: z.string().min(1).max(75).describe('The note as it is titled now'),
      append: z.string().max(200000).optional().describe('Text added on a new line at the end'),
      content: z.string().max(200000).optional().describe('Replaces the whole text'),
      newTitle: z.string().trim().min(1).max(75).optional(),
      category: z.string().min(1).max(50).optional().describe('Moves the note to this category'),
      archived: z
        .boolean()
        .optional()
        .describe('true archives the note (it keeps its category); false brings it back'),
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
        input.newTitle === undefined &&
        input.category === undefined &&
        input.archived === undefined
      ) {
        return {
          app: app.name,
          changed: false,
          message:
            'Nothing to change: give text to append, new content, a new title, a category or archived.',
        };
      }
      if (input.append !== undefined && input.content !== undefined) {
        return {
          app: app.name,
          changed: false,
          message: 'Give either append or content, not both.',
        };
      }
      const place = await resolvePlace(conn, input);
      if (place.result) return place.result;
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
        const stuck = await needsCategoryToUnarchive(conn, note, place);
        if (stuck) return stuck;
        const body = { baseModified: note.metadata?.modified, ...placeFields(place) };
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
  {
    name: 'lists_and_notes_categories',
    description:
      'The categories in Lists & Notes with how many current lists and notes are in each, and how many archived ones when there are any. A category written "parent/child" is a subcategory.',
    input: z.object({}),
    async run() {
      const conn = await appConnection(app);
      if (!conn.ok) return notAvailable(app, conn);
      const [categories, lists, notes] = await Promise.all([
        apiCall(conn, 'GET', '/api/data/categories'),
        apiCall(conn, 'GET', '/api/data/lists'),
        apiCall(conn, 'GET', '/api/data/notes'),
      ]);
      const count = (records, c, archived) =>
        records.filter((r) => r.category === c && isArchived(r) === archived).length;
      // Before 1.25.0 the app lists its "archive" category too; 1.25.0 hides it.
      const shown = categories.filter((c) => !isArchived({ category: c }));
      return {
        app: app.name,
        count: shown.length,
        categories: shown.map((name) => {
          const archived = count(lists, name, true) + count(notes, name, true);
          return {
            name,
            lists: count(lists, name, false),
            notes: count(notes, name, false),
            archived: archived || undefined,
          };
        }),
      };
    },
  },
  {
    name: 'lists_and_notes_add_category',
    description:
      'Add a category in Lists & Notes. Names are stored in lower case, up to 50 characters. Write "parent/child" for a subcategory (one level only); a missing parent is created too.',
    input: z.object({ name: z.string().trim().min(1).max(50) }),
    write: true,
    async run(input) {
      const conn = await appConnection(app);
      if (!conn.ok) return notAvailable(app, conn);
      const old = needsUpdate(conn, CATEGORY_WRITES_FROM, 'Adding categories');
      if (old) return old;
      const categories = await apiCall(conn, 'GET', '/api/data/categories');
      const existing = findCategory(categories, input.name);
      if (existing)
        return {
          app: app.name,
          added: false,
          message: `There is already a category called "${existing}".`,
        };
      const res = await apiCall(conn, 'POST', '/api/data/categories', { name: input.name });
      return { app: app.name, added: true, category: res.category, categories: res.categories };
    },
  },
  {
    name: 'lists_and_notes_rename_category',
    description:
      'Rename a category in Lists & Notes. Every list and note in it moves to the new name, and so do its subcategories. If the category does not exist, the reply lists the categories.',
    input: z.object({
      category: z.string().min(1).max(50).describe('The category as it is named now'),
      newName: z.string().trim().min(1).max(50),
    }),
    write: true,
    async run(input) {
      const conn = await appConnection(app);
      if (!conn.ok) return notAvailable(app, conn);
      const old = needsUpdate(conn, CATEGORY_WRITES_FROM, 'Renaming categories');
      if (old) return old;
      const categories = await apiCall(conn, 'GET', '/api/data/categories');
      const category = findCategory(categories, input.category);
      if (!category)
        return {
          app: app.name,
          changed: false,
          message: `No category called "${input.category}".`,
          categories,
        };
      const res = await apiCall(
        conn,
        'PUT',
        `/api/data/categories/${encodeURIComponent(category)}`,
        { newName: input.newName },
      );
      return {
        app: app.name,
        changed: true,
        from: res.oldName,
        to: res.newName,
        categories: res.categories,
      };
    },
  },
  {
    name: 'lists_and_notes_move',
    description:
      'Move a list or a note to another category in Lists & Notes, or archive or unarchive it. Name the list or the note title, and a category that already exists (if it does not, the reply lists the categories), archived, or both. An archived list or note keeps its category, and unarchiving puts it back there. lists_and_notes_update_note can also move or archive a note while changing its text or title.',
    input: z.object({
      list: z.string().min(1).max(75).optional(),
      note: z.string().min(1).max(75).optional().describe('A note title'),
      category: z.string().min(1).max(50).optional(),
      archived: z
        .boolean()
        .optional()
        .describe('true archives it (it keeps its category); false brings it back'),
    }),
    write: true,
    async run(input) {
      const conn = await appConnection(app);
      if (!conn.ok) return notAvailable(app, conn);
      const old = needsUpdate(conn);
      if (old) return old;
      if ((input.list === undefined) === (input.note === undefined)) {
        return { app: app.name, changed: false, message: 'Give either a list or a note.' };
      }
      if (input.category === undefined && input.archived === undefined) {
        return { app: app.name, changed: false, message: 'Give a category, archived, or both.' };
      }
      const place = await resolvePlace(conn, input);
      if (place.result) return place.result;
      if (input.list !== undefined) {
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
          const stuck = await needsCategoryToUnarchive(conn, list, place);
          if (stuck) return stuck;
          const updated = await apiCall(
            conn,
            'PATCH',
            `/api/data/lists/${encodeURIComponent(id)}`,
            { ...placeFields(place), baseModified: list.metadata?.modified },
          );
          return { app: app.name, changed: true, list: summariseList(updated) };
        });
      }
      const first = await findNote(conn, input.note);
      if (!first.note)
        return {
          app: app.name,
          changed: false,
          message: `No note called "${input.note}".`,
          titles: first.titles,
        };
      const id = first.note.id;
      const load = () => apiCall(conn, 'GET', `/api/data/notes/${encodeURIComponent(id)}`);
      return withRetry(load, async (note) => {
        const stuck = await needsCategoryToUnarchive(conn, note, place);
        if (stuck) return stuck;
        const updated = await apiCall(conn, 'PUT', `/api/data/notes/${encodeURIComponent(id)}`, {
          ...placeFields(place),
          baseModified: note.metadata?.modified,
        });
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
