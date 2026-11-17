/**
 * Host half of @local/dsh-hotkey-popout.
 *
 * Owns the macOS global hotkey (through the small Carbon helper in
 * ./native), the popout's HTTP surface, and the catalog data the floating
 * panel needs before a session exists:
 *
 *   GET  /hotkey-popout/state    config + helper status + workspaces +
 *                                agent presets + permission presets
 *   GET  /hotkey-popout/events   Server-Sent Events: { type: 'toggle' }
 *   POST /hotkey-popout/trigger  synthetic toggle (used by tests and by the
 *                                panel's in-window shortcut fallback)
 *
 * The helper is a tiny Swift binary that registers one Carbon hotkey. Carbon
 * hotkeys need no Accessibility or Input Monitoring permission, and they fire
 * while another app is frontmost, which is what makes the summon global.
 */
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PACKAGE_DIR = dirname(fileURLToPath(import.meta.url));
const ROUTE_STATE = '/hotkey-popout/state';
const ROUTE_TRIGGER = '/hotkey-popout/trigger';
const ROUTE_CLIENT_LOG = '/hotkey-popout/client-log';
const ROUTE_PING = '/hotkey-popout/ping';
const ROUTE_SETTINGS = '/hotkey-popout/settings';
const ROUTE_WAIT = '/hotkey-popout/wait';
/** How long one long-poll request is held before the client re-arms. */
const WAIT_TIMEOUT_MS = 25_000;

const DEFAULTS = {
  /** Global shortcut, e.g. "Option+Space", "Cmd+Shift+K". */
  hotkey: 'Option+Space',
  /** Minutes without conversation before the next summon starts a new session. */
  idleMinutes: 10,
  /** Bring the Harness window to the front when the hotkey fires. */
  focusOnHotkey: true,
  /** Explicit helper binary path; empty means the bundled one. */
  helperPath: '',
  /** Temporarily disable just the global hotkey while keeping the panel. */
  globalHotkey: true,
  /** Host the panel in a real floating window (macOS) instead of the app overlay. */
  nativeWindow: true,
  /** Floating window size in points. */
  windowSize: '920x720',
};

/** Runtime-adjustable settings that outlive a page in ~/.dsh/hotkey-popout.json. */

/** Per-user state that must outlive a page (the floating window has its own storage). */
function stateFilePath() {
  const home = process.env.DSH_HOME && process.env.DSH_HOME !== ''
    ? process.env.DSH_HOME
    : `${homedir()}/.dsh`;
  return `${home}/hotkey-popout.json`;
}

