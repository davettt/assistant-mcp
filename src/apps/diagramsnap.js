// DiagramSnap: diagrams and slide decks drawn on an Excalidraw canvas. Needs DiagramSnap
// 0.7.0 or later, which gives the assistant its token, the previews and its own write rules
// (flowsketch/server/assistantEdits.js). The assistant reads and writes `diagramData`, the
// app's plain description of a diagram (nodes, edges, annotations, frames); the window turns
// it into the canvas with its own converter and layout, and draws a PNG preview the tools
// return as an image. A diagramData change replaces the whole diagram, so it carries the
// `updatedAt` the assistant read, and the app refuses it if the user has saved since. There
// is no delete tool, and the app's own AI routes are closed to the token.
import { z } from 'zod';
import { ApiError, appConnection, apiCall, notAvailable, withImages } from '../connection.js';

export const app = {
  id: 'diagramsnap',
  name: 'DiagramSnap',
  bundleName: 'DiagramSnap',
  dataDir: 'DiagramSnap',
};

// The window builds previews when its poll (every 10 seconds) sees an assistant change.
const PREVIEW_WAIT_MS = 15_000;
const PREVIEW_POLL_MS = 1_000;
const MAX_IMAGES = 10;

const ID = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/, '1-64 letters, digits, _ or -');
const COLOR = z.string().max(40).describe('Hex such as #1e1e1e, a colour name, or rgb()/hsl()');
const FONT = z.enum(['hand-drawn', 'normal', 'monospace', 'corporate']);

// The core of the app's diagramData (flowsketch/server/diagramData.js validates it and keeps
// only the fields it knows). Extra styling fields pass through for the app to check.
const NODE = z
  .object({
    id: ID,
    type: z.enum(['ellipse', 'rectangle', 'diamond', 'rounded-rectangle']),
    label: z.string().max(500).nullable().optional(),
    x: z.number().min(-100_000).max(100_000),
    y: z.number().min(-100_000).max(100_000),
    width: z.number().min(1).max(10_000),
    height: z.number().min(1).max(10_000),
    strokeColor: COLOR.optional(),
    fillColor: COLOR.nullable().optional(),
    fontSize: z.number().min(1).max(200).optional(),
    fontFamily: FONT.optional(),
  })
  .passthrough();
const EDGE = z
  .object({
    id: ID,
    from: ID.describe('A node id'),
    to: ID.describe('A node id'),
    label: z.string().max(500).nullable().optional(),
    style: z
      .enum(['arrow', 'line', 'curved-arrow', 'curved-line', 'elbow-arrow', 'elbow-line'])
      .optional()
      .describe('Default elbow-arrow, which routes around shapes'),
    startSide: z.enum(['top', 'bottom', 'left', 'right']).optional(),
    endSide: z.enum(['top', 'bottom', 'left', 'right']).optional(),
  })
  .passthrough();
const ANNOTATION = z
  .object({
    id: ID,
    type: z.literal('text').optional(),
    content: z.string().max(2000),
    x: z.number().min(-100_000).max(100_000),
    y: z.number().min(-100_000).max(100_000),
    color: COLOR.optional(),
    fontSize: z.number().min(1).max(200).optional(),
    fontFamily: FONT.optional(),
  })
  .passthrough();
const FRAME = z
  .object({
    id: ID,
    name: z.string().max(500).nullable().optional(),
    x: z.number().min(-100_000).max(100_000),
    y: z.number().min(-100_000).max(100_000),
    width: z.number().min(1).max(10_000),
    height: z.number().min(1).max(10_000),
    children: z.array(ID).max(300).describe('Node or annotation ids inside the frame'),
  })
  .passthrough();
const DIAGRAM_DATA = z
  .object({
    nodes: z.array(NODE).max(300),
    edges: z.array(EDGE).max(600).default([]),
    annotations: z.array(ANNOTATION).max(200).default([]),
    frames: z.array(FRAME).max(50).optional(),
  })
  .describe(
    'The whole diagram. Ids are unique across nodes, edges, annotations and frames. x and y are the top-left corner in pixels; a diagram reads well about 1200 wide, with 60-100 between shapes. Slides use 0-1280 by 0-720. Labels sit inside their shape.',
  );

