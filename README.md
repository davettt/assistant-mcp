# Tiong Creative assistant (MCP server)

Lets an AI assistant on your Mac, such as Claude Desktop, use your Tiong Creative apps while
they are open. Ask "what's on this month" and it reads Due Again, Gift Keeper, Client Manager and Lists & Notes; say "mark the car insurance
done" and Due Again records it and works out the next date, the same as if you had clicked.

It only works with the apps, and only while each app has **Settings → Assistant → Allow
assistant access** turned on. With it off, or the app closed, the assistant is told so and
nothing else happens.

## Apps

| App                           | Reads                                                                                                            | Changes                                                                                    |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Due Again 1.1.0 or later      | items with status and next due date, an item's history                                                           | add an item, record that an item was done                                                  |
| Gift Keeper 1.3.0 or later    | people with interests, sizes and preferences; upcoming occasions with budget, spend and whether a gift is chosen | add a gift idea for a person, mark a gift as given                                         |
| Client Manager 1.6.0 or later | pending reminders, open tasks, invoices owing with totals and balance, one client with their jobs                | add a client, a job, a reminder or a task, change a job, task or reminder, log an activity |
| Lists & Notes 1.22.0 or later | lists with their items, notes with previews, the full text of a note                                             | nothing yet                                                                                |

More apps follow, and the assistant can also open an app for you, but only after you agree.

## Setup

You need Node.js and Claude Desktop. If you do not have Node.js, install it from
nodejs.org (the LTS download), which also gives you the `npx` command used below.

Open Terminal and run:

```
npx @tiongcreative/assistant-mcp install
```

It adds the assistant to Claude Desktop's settings and keeps a backup of the previous file.
Then quit Claude Desktop completely, open it again, and allow the "tiongcreative" server the
first time it asks. In each app, turn on **Allow assistant access** in Settings. With the apps
open, ask Claude what's on this week.

The assistant only offers tools for the apps installed on your Mac, checked when Claude
Desktop starts it, so after installing another app restart Claude Desktop once.

To remove it: `npx @tiongcreative/assistant-mcp uninstall`. To check: `npx @tiongcreative/assistant-mcp status`.

For Claude Code: `claude mcp add tiongcreative -- npx -y @tiongcreative/assistant-mcp`.

## How it stays on your Mac

- The server opens no network connection of its own. It talks to each app on 127.0.0.1 only.
- While assistant access is on, the app writes a small file in its own data folder holding its
  port and a token made fresh for that launch, readable only by your user account. The server
  reads it and sends the token with each request. The file is removed when you turn the setting
  off or quit the app, so there is nothing to copy or store.
- What the assistant reads goes to whichever AI service it uses. Turn access on only for an
  assistant you trust.
- The package holds no secrets and never contacts tiongcreative.com.au.

## Development

```bash
npm install
npm test            # needs ../due-again checked out: runs its server on a temp data folder
npm run validate
```

Registering a local checkout with Claude Code: `claude mcp add tiongcreative -- node /path/to/src/index.js`.

## Licence

Released under the MIT licence.
