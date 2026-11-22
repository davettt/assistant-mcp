// Which apps this connection loads. TIONGCREATIVE_APPS (comma-separated app ids) lets a
// client with a small context, such as a local model in LM Studio, load only the apps it
// needs. Unset or empty means every app, so existing setups see no change. An env var, not
// an argument: any argument switches the command to the setup CLI.

export const APPS_VARIABLE = 'TIONGCREATIVE_APPS';

/**
 * Splits the setting into the apps it chooses. Ids match `app.id`, ignoring case and
 * spaces. Returns { chosen, leftOut, unknown, setting }: `chosen` is every app when the
 * setting is unset; `unknown` lists ids that name no app, which the caller refuses.
 */
export function selectApps(allApps, value) {
  const ids = (value ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  if (!ids.length) return { chosen: allApps, leftOut: [], unknown: [], setting: undefined };
  const known = new Set(allApps.map((a) => a.app.id));
  return {
    chosen: allApps.filter((a) => ids.includes(a.app.id)),
    leftOut: allApps.filter((a) => !ids.includes(a.app.id)),
    unknown: [...new Set(ids.filter((id) => !known.has(id)))],
    setting: ids.join(','),
  };
}

/** The message for ids that name no app, listing the ones that do. */
export function unknownAppsMessage(allApps, unknown) {
  return `${APPS_VARIABLE}: no app with the id ${unknown.map((id) => `"${id}"`).join(', ')}. Use one or more of: ${allApps.map((a) => a.app.id).join(', ')} (comma-separated), or leave it unset for every app.`;
}
