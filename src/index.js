#!/usr/bin/env node
// Tiong Creative assistant: an MCP server over stdio that lets the assistant running it
// (Claude Desktop, Claude Code) use the Tiong Creative apps on this Mac.
//
// It opens no network listener. Each app is reached on 127.0.0.1 with a token the app
// writes only while its "Allow assistant access" setting is on (src/connection.js).
// Tools that change data say so in their description and return what they changed.
import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { ApiError, isInstalled } from './connection.js';
import * as dueAgain from './apps/due-again.js';
import * as giftKeeper from './apps/gift-keeper.js';
import * as clientManager from './apps/client-manager.js';
import * as listsAndNotes from './apps/lists-and-notes.js';

const { version } = createRequire(import.meta.url)('../package.json');

// One entry per app. Add an app by adding a module with the same shape.
const ALL_APPS = [dueAgain, giftKeeper, clientManager, listsAndNotes];
// Only apps present on this Mac get tools, so the assistant never points the user at an
// app they do not have. Checked once at start-up: install an app, restart the assistant.
const APPS = ALL_APPS.filter((a) => isInstalled(a.app));
const MISSING = ALL_APPS.filter((a) => !isInstalled(a.app)).map((a) => a.app.name);

function text(value) {
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] };
}

function failure(err) {
  const message =
    err instanceof ApiError
      ? `${err.message}${err.problems?.length ? ': ' + err.problems.join('; ') : ''}`
      : err?.message || String(err);
  return { isError: true, content: [{ type: 'text', text: message }] };
}

const server = new McpServer({ name: 'tiongcreative-assistant', version });

server.registerTool(
  'whats_on',
  {
    title: "What's on",
    description:
      'Everything coming up across the Tiong Creative apps on this Mac within a number of days: overdue and due items, with the app each one belongs to. Start here for "what needs my attention".',
    inputSchema: {
      days: z.number().int().min(0).max(365).default(14).describe('How far ahead to look'),
    },
  },
  async ({ days }) => {
    const sections = await Promise.all(APPS.map((a) => a.attention(days)));
    const items = sections
      .flatMap((s) => s.items)
      .sort((a, b) => (a.daysUntilDue ?? 0) - (b.daysUntilDue ?? 0));
    const unavailable = sections
      .filter((s) => !s.available)
      .map((s) => ({ app: s.app, reason: s.reason }));
    return text({
      days,
      count: items.length,
      items,
      unavailable,
      ...(APPS.length === 0
        ? {
            note: `No Tiong Creative apps are installed on this Mac. The assistant works with: ${MISSING.join(', ')}.`,
          }
        : {}),
    });
  },
);

server.registerTool(
  'open_app',
  {
    title: 'Open an app',
    description:
      'Opens one of the Tiong Creative apps on this Mac so its tools can be used. Only call this after the user has agreed to open it.',
    inputSchema: {
      app: z.enum(APPS.length ? APPS.map((a) => a.app.id) : ['none']),
    },
  },
  async ({ app }) => {
    const entry = APPS.find((a) => a.app.id === app);
    if (!entry) return failure(new Error('That app is not installed on this Mac.'));
    await new Promise((resolve, reject) => {
      execFile('open', ['-a', entry.app.bundleName], (err) => (err ? reject(err) : resolve()));
    });
    return text({ app: entry.app.name, opened: true, note: 'Give it a few seconds to start.' });
  },
);

for (const { tools } of APPS) {
  for (const tool of tools) {
    server.registerTool(
      tool.name,
      {
        description: tool.description,
        inputSchema: tool.input.shape,
        annotations: tool.write
          ? { readOnlyHint: false, destructiveHint: false, idempotentHint: false }
          : { readOnlyHint: true },
      },
      async (input) => {
        try {
          return text(await tool.run(tool.input.parse(input)));
        } catch (err) {
          return failure(err);
        }
      },
    );
  }
}

await server.connect(new StdioServerTransport());