function readStateFile() {
  try {
    const parsed = JSON.parse(readFileSync(stateFilePath(), 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch { return {}; }
}

function writeStateFile(patch) {
  const next = { ...readStateFile(), ...patch };
  try {
    const file = stateFilePath();
    mkdirSync(file.slice(0, file.lastIndexOf('/')), { recursive: true });
    writeFileSync(file, JSON.stringify(next, null, 2));
  } catch { /* a read-only home must not break the panel */ }
  return next;
}

const KEY_ALIASES = {
  space: 'space', return: 'return', enter: 'return', tab: 'tab',
  escape: 'escape', esc: 'escape', delete: 'delete', backspace: 'delete',
  left: 'left', right: 'right', up: 'up', down: 'down',
  home: 'home', end: 'end', pageup: 'pageup', pagedown: 'pagedown',
};

/** Parse "Option+Space" into `{ key, modifiers }` for the helper. */
export function parseHotkey(value) {
  const text = typeof value === 'string' && value.trim() !== '' ? value.trim() : DEFAULTS.hotkey;
  const parts = text.split('+').map((part) => part.trim()).filter(Boolean);
  if (parts.length === 0) return { key: 'space', modifiers: ['option'] };
  const key = normalizeKey(parts[parts.length - 1]);
  const modifiers = normalizeModifiers(parts.slice(0, -1));
  return { key, modifiers };
}

function normalizeKey(raw) {
  const lower = String(raw).toLowerCase();
  if (KEY_ALIASES[lower] !== undefined) return KEY_ALIASES[lower];
  if (/^f([1-9]|1[0-2])$/.test(lower)) return lower;
  return lower;
}

function normalizeModifiers(names) {
  const out = [];
  for (const name of names) {
    const lower = String(name).toLowerCase();
    if (lower === 'option' || lower === 'alt' || lower === 'opt') push('option');
    else if (lower === 'cmd' || lower === 'command' || lower === 'meta') push('cmd');
    else if (lower === 'ctrl' || lower === 'control') push('ctrl');
    else if (lower === 'shift') push('shift');
  }
  return out.length === 0 ? ['option'] : out;
  function push(value) {
    if (!out.includes(value)) out.push(value);
  }
}

/** Locate the helper binary, compiling the Swift source on first use. */
function helperCacheDir() {
  const home = process.env.HOME && process.env.HOME !== '' ? process.env.HOME : homedir();
  return join(home, 'Library', 'Caches', 'dsh-hotkey-popout');
}

/**
 * Locate the native helper, compiling it when needed.
 *
 * The source is the single source of truth: a prebuilt binary is reused only
 * while it is at least as new as `native/hotkey-helper.swift`, so editing the
 * Swift file always takes effect. Builds land in `~/Library/Caches` first,
 * which keeps working when the package directory is read-only (pnpm store,
 * global installs); the package's own `bin/` is the fallback.
 */
export function resolveHelper(config, logger) {
  if (typeof config.helperPath === 'string' && config.helperPath !== '') {
    return existsSync(config.helperPath) ? config.helperPath : undefined;
  }
  const arch = process.arch === 'arm64' ? 'arm64' : process.arch === 'x64' ? 'x64' : process.arch;
  const source = join(PACKAGE_DIR, 'native', 'hotkey-helper.swift');
  const sourceTime = existsSync(source) ? statSync(source).mtimeMs : 0;
  const fresh = (candidate) => existsSync(candidate)
    && (sourceTime === 0 || statSync(candidate).mtimeMs >= sourceTime);

  const bundled = join(PACKAGE_DIR, 'bin', `dsh-hotkey-helper-${arch}`);
  if (fresh(bundled)) return bundled;
  if (!existsSync(source)) return undefined;

  let hash = 'unknown';
  try {
    hash = createHash('sha256').update(readFileSync(source)).digest('hex').slice(0, 12);
  } catch { /* keep the placeholder */ }
  const cacheDir = helperCacheDir();
  const cached = join(cacheDir, `dsh-hotkey-helper-${arch}-${hash}`);
  if (fresh(cached)) return cached;

  const targets = [cached, bundled];
  for (const target of targets) {
    try {
      mkdirSync(dirname(target), { recursive: true });
    } catch (error) {
      logger?.warn?.('[hotkey-popout] cannot create helper directory:', error);
      continue;
    }
    const result = spawnSync('xcrun', ['swiftc', '-O', '-o', target, source], {
      stdio: 'pipe',
      timeout: 180_000,
    });
    if (result.status === 0 && existsSync(target)) return target;
    const detail = String(result.stderr ?? '').trim().slice(0, 500);
    logger?.warn?.(`[hotkey-popout] helper build failed in ${target}:`, detail || `exit ${String(result.status)}`);
  }
  return undefined;
}

export const inject = ['webServer'];

export function apply(ctx, rawConfig) {
  const logger = typeof ctx.logger === 'function' ? ctx.logger('hotkey-popout') : console;
  const config = { ...DEFAULTS, ...(rawConfig && typeof rawConfig === 'object' ? rawConfig : {}) };
  const hotkey = parseHotkey(config.hotkey);
  const savedState = readStateFile();

  const clampIdle = (value, fallback) => {
    const minutes = Number(value);
    return Number.isFinite(minutes) && minutes >= 0 && minutes <= 24 * 60 ? minutes : fallback;
  };
  let idleMinutes = clampIdle(
    savedState.idleMinutes ?? config.idleMinutes,
    clampIdle(config.idleMinutes, DEFAULTS.idleMinutes),
  );

  /** Ring buffer of client-side beacons, used to verify rendering without a browser console. */
  const clientLog = [];
  /** Monotonic counter so a polling client can detect what it already applied. */
  let broadcastSeq = 0;
  /** Recent frames, replayed to a client that was disconnected. */
  const eventLog = [];
  /** Held long-poll responses waiting for the next frame. */
  const waiters = new Set();
  const helperState = {
    running: false,
    error: '',
    key: hotkey.key,
    modifiers: hotkey.modifiers,
    windowReady: false,
    windowVisible: false,
    windowError: '',
    pinned: false,
    mode: 'overlay',
  };
  let helper = null;
  let helperStdoutBuffer = '';
  const upgradeTimers = new Set();
  let disposed = false;

  const broadcast = (payload) => {
    broadcastSeq += 1;
    const entry = { ...payload, seq: broadcastSeq };
    eventLog.push(entry);
    if (eventLog.length > 32) eventLog.shift();
    for (const waiter of [...waiters]) {
      if (entry.seq <= waiter.since) continue;
      waiters.delete(waiter);
      clearTimeout(waiter.timer);
      try {
        waiter.res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
        waiter.res.end(JSON.stringify({ seq: entry.seq, events: eventLog.filter((item) => item.seq > waiter.since) }));
      } catch { /* the request is gone */ }
    }
  };

  const focusApp = () => {
    if (config.focusOnHotkey === false) return;
    for (const command of [['-b', 'com.deepseek.dsh'], ['-a', 'DeepSeek Harness']]) {
      try {
        const child = spawn('open', command, { stdio: 'ignore', detached: true });
        child.on('error', () => {});
        child.unref();
        return;
      } catch { /* try the next form */ }
    }
  };

  const emitToggle = () => {
    focusApp();
    broadcast({ type: 'toggle', time: Date.now() });
  };

  /**
   * The authenticated page URL the floating window renders. It can only be
   * built once the web server is listening, which happens after a cold-boot
   * plugin start, so this is retried instead of computed once.
   */
  let windowUrl = '';
  const wantsWindow = process.platform === 'darwin' && config.nativeWindow !== false;

  const buildWindowUrl = () => {
    try {
      const server = ctx.get('webServer');
      const connection = ctx.get('connection');
      if (!server || !connection) throw new Error('web services are not ready yet');
      const port = Number(server.port);
      if (!Number.isInteger(port) || port <= 0) throw new Error('the web server is not listening yet');
      const origin = `${server.protocol}//127.0.0.1:${String(port)}`;
      const authenticated = connection.authenticatedUrl(origin);
      if (typeof authenticated !== 'string' || authenticated === '') throw new Error('no authenticated url');
      helperState.windowError = '';
      return `${authenticated}${authenticated.includes('?') ? '&' : '?'}dshp=window`;
    } catch (error) {
      helperState.windowError = error instanceof Error ? error.message : String(error);
      return '';
    }
  };

  const startHelper = () => {
    if (config.globalHotkey === false) return;
    const binary = resolveHelper(config, logger);
    if (binary === undefined) {
      helperState.error = 'helper binary is unavailable';
      return;
    }
    try {
      const args = ['--key', hotkey.key, '--modifiers', hotkey.modifiers.join('+')];
      if (windowUrl !== '') {
        args.push('--window-url', windowUrl, '--window-size', String(config.windowSize ?? '920x720'));
      }
      helper = spawn(binary, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (error) {
      helperState.error = error instanceof Error ? error.message : String(error);
      helper = null;
      return;
    }
    helperState.running = true;
    helper.on('error', (error) => {
      helperState.running = false;
      helperState.error = error instanceof Error ? error.message : String(error);
    });
    helper.on('exit', (code, signal) => {
      helperState.running = false;
      if (code !== 0 && code !== null && !disposed) {
        helperState.error = `helper exited with code ${String(code)}${signal ? ` (${signal})` : ''}`;
      }
      helper = null;
    });
    helper.stderr?.setEncoding('utf8');
    helper.stderr?.on('data', (chunk) => {
      const text = String(chunk).trim();
      if (text !== '') logger.debug('helper:', text.slice(0, 400));
    });
    helper.stdout?.setEncoding('utf8');
    helper.stdout?.on('data', (chunk) => {
      helperStdoutBuffer += String(chunk);
      let index = helperStdoutBuffer.indexOf('\n');
      while (index >= 0) {
        const line = helperStdoutBuffer.slice(0, index).trim();
        helperStdoutBuffer = helperStdoutBuffer.slice(index + 1);
        if (line !== '') handleHelperLine(line);
        index = helperStdoutBuffer.indexOf('\n');
      }
    });
  };

  const handleHelperLine = (line) => {
    let message;
    try { message = JSON.parse(line); } catch { return; }
    if (message?.type === 'ready') {
      helperState.running = true;
      helperState.error = '';
      helperState.key = String(message.key ?? hotkey.key);
      helperState.modifiers = Array.isArray(message.modifiers) ? message.modifiers : hotkey.modifiers;
      return;
    }
    if (message?.type === 'error') {
      helperState.error = String(message.message ?? 'hotkey registration failed');
      return;
    }
    if (message?.type === 'window-state') {
      clientLog.push({
        time: Date.now(),
        event: 'window-state',
        detail: JSON.stringify({
          visible: message.visible,
          key: message.key,
          active: message.active,
          frame: message.frame,
          resizable: message.resizable,
          titled: message.titled,
          min: message.min,
        }),
      });
      if (clientLog.length > 40) clientLog.shift();
      return;
    }
    if (message?.type === 'pinned') {
      helperState.pinned = message.value === true;
      broadcast({ type: 'pinned', value: helperState.pinned });
      return;
    }
    if (message?.type === 'menu') {
      clientLog.push({
        time: Date.now(),
        event: 'menu',
        detail: `menus=${(message.menus ?? []).join('|')} edit=${(message.edit ?? []).join('|')}`,
      });
      if (clientLog.length > 40) clientLog.shift();
      return;
    }
    if (message?.type === 'window-ready') {
      helperState.windowReady = true;
      helperState.mode = 'window';
      return;
    }
    if (message?.type === 'window') {
      clientLog.push({
        time: Date.now(),
        event: message.visible === true ? 'window-shown' : 'window-hidden',
        detail: String(message.reason ?? ''),
      });
      if (clientLog.length > 40) clientLog.shift();
      helperState.windowVisible = message.visible === true;
      helperState.mode = 'window';
      // The page cannot rely on a DOM focus event: it may be delivered before
      // the client module finishes loading. Relay the helper's own signal.
      broadcast({ type: helperState.windowVisible ? 'shown' : 'hidden' });
      return;
    }
    if (message?.type === 'window-preload') {
      helperState.mode = 'window';
      return;
    }
    if (message?.type === 'hotkey') {
      // A helper without a floating window still drives the in-app overlay.
      emitToggle();
    }
  };

  const stopHelper = () => {
    if (helper === null) return;
    try { helper.stdin?.write('{"cmd":"quit"}\n'); } catch { /* ignore */ }
    const child = helper;
    helper = null;
    helperState.running = false;
    setTimeout(() => {
      try { if (child.exitCode === null) child.kill('SIGTERM'); } catch { /* ignore */ }
    }, 400).unref?.();
  };

  /* ------------------------------------------------------------- routes -- */

  const readJsonBody = (req) => new Promise((resolve) => {
    let body = '';
    req.setEncoding?.('utf8');
    req.on('data', (chunk) => { body += chunk; if (body.length > 4096) body = body.slice(0, 4096); });
    req.on('end', () => resolve(body));
    req.on('error', () => resolve(''));
  });

  const statePayload = async () => {
    const diagnostics = [];
    const workspaces = [];
    try {
      const rows = ctx.get('workspaceRegistry')?.list?.() ?? [];
      for (const row of rows) {
        workspaces.push({
          id: String(row.id ?? row.workspaceId ?? ''),
          path: String(row.path ?? ''),
          title: String(row.title ?? ''),
          sessionCount: Array.isArray(row.sessionIds) ? row.sessionIds.length : 0,
          updatedAt: String(row.updatedAt ?? ''),
        });
      }
    } catch (error) {
      diagnostics.push(`workspaces: ${error instanceof Error ? error.message : String(error)}`);
    }
    const presets = [];
    try {
      const roster = await ctx.get('agentPresets')?.list?.();
      for (const preset of roster ?? []) {
        presets.push({
          id: String(preset.id ?? ''),
          name: String(preset.name ?? preset.id ?? ''),
          description: preset.description === undefined ? '' : String(preset.description),
          isDefault: preset.isDefault === true,
          broken: preset.broken === undefined ? '' : String(preset.broken),
        });
      }
    } catch (error) {
      diagnostics.push(`presets: ${error instanceof Error ? error.message : String(error)}`);
    }
    let defaultDirectory = '';
    try {
      defaultDirectory = String(ctx.get('workingDirectory')?.defaultDirectory ?? '');
    } catch (error) {
      diagnostics.push(`defaultDirectory: ${error instanceof Error ? error.message : String(error)}`);
    }
    let permissions = { options: [], defaultPreset: '' };
    try {
      const catalog = ctx.get('permissionPresets')?.catalog?.();
      if (catalog && Array.isArray(catalog.options)) {
        permissions = {
          defaultPreset: String(catalog.defaultPreset ?? ''),
          options: catalog.options.map((option) => ({
            value: String(option.value ?? ''),
            name: String(option.name ?? option.value ?? ''),
            description: option.description === undefined ? '' : String(option.description),
          })),
        };
      }
    } catch (error) {
      diagnostics.push(`permissions: ${error instanceof Error ? error.message : String(error)}`);
    }
    return {
      config: {
        hotkey: String(config.hotkey),
        hotkeyKey: helperState.key,
        hotkeyModifiers: helperState.modifiers,
        idleMinutes,
        focusOnHotkey: config.focusOnHotkey !== false,
      },
      helper: { ...helperState },
      mode: helperState.windowReady ? 'window' : 'overlay',
      workspaces,
      // First-run default: the project the user actually works in (most
      // sessions), then the most recently touched one.
      defaultWorkspaceId: workspaces.length === 0 ? '' : [...workspaces]
        .sort((left, right) => (right.sessionCount - left.sessionCount)
          || right.updatedAt.localeCompare(left.updatedAt))[0].id,
      defaultDirectory,
      presets,
      permissions,
      diagnostics,
      push: { waiting: waiters.size, seq: broadcastSeq },
      platform: process.platform,
    };
  };

  const stateHandler = async (req, res) => {
    try {
      const payload = await statePayload();
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end(JSON.stringify(payload));
    } catch (error) {
      res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
    }
  };

  const settingsHandler = async (req, res) => {
    if (req.method === 'POST') {
      const body = await readJsonBody(req);
      try {
        const patch = JSON.parse(body || '{}');
        const next = {};
        if (patch.idleMinutes !== undefined) {
          const value = Number(patch.idleMinutes);
          if (!Number.isFinite(value) || value < 0 || value > 24 * 60) {
            throw new Error(`unsupported idleMinutes '${String(patch.idleMinutes)}'`);
          }
          idleMinutes = value;
          next.idleMinutes = value;
        }
        if (Object.keys(next).length === 0) throw new Error('no supported setting in the request');
        writeStateFile(next);
        if (next.idleMinutes !== undefined) broadcast({ type: 'idle', value: idleMinutes });
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
        res.end(JSON.stringify({ idleMinutes }));
        return;
      } catch (error) {
        res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
        return;
      }
    }
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(JSON.stringify({ idleMinutes }));
  };

  const pingHandler = (req, res) => {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(JSON.stringify({
      seq: broadcastSeq,
      waiting: waiters.size,
      helper: { running: helperState.running, error: helperState.error },
      now: Date.now(),
    }));
  };

  /**
   * Long poll: the browser's fetch path is not subject to the gzip buffering
   * that delays a streaming response, and each response completes, so the
   * panel sees a hotkey press within a few milliseconds.
   */
  const waitHandler = (req, res) => {
    let since = 0;
    try { since = Number(new URL(req.url ?? '/', 'http://127.0.0.1').searchParams.get('since') ?? 0) || 0; } catch { /* default */ }
    const pending = eventLog.filter((entry) => entry.seq > since);
    if (pending.length > 0) {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end(JSON.stringify({ seq: broadcastSeq, events: pending }));
      return;
    }
    const waiter = { res, since, timer: null };
    waiter.timer = setTimeout(() => {
      waiters.delete(waiter);
      try {
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
        res.end(JSON.stringify({ seq: broadcastSeq, events: [] }));
      } catch { /* gone */ }
    }, WAIT_TIMEOUT_MS);
    waiters.add(waiter);
    res.on('close', () => {
      clearTimeout(waiter.timer);
      waiters.delete(waiter);
    });
  };

  const clientLogHandler = async (req, res) => {
    if (req.method === 'POST') {
      const body = await readJsonBody(req);
      try {
        const entry = JSON.parse(body || '{}');
        clientLog.push({ time: Date.now(), event: String(entry.event ?? ''), detail: String(entry.detail ?? '').slice(0, 600) });
        if (clientLog.length > 40) clientLog.shift();
      } catch { /* ignore malformed beacons */ }
      res.writeHead(204);
      res.end();
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(JSON.stringify({ entries: clientLog, helper: helperState }));
  };

  const triggerHandler = async (req, res) => {
    const body = await readJsonBody(req);
    let force = '';
    try { force = String(JSON.parse(body || '{}').type ?? ''); } catch { /* ignore */ }
    const windowCommands = ['show-window', 'hide-window', 'toggle-window', 'reload-window', 'window-state'];
    if (windowCommands.includes(force) || force === 'set-frame') {
      if (helper !== null) {
        try {
          const command = { cmd: force };
          if (force === 'set-frame') {
            try { command.frame = JSON.parse(body || '{}').frame; } catch { /* ignore */ }
          }
          helper.stdin?.write(`${JSON.stringify(command)}\n`);
        } catch { /* ignore */ }
      }
    } else if (force === 'pin-click') {
      broadcast({ type: 'pin-click', time: Date.now() });
    } else if (force === 'toggle-pin') {
      const next = !helperState.pinned;
      helperState.pinned = next;
      if (helper !== null) {
        try { helper.stdin?.write(`${JSON.stringify({ cmd: 'pin', value: next })}\n`); } catch { /* ignore */ }
      }
      broadcast({ type: 'pinned', value: next });
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end(JSON.stringify({ ok: true, pinned: next }));
      return;
    } else if (force === 'remember-session') {
      let sessionId = '';
      try { sessionId = String(JSON.parse(body || '{}').sessionId ?? ''); } catch { /* ignore */ }
      broadcast({ type: 'remember-session', sessionId, time: Date.now() });
    } else if (force === 'set-workspace') {
      let workspaceId = '';
      try { workspaceId = String(JSON.parse(body || '{}').workspaceId ?? ''); } catch { /* ignore */ }
      if (workspaceId !== '') broadcast({ type: 'workspace', workspaceId, time: Date.now() });
    } else if (force === 'open-session') {
      let sessionId = '';
      try { sessionId = String(JSON.parse(body || '{}').sessionId ?? ''); } catch { /* ignore */ }
      if (sessionId !== '') broadcast({ type: 'navigate', sessionId, time: Date.now() });
    } else if (force === 'open' || force === 'close') {
      broadcast({ type: force, time: Date.now() });
    } else {
      emitToggle();
    }
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(JSON.stringify({ ok: true, waiting: waiters.size, helper: helperState.running }));
  };

  ctx.effect(() => {
    const offState = ctx.webServer.register({ kind: 'exact', path: ROUTE_STATE, handler: stateHandler });
    const offTrigger = ctx.webServer.register({ kind: 'exact', path: ROUTE_TRIGGER, handler: triggerHandler });
    const offLog = ctx.webServer.register({ kind: 'exact', path: ROUTE_CLIENT_LOG, handler: clientLogHandler });
    const offPing = ctx.webServer.register({ kind: 'exact', path: ROUTE_PING, handler: pingHandler });
    const offSettings = ctx.webServer.register({ kind: 'exact', path: ROUTE_SETTINGS, handler: settingsHandler });
    const offWait = ctx.webServer.register({ kind: 'exact', path: ROUTE_WAIT, handler: waitHandler });
    return () => {
      offState?.();
      offTrigger?.();
      offLog?.();
      offPing?.();
      offSettings?.();
      offWait?.();
    };
  }, 'hotkey-popout: http surface');

  ctx.effect(() => {
    // Cold boot: the web server is not listening yet, so wait for it instead of
    // silently falling back to the in-app overlay.
    let retry = null;
    let attempts = 0;
    const attempt = () => {
      retry = null;
      if (disposed) return;
      if (helper !== null) return;
      if (wantsWindow && windowUrl === '') {
        windowUrl = buildWindowUrl();
        if (windowUrl === '' && attempts < 240) { // up to a minute of cold-boot waiting
          attempts += 1;
          retry = setTimeout(attempt, 250);
          return;
        }
        if (windowUrl === '') {
          logger.warn('starting without the floating window:', helperState.windowError);
          helperState.windowError = `floating window unavailable: ${helperState.windowError}`;
          // Self-heal: if the authenticated URL shows up later, swap the
          // overlay-only helper for one that owns the floating window.
          let upgrades = 0;
          const upgrade = setInterval(() => {
            if (disposed || upgrades > 30) { clearInterval(upgrade); return; }
            upgrades += 1;
            const url = buildWindowUrl();
            if (url === '') return;
            clearInterval(upgrade);
            windowUrl = url;
            stopHelper();
            setTimeout(() => { if (!disposed && helper === null) startHelper(); }, 300);
          }, 2000);
          upgradeTimers.add(upgrade);
        }
      }
      startHelper();
    };
    attempt();
    return () => {
      if (retry !== null) clearTimeout(retry);
      for (const timer of upgradeTimers) clearInterval(timer);
      upgradeTimers.clear();
      disposed = true;
      stopHelper();
      for (const waiter of [...waiters]) {
        clearTimeout(waiter.timer);
        try { waiter.res.end(JSON.stringify({ seq: broadcastSeq, events: [] })); } catch { /* gone */ }
      }
      waiters.clear();
    };
  }, 'hotkey-popout: global hotkey');

  logger.info(`listening; hotkey=${String(config.hotkey)} idle=${idleMinutes}m`);

}

export const name = 'hotkey-popout';