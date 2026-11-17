/**
 * Client half of @local/dsh-hotkey-popout.
 *
 * The plugin has one UI: the floating window. The helper's WKWebView renders
 * the real Harness app in *window mode* (`window.__DSHP_WINDOW__`), so this
 * module only:
 *
 *  - on the app window: contributes the "new session after idling" setting;
 *  - on the floating window page: collapses the sidebar, hides the collapsed
 *    icon rail, restores or starts the session on focus, and adds the pin
 *    button plus the ⌘N / ⌘W / ⌘⇧P shortcuts.
 *
 * There is no self-drawn transcript: the window shows the app itself, which is
 * what gives Markdown, tool cards, approvals, and the real composer.
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-hotkey-popout',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    const NS = 'hotkey-popout';
    const BUILD = 'w26';
    const STORE_KEY = 'dsh.hotkey-popout.v1';
    const STATE_PATH = '/hotkey-popout/state';
    const SETTINGS_PATH = '/hotkey-popout/settings';
    const WAIT_PATH = '/hotkey-popout/wait';
    const PING_PATH = '/hotkey-popout/ping';
    const TRIGGER_PATH = '/hotkey-popout/trigger';

    /* ------------------------------------------------------------ copy ---- */
    const IconPin = (props) => {
      const size = props?.size ?? 15;
      return h('svg', {
        viewBox: '0 0 24 24', width: size, height: size, 'aria-hidden': true,
        style: { display: 'block', flex: '0 0 auto' },
      }, [
        h('path', {
          key: 'head',
          d: 'M9.4 3.6h5.2a1.4 1.4 0 0 1 0 2.8h-.6v4.3l3 1.9c.5.3.8.8.8 1.4v1.4H6.2v-1.4c0-.6.3-1.1.8-1.4l3-1.9V6.4h-.6a1.4 1.4 0 0 1 0-2.8z',
          fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, strokeLinejoin: 'round',
        }),
        h('path', {
          key: 'needle',
          d: 'M12 15.4v5',
          fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round',
        }),
      ]);
    };

    const PIN_CSS = `
.dshp-pin{display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;margin:0 2px;
  padding:0;border:none;border-radius:7px;background:transparent;color:currentColor;opacity:.55;cursor:pointer}
.dshp-pin:hover{background:rgba(127,127,127,.16);opacity:.9}
.dshp-pin.is-on{color:#2f6ee0;opacity:1}
@media (prefers-color-scheme: dark){.dshp-pin.is-on{color:#7aa8ff}}
`;

    const DICT = {
      en: {
        idleTitle: 'New session after idling',
        idleHint: 'After the popout stays hidden this long, the next summon starts a new session.',
        idleOff: 'Never',
        idleUnit: 'min',
        helperProblem: 'Popout unavailable: {reason}. The global hotkey will not work — build native/hotkey-helper.swift (needs the Xcode command line tools) with `xcrun swiftc -O -o bin/dsh-hotkey-helper-arm64 native/hotkey-helper.swift`.',
        helperNotRunning: 'the native helper is not running',
        helperNoWindow: 'the floating window could not start',
        pinOn: 'Pin this window (⌘⇧P)',
        pinOff: 'Unpin this window (⌘⇧P)',
      },
      zh: {
        idleTitle: '闲置后新会话',
        idleHint: '悬浮窗隐藏超过该时长后，下次唤起会自动开启新会话。',
        idleOff: '不自动',
        idleUnit: '分钟',
        helperProblem: '悬浮窗不可用：{reason}。全局快捷键不会生效——请在插件目录执行 `xcrun swiftc -O -o bin/dsh-hotkey-helper-arm64 native/hotkey-helper.swift`（需要 Xcode 命令行工具）。',
        helperNotRunning: 'native helper 未运行',
        helperNoWindow: '悬浮窗未能启动',
        pinOn: '固定这个窗口（⌘⇧P）',
        pinOff: '取消固定（⌘⇧P）',
      },
    };

    function makeT(ctx) {
      return (key, vars) => {
        let id = 'en';
        try {
          const snapshot = ctx.locale.getSnapshot();
          const active = String(snapshot?.active ?? snapshot?.id ?? 'en');
          id = active.slice(0, 2).toLowerCase() === 'zh' ? 'zh' : 'en';
        } catch { /* default */ }
        let text = DICT[id]?.[key] ?? DICT.en[key] ?? key;
        for (const [name, value] of Object.entries(vars ?? {})) text = text.replaceAll(`{${name}}`, String(value));
        return text;
      };
    }

    /* --------------------------------------------------------- plumbing --- */
    function report(event, detail) {
      try {
        void fetch('/hotkey-popout/client-log', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ event, detail: detail === undefined ? '' : String(detail) }),
          credentials: 'same-origin',
        }).catch(() => {});
      } catch { /* never let telemetry break the window */ }
    }

    function readPersisted() {
      try {
        const raw = window.localStorage.getItem(STORE_KEY);
        const parsed = raw === null ? null : JSON.parse(raw);
        return parsed && typeof parsed === 'object' ? parsed : {};
      } catch { return {}; }
    }

    function writePersisted(patch) {
      try {
        window.localStorage.setItem(STORE_KEY, JSON.stringify({ ...readPersisted(), ...patch }));
      } catch { /* private mode */ }
    }

    async function postJson(path, body) {
      try {
        const response = await fetch(path, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
          credentials: 'same-origin',
        });
        return response.ok ? await response.json().catch(() => null) : null;
      } catch { return null; }
    }

    async function readState() {
      try {
        const response = await fetch(STATE_PATH, { credentials: 'same-origin', cache: 'no-store' });
        return response.ok ? await response.json() : null;
      } catch { return null; }
    }

    async function listSessions(ctx) {
      try {
        const result = await ctx.remote.session.list({});
        const items = result?.ok ? result.value?.items ?? [] : [];
        return items
          .map((item) => ({
            id: String(item.sessionId),
            cwd: String(item.cwd ?? ''),
            updatedAt: Number(item.updatedAt ?? 0),
          }))
          .filter((row) => row.id !== '');
      } catch { return []; }
    }

    /**
     * The Session this page currently shows, read from the app's own
     * `dsh.sessions.current` entry. This is what makes the popout remember its
     * own conversation instead of whatever Session the app touched last.
     */
    function currentSessionId() {
      const read = (raw) => {
        try {
          const parsed = JSON.parse(raw ?? '{}');
          return typeof parsed?.sessionId === 'string' ? parsed.sessionId : '';
        } catch { return ''; }
      };
      try {
        const direct = read(window.localStorage.getItem('dsh.sessions.current'));
        if (direct !== '') return direct;
        for (let index = 0; index < window.localStorage.length; index += 1) {
          const key = window.localStorage.key(index) ?? '';
          if (!key.includes('sessions.current')) continue;
          const value = read(window.localStorage.getItem(key));
          if (value !== '') return value;
        }
      } catch { /* storage may be unavailable */ }
      return '';
    }

    /** Longest workspace path that contains the session's directory. */
    function workspaceForPath(workspaces, cwd) {
      if (typeof cwd !== 'string' || cwd === '' || !Array.isArray(workspaces)) return '';
      let best = { id: '', length: -1 };
      for (const workspace of workspaces) {
        const path = String(workspace?.path ?? '');
        if (path === '' || workspace?.id === undefined) continue;
        if ((cwd === path || cwd.startsWith(`${path}/`)) && path.length > best.length) {
          best = { id: String(workspace.id), length: path.length };
        }
      }
      return best.id;
    }

    /** The workspace the popout should use: remembered, then the host default. */
    function resolveWorkspace(boot, persisted) {
      const known = Array.isArray(boot?.workspaces) ? boot.workspaces : [];
      const remembered = typeof persisted?.workspaceId === 'string' ? persisted.workspaceId : '';
      if (remembered !== '' && known.some((workspace) => String(workspace.id) === remembered)) {
        return remembered;
      }
      return String(boot?.defaultWorkspaceId ?? '') || String(known[0]?.id ?? '');
    }

    /* ------------------------------------------------------------ icons --- */
    /* ------------------------------------------------------ app window ---- */
    function IdleRow({ ctx }) {
      const t = React.useMemo(() => makeT(ctx), [ctx]);
      const [value, setValue] = React.useState(10);
      const [busy, setBusy] = React.useState(false);
      const [status, setStatus] = React.useState(null);

      React.useEffect(() => {
        let stopped = false;
        const load = async () => {
          const state = await readState();
          if (stopped || state === null) return;
          const minutes = Number(state?.config?.idleMinutes);
          if (Number.isFinite(minutes)) setValue(minutes);
          setStatus({ helper: state?.helper ?? null, mode: state?.mode ?? '' });
        };
        void load();
        const timer = window.setInterval(load, 5000);
        return () => { stopped = true; window.clearInterval(timer); };
      }, []);

      const problem = (() => {
        if (status === null) return '';
        const helper = status.helper;
        if (helper === null) return '';
        if (helper.running !== true) return helper.error || t('helperNotRunning');
        if (helper.windowError) return helper.windowError;
        if (status.mode !== 'window') return t('helperNoWindow');
        return '';
      })();

      const options = [0, 1, 3, 5, 10, 15, 30, 60];
      if (!options.includes(value)) options.push(value);

      const choose = async (next) => {
        if (busy || next === value) return;
        setBusy(true);
        const saved = await postJson(SETTINGS_PATH, { idleMinutes: next });
        if (saved !== null && Number.isFinite(Number(saved.idleMinutes))) {
          setValue(Number(saved.idleMinutes));
        }
        setBusy(false);
      };

      return h('div', {
        style: {
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          gap: 16, padding: '14px 0', color: 'inherit',
        },
      }, [
        h('div', { key: 'text', style: { minWidth: 0 } }, [
          h('div', { key: 'title', style: { fontSize: 13, lineHeight: 1.4 } }, t('idleTitle')),
          h('div', { key: 'hint', style: { fontSize: 11.5, opacity: 0.55, marginTop: 2 } }, t('idleHint')),
          problem === '' ? null : h('div', {
            key: 'problem',
            role: 'status',
            style: { fontSize: 11.5, lineHeight: 1.6, marginTop: 4, color: '#d64545' },
          }, t('helperProblem', { reason: problem })),
        ]),
        h('div', {
          key: 'control',
          style: { display: 'flex', alignItems: 'center', gap: 6, flex: '0 0 auto' },
        }, [
          h('select', {
            key: 'select',
            value: String(value),
            disabled: busy,
            onChange: (event) => { void choose(Number(event.target.value)); },
            style: {
              appearance: 'none', border: '1px solid rgba(127,127,127,.28)', borderRadius: 8,
              padding: '4px 10px', font: 'inherit', fontSize: 12, color: 'inherit',
              background: 'rgba(127,127,127,.10)', cursor: 'pointer',
            },
          }, options.map((minutes) => h('option', { key: minutes, value: String(minutes) },
            minutes === 0 ? t('idleOff') : String(minutes)))),
          h('span', { key: 'unit', style: { fontSize: 12, opacity: 0.6 } }, t('idleUnit')),
        ]),
      ]);
    }

    function applyAppWindow(ctx) {
      report('build', `${BUILD}-main`);
      ctx.effect(() => ctx.slots.inject('settings.general.item', () => ctx.slots.register({
        name: 'settings.general.item',
        id: 'hotkey-popout-idle',
        order: 31,
      }, () => h(IdleRow, { ctx }))), 'hotkey-popout: idle setting');
    }

    /* --------------------------------------------------- floating window -- */
    function applyFloatingWindow(ctx) {
      report('build', `${BUILD}-window`);

      /** Imperative bookkeeping; never read by React. */
      const ui = {
        boot: null,
        hasLiveSession: false,
        shownAt: 0,
        summoning: false,
        summonRetries: 0,
      };
      /** What the header button renders. Replaced, never mutated, so
          useSyncExternalStore sees a new snapshot. */
      let view = { pinned: false, idleMinutes: 10 };
      const listeners = new Set();
      const store = {
        getSnapshot: () => view,
        subscribe(fn) {
          listeners.add(fn);
          return () => { listeners.delete(fn); };
        },
        set(patch) {
          let changed = false;
          for (const [key, value] of Object.entries(patch)) {
            if (view[key] !== value) changed = true;
          }
          if (!changed) return;
          view = { ...view, ...patch };
          for (const fn of [...listeners]) fn();
        },
      };

      const localeState = { snapshot: ctx.locale.getSnapshot() };
      const localeListeners = new Set();
      const localeStore = {
        subscribe(fn) {
          localeListeners.add(fn);
          return () => { localeListeners.delete(fn); };
        },
        getSnapshot: () => localeState.snapshot,
      };
      ctx.effect(() => ctx.locale.subscribe(() => {
        localeState.snapshot = ctx.locale.getSnapshot();
        for (const fn of [...localeListeners]) fn();
      }), 'hotkey-popout: locale');

      ctx.effect(() => {
        const style = document.createElement('style');
        style.setAttribute('data-dshp', 'pin');
        style.textContent = PIN_CSS;
        document.head.appendChild(style);
        return () => style.remove();
      }, 'hotkey-popout: pin style');

      window.setTimeout(() => {
        try {
          const node = document.querySelector('.dshp-pin');
          const rect = node?.getBoundingClientRect();
          report('pin-rect', rect ? `top=${Math.round(rect.top)} left=${Math.round(rect.left)} w=${Math.round(rect.width)} h=${Math.round(rect.height)}` : 'no-button');
        } catch (error) { report('pin-rect', String(error)); }
      }, 3000);

      const loadBoot = async () => {
        const state = await readState();
        if (state === null) return null;
        ui.boot = state;
        store.set({
          idleMinutes: Number.isFinite(Number(state?.config?.idleMinutes))
            ? Number(state.config.idleMinutes)
            : 10,
          pinned: state?.helper?.pinned === true,
        });
        return state;
      };


      /* ---- session navigation ---- */
      let lastSummonAt = 0;
      const summon = async () => {
        const now = Date.now();
        if (ui.summoning || now - lastSummonAt < 400) return;
        lastSummonAt = now;
        ui.summoning = true;
        try {
          if (ui.boot === null) await loadBoot();
          const boot = ui.boot;
          const persisted = readPersisted();
          const limit = Number(view.idleMinutes ?? 10);
          const hiddenAt = Number(persisted.hiddenAt ?? 0);
          const stale = limit > 0 && hiddenAt > 0 && Date.now() - hiddenAt > limit * 60_000;
          report('summon', `stale=${stale} idle=${limit}m saved=${persisted.sessionId || '-'}`);

          let workspace;
          try {
            workspace = ctx.uiWorkspace;
          } catch (error) {
            if (ui.summonRetries < 20) {
              ui.summonRetries += 1;
              lastSummonAt = 0; // a retry is not a duplicate of the same show
              window.setTimeout(() => { void summon(); }, 300);
            } else {
              report('summon-failed', error instanceof Error ? error.message : String(error));
            }
            return;
          }
          ui.summonRetries = 0;
          if (!workspace) return;

          if (!stale && ui.hasLiveSession) return;
          if (!stale && typeof persisted.sessionId === 'string' && persisted.sessionId !== '') {
            try {
              workspace.openSession(persisted.sessionId);
              ui.hasLiveSession = true;
              ui.shownAt = Date.now();
              // The restored conversation's project becomes the remembered one.
              const rows = await listSessions(ctx);
              const row = rows.find((item) => item.id === persisted.sessionId);
              const restoredWorkspace = workspaceForPath(boot?.workspaces ?? [], row?.cwd ?? '');
              if (restoredWorkspace !== '' && restoredWorkspace !== persisted.workspaceId) {
                writePersisted({ workspaceId: restoredWorkspace });
              }
              report('restore', `${persisted.sessionId} cwd=${row?.cwd ?? '-'} ws=${restoredWorkspace || '-'}`);
              return;
            } catch { /* fall through to a new session */ }
          }

          const workspaceId = resolveWorkspace(boot, persisted);
          if (workspaceId === '') return;
          const presetId = typeof persisted.presetId === 'string' ? persisted.presetId : '';
          const before = await listSessions(ctx);
          workspace.startSession(workspaceId, presetId === '' ? undefined : { agentPreset: presetId });
          ui.hasLiveSession = true;
          writePersisted({
            sessionId: '',
            workspaceId,
            presetId,
            hiddenAt: 0,
            lastActivityAt: 0,
            summonBaseline: before.map((row) => row.id),
          });
          report('new-session', `${workspaceId} remembered=${persisted.workspaceId || '-'}`);
        } finally {
          ui.summoning = false;
        }
      };

      const newSession = async () => {
        try {
          const workspace = ctx.uiWorkspace;
          if (!workspace) return;
          if (ui.boot === null) await loadBoot();
          const boot = ui.boot;
          const persisted = readPersisted();
          const workspaceId = resolveWorkspace(boot, persisted);
          if (workspaceId === '') return;
          const presetId = typeof persisted.presetId === 'string' ? persisted.presetId : '';
          const before = await listSessions(ctx);
          workspace.startSession(workspaceId, presetId === '' ? undefined : { agentPreset: presetId });
          ui.hasLiveSession = true;
          writePersisted({
            sessionId: '',
            workspaceId,
            hiddenAt: 0,
            lastActivityAt: 0,
            summonBaseline: before.map((row) => row.id),
          });
          report('new-session', `${workspaceId} remembered=${persisted.workspaceId || '-'}`);
        } catch (error) {
          report('new-session-failed', error instanceof Error ? error.message : String(error));
        }
      };

      const noteHidden = () => {
        const persisted = readPersisted();
        writePersisted({ hiddenAt: Date.now() });
        void listSessions(ctx).then((rows) => {
          // The page knows which Session it shows; anything else (the globally
          // most recent Session) can belong to the main window.
          const current = currentSessionId();
          let chosen = current === '' ? null : rows.find((row) => row.id === current) ?? null;
          let source = 'current';
          if (chosen === null && typeof persisted.sessionId === 'string' && persisted.sessionId !== '') {
            chosen = rows.find((row) => row.id === persisted.sessionId) ?? null;
            source = 'remembered';
          }
          if (chosen === null) return;
          const workspaceId = workspaceForPath(ui.boot?.workspaces ?? [], chosen.cwd);
          writePersisted({
            sessionId: chosen.id,
            ...(workspaceId === '' ? {} : { workspaceId }),
          });
          report('captured-session', `${chosen.id} via=${source} cwd=${chosen.cwd} ws=${workspaceId || '-'} age=${Math.round((Date.now() - chosen.updatedAt) / 1000)}s`);
        });
      };

      const hideWindow = () => { void postJson(TRIGGER_PATH, { type: 'hide-window' }); };
      const togglePin = async () => {
        const result = await postJson(TRIGGER_PATH, { type: 'toggle-pin' });
        report('pin-click', `ok=${result?.ok === true} pinned=${String(result?.pinned)} before=${String(view.pinned)}`);
        if (result !== null && typeof result.pinned === 'boolean') store.set({ pinned: result.pinned });
      };

      /* ---- focus drives the session ---- */
      ctx.effect(() => {
        const onFocus = () => { void loadBoot(); void summon(); };
        const onBlur = () => { noteHidden(); };
        window.addEventListener('focus', onFocus);
        window.addEventListener('blur', onBlur);
        if (document.hasFocus()) window.setTimeout(onFocus, 80);
        return () => {
          window.removeEventListener('focus', onFocus);
          window.removeEventListener('blur', onBlur);
        };
      }, 'hotkey-popout: window focus');

      /* ---- shortcuts: ⌘W hide, ⌘N new session, ⌘⇧P pin ---- */
      ctx.effect(() => {
        const onKeyDown = (event) => {
          const meta = event.metaKey || event.ctrlKey;
          if (!meta || event.altKey) return;
          const key = String(event.key ?? '').toLowerCase();
          if (key === 'w' && !event.shiftKey) {
            event.preventDefault();
            event.stopPropagation();
            hideWindow();
            return;
          }
          if (key === 'n' && !event.shiftKey) {
            event.preventDefault();
            event.stopPropagation();
            void newSession();
            return;
          }
          if (key === 'p' && event.shiftKey) {
            event.preventDefault();
            event.stopPropagation();
            togglePin();
          }
        };
        window.addEventListener('keydown', onKeyDown, true);
        return () => window.removeEventListener('keydown', onKeyDown, true);
      }, 'hotkey-popout: shortcuts');

      /* ---- host channel: pin state + external navigation ---- */
      ctx.effect(() => {
        let stopped = false;
        let handled = null;
        const applyEvent = (event) => {
          if (!event || typeof event.type !== 'string') return;
          if (event.type === 'pinned') { store.set({ pinned: event.value === true }); return; }
          if (event.type === 'pin-click') { void togglePin(); return; }
          if (event.type === 'idle' && Number.isFinite(Number(event.value))) {
            store.set({ idleMinutes: Number(event.value) });
            return;
          }
          if (event.type === 'shown') {
            ui.shownAt = Date.now();
            void loadBoot();
            void summon();
            return;
          }
          if (event.type === 'hidden') { noteHidden(); return; }
          if (event.type === 'workspace' && typeof event.workspaceId === 'string' && event.workspaceId !== '') {
            writePersisted({ workspaceId: event.workspaceId });
            report('remember-workspace', event.workspaceId);
            return;
          }
          if (event.type === 'remember-session' && typeof event.sessionId === 'string') {
            // an empty id clears the remembered conversation (keeps the project)
            writePersisted({ sessionId: event.sessionId, hiddenAt: 0 });
            report('remember-session', event.sessionId || '(cleared)');
            return;
          }
          if (event.type === 'navigate' && typeof event.sessionId === 'string' && event.sessionId !== '') {
            try {
              ctx.uiWorkspace?.openSession?.(event.sessionId);
              writePersisted({ sessionId: event.sessionId, hiddenAt: 0 });
              ui.hasLiveSession = true;
            } catch { /* ignore */ }
          }
        };
        const accepts = (seq) => {
          if (typeof seq !== 'number') return true;
          if (handled === null) { handled = seq; return false; }
          if (seq <= handled) return false;
          handled = seq;
          return true;
        };
        const run = async () => {
          try {
            const ping = await fetch(PING_PATH, { credentials: 'same-origin', cache: 'no-store' });
            if (ping.ok) {
              const value = await ping.json();
              if (typeof value.seq === 'number') handled = value.seq;
            }
          } catch { /* replay is harmless */ }
          let failures = 0;
          while (!stopped) {
            try {
              const response = await fetch(`${WAIT_PATH}?since=${handled ?? 0}`, {
                credentials: 'same-origin', cache: 'no-store',
              });
              if (!response.ok) throw new Error(`HTTP ${response.status}`);
              const value = await response.json();
              failures = 0;
              for (const event of value?.events ?? []) {
                if (!accepts(event.seq)) continue;
                applyEvent(event);
              }
            } catch {
              failures += 1;
              await new Promise((resolve) => window.setTimeout(resolve, Math.min(2500, 300 * failures)));
            }
          }
        };
        void run();
        return () => { stopped = true; };
      }, 'hotkey-popout: host channel');

      /* ---- pin button: lives in the session header, which every session has ---- */
      function PinButton() {
        const state = React.useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
        const localeSnapshot = React.useSyncExternalStore(localeStore.subscribe, localeStore.getSnapshot, localeStore.getSnapshot);
        const t = React.useMemo(() => makeT(ctx), [ctx, localeSnapshot?.active, localeSnapshot?.revision]);
        const pinned = state.pinned === true;
        return h('button', {
          type: 'button',
          className: `dshp-pin${pinned ? ' is-on' : ''}`,
          title: pinned ? t('pinOff') : t('pinOn'),
          'aria-pressed': pinned,
          style: pinned ? { color: '#2f6ee0', opacity: 1 } : { opacity: 0.55 },
          onClick: () => { void togglePin(); },
        }, h(IconPin, { size: 15 }));
      }

      ctx.effect(() => ctx.slots.inject('conversation.session.header.utilities', () => ctx.slots.register({
        name: 'conversation.session.header.utilities',
        id: 'hotkey-popout-pin',
        order: -100,
      }, PinButton)), 'hotkey-popout: pin button');

    }

    /* -------------------------------------------------------------- entry -- */
    function apply(ctx) {
      const isFloatingWindow = window.__DSHP_WINDOW__ === true;
      try {
        ctx.locale.register(NS, {
          en: { title: 'Hotkey Popout' },
          zh: { title: '快捷键悬浮对话' },
        });
      } catch { /* namespace may already exist after a hot reload */ }

      if (isFloatingWindow) applyFloatingWindow(ctx);
      else applyAppWindow(ctx);
    }

    return {
      inject: ['slots', 'locale', 'remote', 'remote.session', 'layout', 'uiWorkspace'],
      apply,
    };
  },
});
