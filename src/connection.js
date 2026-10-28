// Finding a running app and calling its local API.
//
// Each app that allows assistant access writes <data root>/<app>/local_data/assistant.json
// while it is open: { app, port, pid, version, token, startedAt }. The file is readable
// only by the user account that runs the app, which is also the account running this
// server. The token is sent as a Bearer header. Nothing here listens on the network;
// every call goes to 127.0.0.1.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HOST = '127.0.0.1';

// Where the apps keep their data. TC_DATA_ROOT is for tests and the standalone servers.
export function dataRoot() {
  return process.env.TC_DATA_ROOT || path.join(os.homedir(), 'Library', 'Application Support');
}

// Most apps keep their files in a local_data folder under their data dir; an app that
// writes to the data dir itself says so with tokenFile.
function tokenFile(app) {
  return path.join(
    dataRoot(),
    app.dataDir,
    app.tokenFile ?? path.join('local_data', 'assistant.json'),
  );
}

/**
 * Whether the app exists on this Mac: its bundle in Applications, or a data folder it has
 * written. Tools are only offered for installed apps, so an assistant never tells the user
 * to turn on a switch in an app they do not have.
 */
export function isInstalled(app) {
  if (process.env.TC_DATA_ROOT) return fs.existsSync(path.join(dataRoot(), app.dataDir));
  const bundles = [
    path.join('/Applications', `${app.bundleName}.app`),
    path.join(os.homedir(), 'Applications', `${app.bundleName}.app`),
  ];
  return bundles.some((b) => fs.existsSync(b)) || fs.existsSync(path.join(dataRoot(), app.dataDir));
}

function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Reads the app's token file and checks the app answers. Returns
 * { ok: true, baseUrl, token, version } or { ok: false, reason }.
 */
export async function appConnection(app) {
  let record;
  try {
    record = JSON.parse(fs.readFileSync(tokenFile(app), 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') {
      return { ok: false, reason: isInstalled(app) ? 'not-enabled' : 'not-installed' };
    }
    return { ok: false, reason: 'unreadable', detail: err.message };
  }
  if (!record || typeof record.port !== 'number' || typeof record.token !== 'string') {
    return { ok: false, reason: 'unreadable', detail: 'token file has an unexpected shape' };
  }
  if (record.pid && !processAlive(record.pid)) return { ok: false, reason: 'not-running' };
  const baseUrl = `http://${HOST}:${record.port}`;
  try {
    const res = await fetch(`${baseUrl}/api/health`, { signal: AbortSignal.timeout(2000) });
    if (!res.ok) return { ok: false, reason: 'not-running' };
  } catch {
    return { ok: false, reason: 'not-running' };
  }
  return { ok: true, baseUrl, token: record.token, version: record.version ?? null };
}

export class ApiError extends Error {
  constructor(message, status, problems = [], body = null) {
    super(message);
    this.status = status;
    this.problems = problems;
    // The app's whole error reply, for the fields a tool acts on (such as a 409's updatedAt).
    this.body = body;
  }
}

export async function apiCall(conn, method, urlPath, body) {
  const res = await fetch(conn.baseUrl + urlPath, {
    method,
    headers: {
      authorization: `Bearer ${conn.token}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(10000),
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) {
    throw new ApiError(
      data?.error ?? `Request failed (${res.status})`,
      res.status,
      data?.problems,
      data,
    );
  }
  return data;
}

/** Whether an app version (from its token file) is below `min`; an unknown one counts as older. */
export function olderThan(version, min) {
  const a = String(version ?? '0')
    .split('.')
    .map(Number);
  const b = min.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((a[i] || 0) !== b[i]) return (a[i] || 0) < b[i];
  }
  return false;
}

/** The result a tool returns when the app cannot be reached. */
export function notAvailable(app, conn) {
  const reasons = {
    'not-enabled': `${app.name} is installed but not sharing with assistants. In ${app.name}, open Settings and turn on "Allow assistant access".`,
    'not-installed': `${app.name} is not installed on this Mac.`,
    'not-running': `${app.name} is not open. Ask the user whether to open it, then call open_app with app "${app.id}".`,
    unreadable: `${app.name}'s assistant file could not be read: ${conn.detail ?? 'unknown error'}.`,
  };
  return { app: app.name, available: false, reason: conn.reason, message: reasons[conn.reason] };
}

// Images a tool attaches to its reply. A symbol key, so JSON.stringify leaves them out of
// the text and src/index.js sends them as image content instead.
export const IMAGES = Symbol('images');

/** Attaches images ({ data: base64, mimeType }) to a tool's reply. */
export function withImages(value, images) {
  if (images.length) value[IMAGES] = images;
  return value;
}
