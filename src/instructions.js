// The server's instructions: sent once when the assistant connects, and added to its
// context by clients that support them (Claude Desktop, Claude Code). They give the map the
// tool list cannot: which tool does which job, and the rules that hold across apps. Kept
// short because the client keeps them in context for every message; how an app works belongs elsewhere.
// Each app module exports its own `instructions` line next to its tools, so a new tool and
// its line change together, and tests/instructions.test.js checks every tool named exists.

const COMMON = [
  "Tools for the Tiong Creative apps on this Mac. Each app's tools start with its name; before telling the user something cannot be done, check all of that app's tools, not only the closest match.",
  "Start with whats_on for anything coming up across the apps. assistant_info gives this server's version and each app's version, where to check for the latest version. When the user reports a problem or wishes something worked differently or did more, offer feedback, which drafts a note for them to send.",
  'An app that is closed or has assistant access turned off is reported as unavailable: tell the user, and call open_app only after they agree.',
  'For a common job (what can you do, adding things from an email or message, checking a statement, money owed, what is coming up, planning gifts, tidying notes, turning a note into a diagram), call routine first and follow its steps.',
  'Before several changes from one source (a statement, a document, a pasted list), show the proposed changes and wait for the user to agree.',
  'Nothing here deletes. Names (lists, notes, people, clients, categories) match ignoring case; when one does not match, the reply lists what exists, so pick from it or ask the user.',
];

/** The instructions text for the apps installed on this Mac. */
export function buildInstructions(apps) {
  return [...COMMON, '', ...apps.map((a) => a.instructions).filter(Boolean)].join('\n');
}
