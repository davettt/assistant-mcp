// Prompts: starters the user picks from the AI app's menu (in Claude Desktop, + then "Add from tiongcreative"),
// not something the model sees on its own. Each one holds a whole routine (which tools, in
// what order, when to stop and ask), which is too long for the instructions the client
// resends every turn. A prompt is offered only when every app it needs is installed; one
// with no `apps` needs any app. tests/prompts.test.js checks every tool named exists.
import { z } from 'zod';

const WHOLE_NUMBER = /^\d{1,3}$/;
const days = (value, fallback) => (WHOLE_NUMBER.test(value ?? '') ? Number(value) : fallback);

export const PROMPTS = [
  {
    name: 'attention_this_week',
    title: 'What needs my attention this week',
    description: 'Everything overdue or due in the next 7 days across the apps, grouped by app.',
    apps: [],
    text: () =>
      [
        'What needs my attention this week across my Tiong Creative apps?',
        'Call whats_on with days 7. Show overdue items first, then the rest by date, grouped by app, with how many days until each is due.',
        'If an app is unavailable, say which and why, and offer to open it (open_app) rather than opening it.',
        'Then offer to deal with items one at a time (mark done, skip, reschedule), and change nothing until I say which.',
      ].join('\n'),
  },
  {
    name: 'check_statement',
    title: 'Check a statement against my budget',
    description:
      'Compare a bank or card statement (a screenshot, PDF or CSV export, attached or pasted) with the recurring expenses in Budget Planner, propose the changes, and make them once you agree.',
    apps: ['budget-planner'],
    text: () =>
      [
        "I'm attaching a bank or card statement (screenshots, a PDF, a CSV export or pasted text). Read every page or file I attach; a CSV has one transaction per row, so find the date, description and amount columns first. Check it against my Budget Planner expenses.",
        '1. Call budget_planner_expenses first, so you match the statement against the names I already use and add nothing twice.',
        '2. Read the statement. Budget Planner holds recurring expenses, not every purchase, so look for: bills and subscriptions whose amount changed; recurring charges that are not in the budget; budget items that no longer appear (possibly cancelled; ask, since some are paid less often than monthly); and spending with no set day (groceries, fuel, eating out) running well above or below its estimate.',
        '3. Show me a table of proposed changes: expense, what the statement shows, what you would change, and the date. Wait for my OK, and leave out anything I reject.',
        '4. Then make the changes I agreed to. A new amount: budget_planner_update_expense with amount and from set to the date of the first charge at the new price, so earlier months keep the old amount. A new recurring charge: budget_planner_add_expense; bills and subscriptions paid on a date stay Fixed (estimate off), annual ones included. Something cancelled: budget_planner_update_expense with endDate. Nothing is deleted.',
        '5. If the statement shows a closing balance for an account I track, offer budget_planner_update_balances with asOf set to the statement date.',
        '6. Finish with budget_planner_budget for the month and say how the surplus changed. Give the figures as the tool returns them rather than working them out.',
        'Use the dates on the statement, not today. Changing how often an expense is paid, or adding a category, is done in the app: tell me rather than working around it.',
      ].join('\n'),
  },
  {
    name: 'review_month_budget',
    title: "Review this month's budget",
    description:
      "This month's income, expenses and surplus in Budget Planner, and what is due soon.",
    apps: ['budget-planner'],
    text: () =>
      [
        "Review this month's budget in Budget Planner.",
        'Call budget_planner_budget with period monthly, and budget_planner_upcoming with days 31.',
        'Give income, expenses and the surplus as the tool returns them, then the biggest categories, then what is due in the rest of the month. Do not work the figures out yourself.',
        'Point out anything that looks out of date (an amount that may have changed, an item that may have ended), and change nothing until I agree.',
      ].join('\n'),
  },
  {
    name: 'plan_gifts',
    title: 'Plan gifts for upcoming occasions',
    description:
      'Upcoming occasions in Gift Keeper, what is sorted, and ideas that could become gifts.',
    apps: ['gift-keeper'],
    args: {
      days: z.string().optional().describe('How many days ahead to look (default 60)'),
    },
    text: (args) =>
      [
        `Help me plan gifts for the occasions coming up in the next ${days(args?.days, 60)} days in Gift Keeper.`,
        `Call gift_keeper_upcoming with withinDays ${days(args?.days, 60)}, then gift_keeper_gifts and gift_keeper_ideas.`,
        "For each occasion, say who it is for, the budget, and whether a gift is chosen and where it is up to (ordered, bought, wrapped). Where nothing is chosen, list that person's saved ideas.",
        'Suggest which ideas to turn into gifts (gift_keeper_promote_idea) or which gifts to move along (gift_keeper_update_gift), and change nothing until I say which.',
      ].join('\n'),
  },
  {
    name: 'tidy_notes',
    title: 'Tidy my notes',
    description:
      'Look over the categories, lists and notes in Lists & Notes and suggest moves, merges and archiving.',
    apps: ['lists-and-notes'],
    text: () =>
      [
        'Help me tidy Lists & Notes.',
        'Call lists_and_notes_categories, lists_and_notes_lists and lists_and_notes_notes.',
        'Suggest: notes or lists in the wrong category, near-duplicates that could be combined, lists that are fully ticked or look finished, and categories that are empty or overlap. Show the suggestions as a table and wait for my OK.',
        "Then make the changes I agreed to: lists_and_notes_move to move or archive a list or note, lists_and_notes_update_note to change a note's text or title, lists_and_notes_rename_category for a category name. Archive rather than delete; nothing here deletes.",
      ].join('\n'),
  },
  {
    name: 'getting_started',
    title: 'What can you do with my apps?',
    description:
      'A short tour: which apps are connected, what you can ask for in each, and the routines you can run.',
    apps: [],
    text: () =>
      [
        'What can you help me with in my Tiong Creative apps?',
        'Call assistant_info. For each app that is available, give one line on what I can ask for, with a real example in my own words (for example "what do I owe this month?"), not tool names. Say which apps are closed or have assistant access off, and how to turn it on (Settings, "Allow assistant access").',
        'Then list the routines from assistant_info by title and say I can ask for any of them in plain words.',
        'Mention that nothing here deletes, that you will ask before changing several things at once, and that I can say "send feedback" if something does not work.',
        'Keep it short, and change nothing.',
      ].join('\n'),
  },
  {
    name: 'add_from_text',
    title: 'Add things from an email or message',
    description:
      'Paste an email, booking confirmation, receipt or message; the assistant works out what belongs in which app and adds it once you agree.',
    apps: [],
    text: () =>
      [
        "I'm pasting (or attaching) an email, booking confirmation, receipt or message. Work out what in it belongs in my apps.",
        'Use only the apps that have tools here. A renewal, appointment or service that comes round again: Due Again (due_again_add_item). A bill or subscription that is part of the budget: Budget Planner (budget_planner_add_expense). Work for a client: Client Manager (client_manager_add_task, client_manager_add_reminder or client_manager_log_activity). A gift idea for someone: Gift Keeper (gift_keeper_add_idea). Items to buy or do: Lists & Notes (lists_and_notes_add_items).',
        'Before suggesting a new record, check it is not already there (due_again_items, budget_planner_expenses, client_manager_client, gift_keeper_ideas, lists_and_notes_lists).',
        'Show a table: what you found, which app, and the record you would add or change, with its date and amount. Wait for my OK and leave out anything I reject.',
        'Then add the ones I agreed to and say what was added. Dates come from the text, not today; if a date or amount is unclear, ask rather than guess.',
      ].join('\n'),
  },
  {
    name: 'chase_invoices',
    title: 'Who owes me money',
    description:
      'Unpaid and overdue invoices in Client Manager, oldest first, with a draft follow-up for each client.',
    apps: ['client-manager'],
    args: {
      client: z.string().optional().describe('Only this client'),
    },
    text: (args) =>
      [
        args?.client
          ? `Who owes me money? Only for the client ${args.client}.`
          : 'Who owes me money?',
        `Call client_manager_invoices with status owing${args?.client ? ` and client ${args.client}` : ''}. Group by client, overdue first, then oldest first. For each, give the invoice number, the balance and how many days overdue it is. Add up the total owing as the invoices show it.`,
        'For each client with something overdue, draft a short, friendly follow-up I can send myself (email or text), naming the invoices and balances. Do not send anything; there is no tool for that.',
        'After I say I have sent one, offer to log it on the client (client_manager_log_activity, type email). Payments are recorded in the app; invoices cannot be changed from here.',
      ].join('\n'),
  },
  {
    name: 'client_week',
    title: 'Plan my client week',
    description:
      'Client Manager reminders and tasks due in the next 7 days, plus overdue invoices, in one plan.',
    apps: ['client-manager'],
    text: () =>
      [
        'Help me plan my client work for the next 7 days.',
        'Call client_manager_reminders and client_manager_tasks, each with withinDays 7, and client_manager_invoices with status overdue.',
        'Give one list by day: overdue and high-priority items first, each with the client and job. Then the overdue invoices in a line each.',
        'Offer, one item at a time, to complete or snooze a reminder (client_manager_update_reminder), move a task along (client_manager_update_task), or log a call, meeting or email that happened (client_manager_log_activity). Change nothing until I say which.',
      ].join('\n'),
  },
  {
    name: 'month_ahead',
    title: "What's coming up this month",
    description:
      'Renewals, appointments and other Due Again items in the next 31 days, by week, with expected costs.',
    apps: ['due-again'],
    text: () =>
      [
        "What's coming up in Due Again over the next month?",
        "Call due_again_items with withinDays 31. Group by week, overdue first, with each item's due date, category and expected cost. Mark costs that vary as estimates, and give a total of the expected costs, saying it includes estimates if any do.",
        'Point out anything overdue and anything with no expected cost.',
        'Then offer, one item at a time: done (due_again_complete, which works out the next date), not this time (due_again_skip), or a different date for this occurrence only (due_again_reschedule). Change nothing until I say which.',
      ].join('\n'),
  },
  {
    name: 'note_to_diagram',
    title: 'Turn a note into a diagram',
    description:
      'Take a note from Lists & Notes (a process, a plan, a set of ideas) and draw it as a diagram in DiagramSnap.',
    apps: ['lists-and-notes', 'diagramsnap'],
    args: {
      note: z.string().optional().describe('The note’s title'),
    },
    text: (args) =>
      [
        args?.note
          ? `Turn my note "${args.note}" from Lists & Notes into a diagram in DiagramSnap.`
          : 'Turn one of my Lists & Notes notes into a diagram in DiagramSnap. Ask me which note, or list recent ones (lists_and_notes_notes) to choose from.',
        'Read the note with lists_and_notes_note.',
        'Propose the diagram in words first: the boxes (short labels), what connects to what and in which direction, and any groups. Say whether it reads best top to bottom or left to right. Wait for my OK.',
        'Then create it with diagramsnap_create_diagram, named after the note, and show me the picture it returns.',
        'For changes, read it again (diagramsnap_diagram) and send the whole drawing back with diagramsnap_update_diagram, as that tool describes. If it says the diagram changed in the meantime, read it again rather than resending.',
      ].join('\n'),
  },
];

/** The prompts for the apps installed on this Mac. */
export function promptsFor(apps) {
  const installed = new Set(apps.map((a) => a.app.id));
  return PROMPTS.filter((p) =>
    p.apps.length ? p.apps.every((id) => installed.has(id)) : installed.size > 0,
  );
}
