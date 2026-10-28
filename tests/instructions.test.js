// The server's instructions name tools; a renamed or removed tool must not leave a stale
// name behind, and every app must say which of its tools does which job.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildInstructions } from '../src/instructions.js';
import * as dueAgain from '../src/apps/due-again.js';
import * as giftKeeper from '../src/apps/gift-keeper.js';
import * as clientManager from '../src/apps/client-manager.js';
import * as listsAndNotes from '../src/apps/lists-and-notes.js';
import * as budgetPlanner from '../src/apps/budget-planner.js';
import * as diagramSnap from '../src/apps/diagramsnap.js';

const ALL = [dueAgain, giftKeeper, clientManager, listsAndNotes, budgetPlanner, diagramSnap];
const SERVER_TOOLS = ['whats_on', 'open_app', 'assistant_info'];
const toolNames = (text) => text.match(/\b[a-z]+(?:_[a-z]+)+\b/g) ?? [];

describe('server instructions', () => {
  it('give every app a line', () => {
    for (const m of ALL) assert.ok(m.instructions?.startsWith(m.app.name), m.app.name);
  });

  it('name only tools that exist', () => {
    const known = new Set([...SERVER_TOOLS, ...ALL.flatMap((m) => m.tools.map((t) => t.name))]);
    for (const name of toolNames(buildInstructions(ALL))) assert.ok(known.has(name), name);
  });

  it('name only tools of the same app in each app line', () => {
    for (const m of ALL) {
      const own = new Set(m.tools.map((t) => t.name));
      for (const name of toolNames(m.instructions))
        assert.ok(own.has(name), `${m.app.name}: ${name}`);
    }
  });

  it('name sibling tools in descriptions only when they exist', () => {
    for (const m of ALL) {
      const own = new Set(m.tools.map((t) => t.name));
      for (const t of m.tools) {
        for (const name of toolNames(t.description).filter((n) =>
          n.startsWith(m.app.id.replace(/-/g, '_')),
        )) {
          assert.ok(own.has(name), `${t.name} mentions ${name}`);
        }
      }
    }
  });

  it('leave out apps that are not installed', () => {
    const text = buildInstructions([listsAndNotes]);
    assert.match(text, /lists_and_notes_update_note/);
    assert.doesNotMatch(text, /due_again_/);
  });
});