function same(a, b) {
  return typeof a === 'string' && a.trim().toLowerCase() === b.trim().toLowerCase();
}

/** One record from a list by id or name; several with the same name are an ambiguity. */
function pick(records, wanted) {
  const byId = records.find((r) => r.id === wanted);
  if (byId) return { found: byId };
  const named = records.filter((r) => same(r.name, wanted));
  return named.length === 1 ? { found: named[0] } : { ambiguous: named.length > 1 };
}

function notFound(kind, wanted, records, ambiguous) {
  return {
    app: app.name,
    found: false,
    message: ambiguous
      ? `More than one ${kind} is called "${wanted}". Give its id instead.`
      : `No ${kind} called "${wanted}".`,
    [`${kind}s`]: records.map((r) => ({ id: r.id, name: r.name })),
  };
}

/** A slide by number (1 is the first) or by title. */
function pickSlide(deck, wanted) {
  const n = Number(wanted);
  if (Number.isInteger(n) && String(n) === String(wanted).trim()) {
    const slide = deck.slides[n - 1];
    return slide ? { slide, number: n } : {};
  }
  const i = deck.slides.findIndex((s) => s.id === wanted || same(s.title, String(wanted)));
  return i === -1 ? {} : { slide: deck.slides[i], number: i + 1 };
}

function slideSummary(slide, i) {
  return {
    number: i + 1,
    id: slide.id,
    title: slide.title || undefined,
    notes: slide.notes || undefined,
    shapes: slide.diagramData?.nodes?.length ?? 0,
    updatedAt: slide.updatedAt,
  };
}

/**
 * A preview image, or why there is none. With `wait`, keeps asking for a few seconds while
 * the window draws it (a new or changed record has no current preview until it has).
 */
async function preview(conn, urlPath, { wait = false } = {}) {
  const deadline = Date.now() + (wait ? PREVIEW_WAIT_MS : 0);
  for (;;) {
    let result = null;
    try {
      result = await apiCall(conn, 'GET', urlPath);
    } catch (err) {
      if (!(err instanceof ApiError) || err.status !== 404) throw err;
    }
    if (result && !result.stale) return { image: result };
    if (Date.now() >= deadline) {
      return result
        ? { image: result, note: 'This picture is from before the latest change.' }
        : {
            note: 'No picture yet: DiagramSnap draws it within about 10 seconds. Ask again for it.',
          };
    }
    await new Promise((r) => setTimeout(r, PREVIEW_POLL_MS));
  }
}

function asImage(p) {
  return { data: p.data, mimeType: p.mimeType };
}

/** The reply when an edit is refused because of shapes drawn by hand on the canvas. */
function drawnRefusal(err) {
  return {
    app: app.name,
    changed: false,
    drawnElements: err.body.drawnElements,
    message: `${err.body.drawnElements} thing(s) drawn on the canvas (freehand lines, images or loose text) are not part of the diagram's description and would be removed. Ask the user; only if they agree, send the change again with discardDrawn: true.`,
  };
}

/** A diagramData edit refused because the record changed after the assistant read it. */
function staleRefusal(kind) {
  return {
    app: app.name,
    changed: false,
    message: `The ${kind} has changed since it was read, probably in DiagramSnap's window. Read it again and make the change on the new version.`,
  };
}

async function loadDeck(conn, wanted) {
  const decks = await apiCall(conn, 'GET', '/api/decks');
  const { found, ambiguous } = pick(decks, wanted);
  if (!found) return { missing: notFound('deck', wanted, decks, ambiguous) };
  return { deck: await apiCall(conn, 'GET', `/api/decks/${encodeURIComponent(found.id)}`) };
}

