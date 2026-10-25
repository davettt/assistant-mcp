// The server's instructions: sent once when the assistant connects, and added to its
// context by clients that support them (Claude Desktop, Claude Code). They give the map the
// tool list cannot: which tool does which job, and the rules that hold across apps. Kept
// short because the client resends them every turn; how an app works belongs elsewhere.
// Each app module exports its own `instructions` line next to its tools, so a new tool and
// its line change together, and tests/instructions.test.js checks every tool named exists.

const COMMON = [
  "Tools for the Tiong Creative apps on this Mac. Each app's tools start with its name; before telling the user something cannot be done, check all of that app's tools, not only the closest match.",
  'Start with whats_on for anything coming up across the apps.',
  'An app that is closed or has assistant access turned off is reported as unavailable: tell the user, and call open_app only after they agree.',
  'Nothing here deletes. Names (lists, notes, people, clients, categories) match ignoring case; when one does not match, the reply lists what exists, so pick from it or ask the user.',
];

/** The instructions text for the apps installed on this Mac. */
export function buildInstructions(apps) {
  return [...COMMON, '', ...apps.map((a) => a.instructions).filter(Boolean)].join('\n');
}
