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
import { ApiError, IMAGES, appConnection, isInstalled, olderThan } from './connection.js';
import { runCli } from './install.js';
import { buildInstructions } from './instructions.js';
import * as dueAgain from './apps/due-again.js';
import * as giftKeeper from './apps/gift-keeper.js';
import * as clientManager from './apps/client-manager.js';
import * as listsAndNotes from './apps/lists-and-notes.js';
import * as budgetPlanner from './apps/budget-planner.js';
import * as diagramSnap from './apps/diagramsnap.js';

const { version } = createRequire(import.meta.url)('../package.json');

// `npx @tiongcreative/assistant-mcp install|uninstall|status` is the member's setup path.
// With no command, this process is the MCP server Claude Desktop launches.
if (process.argv.length > 2) {
  process.exit(runCli(process.argv.slice(2)));
}

// One entry per app. Add an app by adding a module with the same shape.
const ALL_APPS = [dueAgain, giftKeeper, clientManager, listsAndNotes, budgetPlanner, diagramSnap];
// Only apps present on this Mac get tools, so the assistant never points the user at an
// app they do not have. Checked once at start-up: install an app, restart the assistant.
const APPS = ALL_APPS.filter((a) => isInstalled(a.app));
const MISSING = ALL_APPS.filter((a) => !isInstalled(a.app)).map((a) => a.app.name);

// A tool's reply as JSON text, followed by any images it attached (withImages), which the
// chat shows as pictures.
function text(value) {
  const images = (value && value[IMAGES]) || [];
  return {
    content: [
      { type: 'text', text: JSON.stringify(value, null, 2) },
      ...images.map((i) => ({ type: 'image', data: i.data, mimeType: i.mimeType })),
    ],
  };
}

function failure(err) {
  const message =
    err instanceof ApiError
      ? `${err.message}${err.problems?.length ? ': ' + err.problems.join('; ') : ''}`
      : err?.message || String(err);
  return { isError: true, content: [{ type: 'text', text: message }] };
}

const server = new McpServer(
  { name: 'tiongcreative-assistant', version },
  { instructions: buildInstructions(APPS) },
);

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

server.registerTool(
  'assistant_info',
  {
    title: 'About this assistant',
    description:
      'This Tiong Creative assistant server: its version, each app on this Mac with its version and whether it can be reached now, the tools each app has here, and anything that needs a newer app. Use it to check which version is connected or why a tool says an app needs updating.',
    inputSchema: {},
    annotations: { readOnlyHint: true },
  },
  async () => {
    const apps = await Promise.all(
      APPS.map(async (a) => {
        const conn = await appConnection(a.app);
        const known = conn.ok && conn.version;
        return {
          app: a.app.name,
          available: conn.ok,
          reason: conn.ok ? undefined : conn.reason,
          version: conn.ok ? (conn.version ?? 'unknown') : undefined,
          tools: a.tools.map((t) => t.name),
          needsNewerApp: known
            ? (a.needs ?? [])
                .filter((n) => olderThan(conn.version, n.version))
                .map((n) => `${n.for}: needs ${a.app.name} ${n.version}`)
            : undefined,
        };
      }),
    );
    return text({
      server: { name: 'tiongcreative-assistant', package: '@tiongcreative/assistant-mcp', version },
      node: process.version,
      apps,
      notInstalled: MISSING,
      note: 'A newer version of this server reaches the assistant when the AI app is restarted.',
    });
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