export const tools = [
  {
    name: 'diagramsnap_list',
    description:
      'The diagrams and slide decks in DiagramSnap, newest first: each diagram with how many shapes it has, each deck with how many slides. Search matches the name.',
    input: z.object({ search: z.string().max(100).optional() }),
    async run(input) {
      const conn = await appConnection(app);
      if (!conn.ok) return notAvailable(app, conn);
      const [diagrams, decks] = await Promise.all([
        apiCall(conn, 'GET', '/api/diagrams'),
        apiCall(conn, 'GET', '/api/decks'),
      ]);
      const keep = (r) =>
        !input.search || (r.name ?? '').toLowerCase().includes(input.search.toLowerCase());
      return {
        app: app.name,
        diagrams: diagrams.filter(keep).map((d) => ({
          id: d.id,
          name: d.name,
          shapes: d.nodeCount,
          updatedAt: d.updatedAt,
        })),
        decks: decks.filter(keep).map((d) => ({
          id: d.id,
          name: d.name,
          slides: d.slideCount,
          updatedAt: d.updatedAt,
        })),
      };
    },
  },
  {
    name: 'diagramsnap_diagram',
    description:
      "One DiagramSnap diagram by name or id: its diagramData (every shape, label, connection, text and frame, with positions) and its updatedAt, which a change to it must send back. Shows the diagram as a picture in the chat unless image is false. The picture is DiagramSnap's own drawing of it.",
    input: z.object({
      diagram: z.string().min(1).max(200).describe('Name or id'),
      image: z.boolean().default(true),
    }),
    async run(input) {
      const conn = await appConnection(app);
      if (!conn.ok) return notAvailable(app, conn);
      const diagrams = await apiCall(conn, 'GET', '/api/diagrams');
      const { found, ambiguous } = pick(diagrams, input.diagram);
      if (!found) return notFound('diagram', input.diagram, diagrams, ambiguous);
      const id = encodeURIComponent(found.id);
      const d = await apiCall(conn, 'GET', `/api/diagrams/${id}`);
      const reply = {
        app: app.name,
        found: true,
        id: d.id,
        name: d.name,
        updatedAt: d.updatedAt,
        diagramData: d.diagramData,
      };
      if (!input.image) return reply;
      const p = await preview(conn, `/api/diagrams/${id}/preview`);
      if (p.note) reply.imageNote = p.note;
      return withImages(reply, p.image ? [asImage(p.image)] : []);
    },
  },
  {
    name: 'diagramsnap_deck',
    description:
      "One DiagramSnap slide deck by name or id. Without a slide: the deck's slides with their titles and notes, and pictures of the first slides if images is true. With a slide (its number, 1 for the first, or its title): that slide's diagramData and a picture of it. updatedAt is the deck's, which any change to the deck or its slides must send back.",
    input: z.object({
      deck: z.string().min(1).max(200).describe('Name or id'),
      slide: z.union([z.number().int().min(1), z.string().min(1).max(200)]).optional(),
      images: z
        .boolean()
        .optional()
        .describe(`Defaults to true for one slide, false for the whole deck (up to ${MAX_IMAGES})`),
    }),
    async run(input) {
      const conn = await appConnection(app);
      if (!conn.ok) return notAvailable(app, conn);
      const { deck, missing } = await loadDeck(conn, input.deck);
      if (missing) return missing;
      const base = { app: app.name, found: true, id: deck.id, name: deck.name };
      const slidePreview = (s) =>
        `/api/decks/${encodeURIComponent(deck.id)}/slides/${encodeURIComponent(s.id)}/preview`;
      if (input.slide !== undefined) {
        const { slide, number } = pickSlide(deck, input.slide);
        if (!slide) {
          return {
            ...base,
            found: false,
            message: `No slide ${typeof input.slide === 'number' ? input.slide : `"${input.slide}"`} in ${deck.name}.`,
            slides: deck.slides.map(slideSummary),
          };
        }
        const reply = {
          ...base,
          updatedAt: deck.updatedAt,
          slide: { ...slideSummary(slide, number - 1), diagramData: slide.diagramData },
        };
        if (input.images === false) return reply;
        const p = await preview(conn, slidePreview(slide));
        if (p.note) reply.imageNote = p.note;
        return withImages(reply, p.image ? [asImage(p.image)] : []);
      }
      const reply = { ...base, updatedAt: deck.updatedAt, slides: deck.slides.map(slideSummary) };
      if (!input.images) return reply;
      const shown = deck.slides.slice(0, MAX_IMAGES);
      const previews = await Promise.all(shown.map((s) => preview(conn, slidePreview(s))));
      const missingPictures = previews
        .map((p, i) => (p.image ? null : i + 1))
        .filter((n) => n !== null);
      if (missingPictures.length) {
        reply.imageNote = `No picture yet for slide(s) ${missingPictures.join(', ')}.`;
      }
      if (deck.slides.length > MAX_IMAGES) {
        reply.imageNote = [reply.imageNote, `Pictures of the first ${MAX_IMAGES} slides only.`]
          .filter(Boolean)
          .join(' ');
      }
      return withImages(
        reply,
        previews.filter((p) => p.image).map((p) => asImage(p.image)),
      );
    },
  },
  {
    name: 'diagramsnap_create_diagram',
    description:
      'Create a diagram in DiagramSnap from a diagramData description: shapes (nodes), the arrows or lines between them (edges), free text (annotations) and containers (frames). DiagramSnap lays out the connectors and draws it with its own theme; the reply includes a picture once it has (within about 10 seconds; it waits for it unless image is false). Lay shapes out on a grid, top to bottom or left to right, sized so the label fits.',
    input: z.object({
      name: z.string().trim().min(1).max(200),
      diagramData: DIAGRAM_DATA,
      image: z.boolean().default(true),
    }),
    write: true,
    async run(input) {
      const conn = await appConnection(app);
      if (!conn.ok) return notAvailable(app, conn);
      const created = await apiCall(conn, 'POST', '/api/diagrams', {
        name: input.name,
        diagramData: input.diagramData,
      });
      const reply = {
        app: app.name,
        created: true,
        id: created.id,
        name: created.name,
        updatedAt: created.updatedAt,
      };
      if (!input.image) return reply;
      const p = await preview(conn, `/api/diagrams/${encodeURIComponent(created.id)}/preview`, {
        wait: true,
      });
      if (p.note) reply.imageNote = p.note;
      return withImages(reply, p.image ? [asImage(p.image)] : []);
    },
  },
  {
    name: 'diagramsnap_update_diagram',
    description:
      'Change a DiagramSnap diagram: rename it, or replace its diagramData. Read it first with diagramsnap_diagram, change what is needed, and send the whole diagramData back with the updatedAt that read returned (baseModified); keep the ids, positions and sizes of shapes that are not changing, since DiagramSnap redraws the diagram from what is sent. If the user has changed it since, nothing is changed and the reply says to read it again. The reply includes a picture of the result unless image is false.',
    input: z.object({
      diagram: z.string().min(1).max(200).describe('Name or id'),
      baseModified: z
        .number()
        .optional()
        .describe('The updatedAt from diagramsnap_diagram; required with diagramData'),
      name: z.string().trim().min(1).max(200).optional().describe('New name'),
      diagramData: DIAGRAM_DATA.optional(),
      discardDrawn: z
        .boolean()
        .optional()
        .describe('Only after the user agrees to lose things drawn by hand on the canvas'),
      image: z.boolean().default(true),
    }),
    write: true,
    async run(input) {
      if (input.name === undefined && input.diagramData === undefined) {
        return { app: app.name, changed: false, message: 'Nothing to change.' };
      }
      if (input.diagramData !== undefined && input.baseModified === undefined) {
        return {
          app: app.name,
          changed: false,
          message: 'Read the diagram first and send its updatedAt as baseModified.',
        };
      }
      const conn = await appConnection(app);
      if (!conn.ok) return notAvailable(app, conn);
      const diagrams = await apiCall(conn, 'GET', '/api/diagrams');
      const { found, ambiguous } = pick(diagrams, input.diagram);
      if (!found) return notFound('diagram', input.diagram, diagrams, ambiguous);
      const id = encodeURIComponent(found.id);
      // A rename alone builds on nothing the assistant read, so the current stamp will do.
      const body = { baseModified: input.baseModified ?? found.updatedAt };
      if (input.name !== undefined) body.name = input.name;
      if (input.diagramData !== undefined) body.diagramData = input.diagramData;
      if (input.discardDrawn) body.discardDrawn = true;
      let updated;
      try {
        updated = await apiCall(conn, 'PUT', `/api/diagrams/${id}`, body);
      } catch (err) {
        if (err instanceof ApiError && err.status === 409) {
          return err.body?.drawnElements ? drawnRefusal(err) : staleRefusal('diagram');
        }
        throw err;
      }
      const reply = {
        app: app.name,
        changed: true,
        id: found.id,
        name: updated.name ?? input.name ?? found.name,
        updatedAt: updated.updatedAt,
      };
      if (!input.image || input.diagramData === undefined) return reply;
      const p = await preview(conn, `/api/diagrams/${id}/preview`, { wait: true });
      if (p.note) reply.imageNote = p.note;
      return withImages(reply, p.image ? [asImage(p.image)] : []);
    },
  },
  {
    name: 'diagramsnap_create_deck',
    description:
      "Create a slide deck in DiagramSnap. Each slide has a title, speaker notes and optionally a diagramData drawing in slide coordinates (0-1280 wide, 0-720 high; put any heading text in an annotation near the top). The deck uses DiagramSnap's default theme. The reply includes pictures of the first slides once DiagramSnap has drawn them, unless images is false.",
    input: z.object({
      name: z.string().trim().min(1).max(200),
      slides: z
        .array(
          z.object({
            title: z.string().max(200).optional(),
            notes: z.string().max(10_000).optional(),
            diagramData: DIAGRAM_DATA.optional(),
          }),
        )
        .min(1)
        .max(100),
      images: z.boolean().default(true),
    }),
    write: true,
    async run(input) {
      const conn = await appConnection(app);
      if (!conn.ok) return notAvailable(app, conn);
      const created = await apiCall(conn, 'POST', '/api/decks', {
        name: input.name,
        slides: input.slides,
      });
      const reply = {
        app: app.name,
        created: true,
        id: created.id,
        name: created.name ?? input.name,
        slides: created.slideIds?.length ?? input.slides.length,
      };
      if (!input.images) return reply;
      const ids = (created.slideIds ?? []).slice(0, MAX_IMAGES);
      const deckId = encodeURIComponent(created.id);
      const previews = [];
      // One at a time: the first wait covers the window drawing them all.
      for (const sid of ids) {
        previews.push(
          await preview(conn, `/api/decks/${deckId}/slides/${encodeURIComponent(sid)}/preview`, {
            wait: previews.length === 0,
          }),
        );
      }
      if (previews.some((p) => !p.image)) {
        reply.imageNote =
          'Some pictures are not drawn yet; ask for the deck again in a few seconds.';
      }
      return withImages(
        reply,
        previews.filter((p) => p.image).map((p) => asImage(p.image)),
      );
    },
  },
  {
    name: 'diagramsnap_add_slide',
    description:
      'Add a slide to a DiagramSnap deck, at the end or at a position (1 puts it first). Same slide fields as diagramsnap_create_deck. The reply includes a picture of the new slide unless image is false.',
    input: z.object({
      deck: z.string().min(1).max(200).describe('Name or id'),
      title: z.string().max(200).optional(),
      notes: z.string().max(10_000).optional(),
      diagramData: DIAGRAM_DATA.optional(),
      position: z.number().int().min(1).optional().describe('Where it goes; default the end'),
      image: z.boolean().default(true),
    }),
    write: true,
    async run(input) {
      const conn = await appConnection(app);
      if (!conn.ok) return notAvailable(app, conn);
      // Adding a slide builds on nothing already in the deck, so after a clash with the user's
      // own save it is safe to read the deck again and add it once more.
      for (let attempt = 0; ; attempt++) {
        const { deck, missing } = await loadDeck(conn, input.deck);
        if (missing) return missing;
        const body = { baseModified: deck.updatedAt };
        for (const k of ['title', 'notes', 'diagramData']) {
          if (input[k] !== undefined) body[k] = input[k];
        }
        if (input.position !== undefined) {
          body.position = Math.min(input.position - 1, deck.slides.length);
        }
        let added;
        try {
          added = await apiCall(
            conn,
            'POST',
            `/api/decks/${encodeURIComponent(deck.id)}/slides`,
            body,
          );
        } catch (err) {
          if (err instanceof ApiError && err.status === 409 && attempt === 0) continue;
          throw err;
        }
        const reply = {
          app: app.name,
          added: true,
          deck: deck.name,
          slideId: added.slideId,
          number: (body.position ?? deck.slides.length) + 1,
          updatedAt: added.updatedAt,
        };
        if (!input.image) return reply;
        const p = await preview(
          conn,
          `/api/decks/${encodeURIComponent(deck.id)}/slides/${encodeURIComponent(added.slideId)}/preview`,
          { wait: true },
        );
        if (p.note) reply.imageNote = p.note;
        return withImages(reply, p.image ? [asImage(p.image)] : []);
      }
    },
  },
  {
    name: 'diagramsnap_update_slide',
    description:
      "Change a slide in a DiagramSnap deck: its title, notes, or its diagramData drawing (replaced whole: read the slide with diagramsnap_deck first, change what is needed, and send it back with the deck's updatedAt as baseModified). Title and notes alone need no baseModified. If the deck has changed since it was read, nothing is changed and the reply says to read it again.",
    input: z.object({
      deck: z.string().min(1).max(200).describe('Name or id'),
      slide: z
        .union([z.number().int().min(1), z.string().min(1).max(200)])
        .describe('Its number (1 for the first) or its title'),
      baseModified: z
        .number()
        .optional()
        .describe("The deck's updatedAt from diagramsnap_deck; required with diagramData"),
      title: z.string().max(200).optional(),
      notes: z.string().max(10_000).optional(),
      diagramData: DIAGRAM_DATA.optional(),
      discardDrawn: z
        .boolean()
        .optional()
        .describe('Only after the user agrees to lose things drawn by hand on the slide'),
      image: z.boolean().default(true),
    }),
    write: true,
    async run(input) {
      if (['title', 'notes', 'diagramData'].every((k) => input[k] === undefined)) {
        return { app: app.name, changed: false, message: 'Nothing to change.' };
      }
      if (input.diagramData !== undefined && input.baseModified === undefined) {
        return {
          app: app.name,
          changed: false,
          message: "Read the slide first and send the deck's updatedAt as baseModified.",
        };
      }
      const conn = await appConnection(app);
      if (!conn.ok) return notAvailable(app, conn);
      // Title and notes are set, not built on what was read, so they may retry once after a
      // clash with the user's own save; a drawing never does.
      const retries = input.diagramData === undefined ? 1 : 0;
      for (let attempt = 0; ; attempt++) {
        const { deck, missing } = await loadDeck(conn, input.deck);
        if (missing) return missing;
        const { slide, number } = pickSlide(deck, input.slide);
        if (!slide) {
          return {
            app: app.name,
            changed: false,
            message: `No slide ${typeof input.slide === 'number' ? input.slide : `"${input.slide}"`} in ${deck.name}.`,
            slides: deck.slides.map(slideSummary),
          };
        }
        const body = { baseModified: input.baseModified ?? deck.updatedAt };
        for (const k of ['title', 'notes', 'diagramData']) {
          if (input[k] !== undefined) body[k] = input[k];
        }
        if (input.discardDrawn) body.discardDrawn = true;
        const slidePath = `/api/decks/${encodeURIComponent(deck.id)}/slides/${encodeURIComponent(slide.id)}`;
        let updated;
        try {
          updated = await apiCall(conn, 'PUT', slidePath, body);
        } catch (err) {
          if (err instanceof ApiError && err.status === 409) {
            if (err.body?.drawnElements) return drawnRefusal(err);
            if (attempt < retries) continue;
            return staleRefusal('deck');
          }
          throw err;
        }
        const reply = {
          app: app.name,
          changed: true,
          deck: deck.name,
          slide: number,
          updatedAt: updated.updatedAt,
        };
        if (!input.image || input.diagramData === undefined) return reply;
        const p = await preview(conn, `${slidePath}/preview`, { wait: true });
        if (p.note) reply.imageNote = p.note;
        return withImages(reply, p.image ? [asImage(p.image)] : []);
      }
    },
  },
];

/** DiagramSnap has nothing that falls due. */
export async function attention() {
  return { app: app.name, available: true, items: [] };
}
