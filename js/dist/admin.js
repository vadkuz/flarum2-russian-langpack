(function () {
  function unwrapModule(module) {
    if (!module) return null;
    return module.default || module;
  }

  var reg = flarum.reg;
  var app = null;
  var booted = false;

  var EXTENSION_ID = 'vadkuz-flarum2-russian-langpack';
  var PANEL_ID = 'vadkuz-ru-sync-panel';
  var TICK_INTERVAL_MS = 12000;

  var state = {
    inFlight: false,
    data: null,
    error: '',
    lastRequestAt: 0,
  };

  function getApiBaseUrl() {
    try {
      if (app && app.forum && typeof app.forum.attribute === 'function') {
        var apiUrl = String(app.forum.attribute('apiUrl') || '').trim();
        if (apiUrl) {
          return apiUrl.replace(/\/+$/, '');
        }
      }
    } catch (_e) {}

    return '/api';
  }

  function isOwnExtensionPage() {
    var hash = String(window.location.hash || '');
    return hash.indexOf('#/extension/' + EXTENSION_ID) === 0;
  }

  function trans(key, fallback, params) {
    try {
      if (app && app.translator && typeof app.translator.trans === 'function') {
        var value = app.translator.trans(key, params || {});
        if (value && value !== key) return value;
      }
    } catch (_e) {}

    return fallback;
  }

  function getPanelHost() {
    return (
      document.querySelector('.ExtensionPage-settings') ||
      document.querySelector('.ExtensionPage .containerNarrow') ||
      document.querySelector('.ExtensionPage')
    );
  }

  function ensurePanel() {
    var panel = document.getElementById(PANEL_ID);
    if (panel) return panel;

    var host = getPanelHost();
    if (!host) return null;

    panel = document.createElement('div');
    panel.id = PANEL_ID;
    panel.style.marginTop = '12px';
    panel.style.padding = '12px';
    panel.style.border = '1px solid rgba(0,0,0,0.1)';
    panel.style.borderRadius = '8px';
    panel.style.background = '#fff';

    host.appendChild(panel);
    return panel;
  }

  function removePanel() {
    var panel = document.getElementById(PANEL_ID);
    if (panel && panel.parentNode) {
      panel.parentNode.removeChild(panel);
    }
  }

  function setPanelText(text, isError) {
    var panel = ensurePanel();
    if (!panel) return;

    panel.innerHTML = '';

    var title = document.createElement('div');
    title.textContent = trans(
      'vadkuz-flarum2-russian-langpack.admin.sync.panel_title',
      'Russian Translation Sync'
    );
    title.style.fontWeight = '600';
    title.style.marginBottom = '8px';
    panel.appendChild(title);

    var body = document.createElement('div');
    body.textContent = text;
    body.style.whiteSpace = 'pre-wrap';
    body.style.fontSize = '13px';
    body.style.lineHeight = '1.4';
    body.style.color = isError ? '#b72f2f' : '#4d4d4d';
    panel.appendChild(body);
  }

  function renderStatus() {
    if (!isOwnExtensionPage()) {
      removePanel();
      return;
    }

    if (state.error) {
      setPanelText(state.error, true);
      return;
    }

    if (!state.data) {
      setPanelText(
        trans('vadkuz-flarum2-russian-langpack.admin.sync.loading', 'Loading sync status...'),
        false
      );
      return;
    }

    var data = state.data;
    var lines = [];

    lines.push(
      trans('vadkuz-flarum2-russian-langpack.admin.sync.queue', 'Queue') + ': ' + (data.pendingCount || 0)
    );
    lines.push(
      trans('vadkuz-flarum2-russian-langpack.admin.sync.synced', 'Downloaded') + ': ' + (data.syncedCount || 0)
    );
    lines.push(
      trans('vadkuz-flarum2-russian-langpack.admin.sync.missing', 'Missing') + ': ' + (data.missingCount || 0)
    );

    if (data.lastAction) {
      lines.push(
        trans('vadkuz-flarum2-russian-langpack.admin.sync.last_action', 'Last action') + ': ' + data.lastAction
      );
    }

    if (data.lastMessage) {
      lines.push(
        trans('vadkuz-flarum2-russian-langpack.admin.sync.last_message', 'Message') + ': ' + data.lastMessage
      );
    }

    if (data.updatedAt) {
      lines.push(
        trans('vadkuz-flarum2-russian-langpack.admin.sync.updated_at', 'Updated at') + ': ' + data.updatedAt
      );
    }

    setPanelText(lines.join('\n'), false);
  }

  async function apiRequest(path, method) {
    var headers = {};
    if (app && app.session && app.session.csrfToken) {
      headers['X-CSRF-Token'] = app.session.csrfToken;
    }

    var response = await fetch(getApiBaseUrl() + path, {
      method: method || 'GET',
      credentials: 'same-origin',
      headers: headers,
    });

    var payload = null;
    try {
      payload = await response.json();
    } catch (_e) {
      payload = null;
    }

    if (!response.ok) {
      var message = payload && payload.error ? payload.error : 'Sync request failed.';
      throw new Error(message);
    }

    return payload || {};
  }

  async function runTick() {
    if (!isOwnExtensionPage()) return;
    if (state.inFlight) return;

    var now = Date.now();
    if (now - state.lastRequestAt < TICK_INTERVAL_MS) return;

    state.inFlight = true;
    state.lastRequestAt = now;

    try {
      state.error = '';
      state.data = await apiRequest('/ru-langpack/sync/tick', 'POST');
    } catch (error) {
      state.error = (error && error.message) ? error.message : 'Sync failed.';
    } finally {
      state.inFlight = false;
      renderStatus();
    }
  }

  async function runStatus() {
    if (!isOwnExtensionPage()) return;
    if (state.inFlight) return;

    state.inFlight = true;
    try {
      state.error = '';
      state.data = await apiRequest('/ru-langpack/sync/status', 'GET');
    } catch (error) {
      state.error = (error && error.message) ? error.message : 'Could not load sync status.';
    } finally {
      state.inFlight = false;
      renderStatus();
    }
  }

  function runLoop() {
    if (!isOwnExtensionPage()) {
      removePanel();
      return;
    }

    if (!state.data) {
      runStatus().then(runTick);
      return;
    }

    runTick();
  }

  function boot() {
    if (booted || !app) return;
    booted = true;

    window.addEventListener('hashchange', function () {
      state.lastRequestAt = 0;
      runLoop();
    });

    setInterval(runLoop, 3000);
    runLoop();
  }

  function loadModule(namespace, id, assign) {
    var current = unwrapModule(reg.get(namespace, id));
    if (current) {
      assign(current);
      boot();
      return;
    }

    reg.onLoad(namespace, id, function (module) {
      assign(unwrapModule(module));
      boot();
    });
  }

  loadModule('core', 'admin/app', function (module) {
    app = module;
  });
})();

module.exports = { extend: [] };
