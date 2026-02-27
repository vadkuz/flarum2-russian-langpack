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
  var PANEL_STYLE_ID = 'vadkuz-ru-sync-panel-style';
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
    ensurePanelStyles();

    var panel = document.getElementById(PANEL_ID);
    if (panel) return panel;

    var host = getPanelHost();
    if (!host) return null;
    hideDefaultNoSettingsMessage(host);

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

  function hideDefaultNoSettingsMessage(host) {
    var root = host || document;
    var headings = root.querySelectorAll('.ExtensionPage-settings h3, .ExtensionPage-body h3');
    if (!headings || !headings.length) return;

    for (var i = 0; i < headings.length; i++) {
      var heading = headings[i];
      var text = String(heading.textContent || '').trim().toLowerCase();

      if (
        text === 'расширение не имеет настроек.' ||
        text === 'расширение не имеет настроек' ||
        text === 'this extension has no settings.' ||
        text === 'this extension has no settings'
      ) {
        heading.style.display = 'none';
      }
    }
  }

  function ensurePanelStyles() {
    if (document.getElementById(PANEL_STYLE_ID)) return;

    var style = document.createElement('style');
    style.id = PANEL_STYLE_ID;
    style.textContent = [
      '@keyframes vadkuzRuSyncPulse {',
      '  0% { transform: scale(0.9); opacity: 0.55; }',
      '  50% { transform: scale(1.1); opacity: 1; }',
      '  100% { transform: scale(0.9); opacity: 0.55; }',
      '}',
      '@keyframes vadkuzRuSyncStripes {',
      '  0% { background-position: 0 0, 0 0; }',
      '  100% { background-position: 0 0, 36px 0; }',
      '}',
      '#' + PANEL_ID + ' .vadkuz-ru-sync-status {',
      '  display: flex;',
      '  align-items: center;',
      '  gap: 8px;',
      '}',
      '#' + PANEL_ID + ' .vadkuz-ru-sync-dot {',
      '  width: 8px;',
      '  height: 8px;',
      '  border-radius: 999px;',
      '  background: #6b7280;',
      '  flex: 0 0 auto;',
      '}',
      '#' + PANEL_ID + ' .vadkuz-ru-sync-dot.is-active {',
      '  background: #1f6feb;',
      '  animation: vadkuzRuSyncPulse 1s ease-in-out infinite;',
      '}',
      '#' + PANEL_ID + ' .vadkuz-ru-sync-bar.is-active {',
      '  background-image:',
      '    linear-gradient(90deg, #1f8b4c, #2ba35a),',
      '    repeating-linear-gradient(45deg, rgba(255,255,255,0.34) 0px, rgba(255,255,255,0.34) 10px, rgba(255,255,255,0.12) 10px, rgba(255,255,255,0.12) 20px);',
      '  background-size: 100% 100%, 36px 36px;',
      '  animation: vadkuzRuSyncStripes 1s linear infinite;',
      '}',
    ].join('\n');

    document.head.appendChild(style);
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

  function localizeSyncMessage(message) {
    var text = String(message || '').trim();
    if (!text) return '';

    var map = {
      'No pending translations.': [
        'vadkuz-flarum2-russian-langpack.admin.sync.msg.no_pending',
        'Нет ожидающих переводов.',
      ],
      'Translation copied from local catalog.': [
        'vadkuz-flarum2-russian-langpack.admin.sync.msg.local_catalog',
        'Перевод взят из локального каталога.',
      ],
      'Translation downloaded from GitHub.': [
        'vadkuz-flarum2-russian-langpack.admin.sync.msg.github_downloaded',
        'Перевод загружен с GitHub.',
      ],
      'Translation not found on GitHub.': [
        'vadkuz-flarum2-russian-langpack.admin.sync.msg.github_not_found',
        'Перевод не найден на GitHub.',
      ],
      'Queue refreshed from enabled extensions.': [
        'vadkuz-flarum2-russian-langpack.admin.sync.msg.queue_refreshed',
        'Очередь обновлена по списку включённых расширений.',
      ],
      'Invalid extension id.': [
        'vadkuz-flarum2-russian-langpack.admin.sync.msg.invalid_extension',
        'Некорректный идентификатор расширения.',
      ],
      'Downloaded file is empty or invalid.': [
        'vadkuz-flarum2-russian-langpack.admin.sync.msg.invalid_file',
        'Загруженный файл пустой или некорректный.',
      ],
      'Could not write runtime locale file.': [
        'vadkuz-flarum2-russian-langpack.admin.sync.msg.write_failed',
        'Не удалось записать runtime-файл перевода.',
      ],
      'Sync is already running.': [
        'vadkuz-flarum2-russian-langpack.admin.sync.msg.sync_running',
        'Синхронизация уже выполняется.',
      ],
      'Could not open sync lock file.': [
        'vadkuz-flarum2-russian-langpack.admin.sync.msg.lock_open_failed',
        'Не удалось открыть lock-файл синхронизации.',
      ],
    };

    if (Object.prototype.hasOwnProperty.call(map, text)) {
      var item = map[text];
      return trans(item[0], item[1]);
    }

    var githubStatus = text.match(/^GitHub request failed with status (\d+)\.$/i);
    if (githubStatus) {
      return trans(
        'vadkuz-flarum2-russian-langpack.admin.sync.msg.github_status',
        'Запрос к GitHub завершился с кодом {status}.',
        { status: githubStatus[1] }
      );
    }

    return text;
  }

  function asCount(value) {
    var n = Number(value);
    if (!isFinite(n) || n < 0) return 0;
    return Math.floor(n);
  }

  function metricItem(label, value) {
    var item = document.createElement('div');
    item.style.minWidth = '120px';
    item.style.padding = '8px 10px';
    item.style.background = '#f7f7f7';
    item.style.borderRadius = '6px';
    item.style.border = '1px solid rgba(0,0,0,0.06)';

    var labelEl = document.createElement('div');
    labelEl.textContent = label;
    labelEl.style.fontSize = '12px';
    labelEl.style.color = '#666';
    item.appendChild(labelEl);

    var valueEl = document.createElement('div');
    valueEl.textContent = String(value);
    valueEl.style.fontSize = '16px';
    valueEl.style.fontWeight = '700';
    valueEl.style.marginTop = '2px';
    valueEl.style.color = '#202020';
    item.appendChild(valueEl);

    return item;
  }

  function setPanelProgress(data) {
    var panel = ensurePanel();
    if (!panel) return;

    panel.innerHTML = '';

    var pending = asCount(data.pendingCount);
    var synced = asCount(data.syncedCount);
    var missing = asCount(data.missingCount);
    var failed = asCount(data.failedCount);

    var done = synced + missing;
    var total = done + pending;
    var percent = total > 0 ? Math.round((done * 100) / total) : 100;
    if (percent < 0) percent = 0;
    if (percent > 100) percent = 100;

    var title = document.createElement('div');
    title.textContent = trans(
      'vadkuz-flarum2-russian-langpack.admin.sync.panel_title',
      'Russian Translation Sync'
    );
    title.style.fontWeight = '700';
    title.style.marginBottom = '10px';
    panel.appendChild(title);

    var isActive = pending > 0;

    var status = document.createElement('div');
    status.className = 'vadkuz-ru-sync-status';
    status.style.fontSize = '12px';
    status.style.fontWeight = '600';
    status.style.marginBottom = '8px';

    var statusDot = document.createElement('span');
    statusDot.className = 'vadkuz-ru-sync-dot' + (isActive ? ' is-active' : '');
    status.appendChild(statusDot);

    var statusLabel = document.createElement('span');
    statusLabel.textContent = isActive
      ? trans('vadkuz-flarum2-russian-langpack.admin.sync.syncing', 'Syncing...')
      : trans('vadkuz-flarum2-russian-langpack.admin.sync.idle', 'Waiting');
    statusLabel.style.color = isActive ? '#1f6feb' : '#666';
    status.appendChild(statusLabel);

    panel.appendChild(status);

    var progressWrap = document.createElement('div');
    progressWrap.style.height = '12px';
    progressWrap.style.background = '#ececec';
    progressWrap.style.borderRadius = '999px';
    progressWrap.style.overflow = 'hidden';
    progressWrap.style.marginBottom = '8px';

    var progressBar = document.createElement('div');
    progressBar.className = 'vadkuz-ru-sync-bar' + (isActive ? ' is-active' : '');
    progressBar.style.height = '100%';
    progressBar.style.width = percent + '%';
    progressBar.style.backgroundColor = pending > 0 ? '#1f8b4c' : '#2d7a2d';
    progressBar.style.transition = 'width 250ms ease';
    progressWrap.appendChild(progressBar);
    panel.appendChild(progressWrap);

    var progressText = document.createElement('div');
    progressText.textContent =
      trans('vadkuz-flarum2-russian-langpack.admin.sync.progress', 'Progress') +
      ': ' +
      done +
      ' / ' +
      total +
      ' (' +
      percent +
      '%), ' +
      trans('vadkuz-flarum2-russian-langpack.admin.sync.remaining', 'Remaining') +
      ': ' +
      pending;
    progressText.style.fontSize = '13px';
    progressText.style.fontWeight = '600';
    progressText.style.marginBottom = '10px';
    progressText.style.color = '#333';
    panel.appendChild(progressText);

    var metrics = document.createElement('div');
    metrics.style.display = 'flex';
    metrics.style.flexWrap = 'wrap';
    metrics.style.gap = '8px';
    metrics.style.marginBottom = '10px';

    metrics.appendChild(
      metricItem(trans('vadkuz-flarum2-russian-langpack.admin.sync.queue', 'Queue'), pending)
    );
    metrics.appendChild(
      metricItem(trans('vadkuz-flarum2-russian-langpack.admin.sync.synced', 'Downloaded'), synced)
    );
    metrics.appendChild(
      metricItem(trans('vadkuz-flarum2-russian-langpack.admin.sync.missing', 'Missing'), missing)
    );
    metrics.appendChild(
      metricItem(trans('vadkuz-flarum2-russian-langpack.admin.sync.failed', 'Failed attempts'), failed)
    );
    panel.appendChild(metrics);

    if (data.processed && data.processed.extension) {
      var processed = document.createElement('div');
      processed.style.fontSize = '12px';
      processed.style.marginBottom = '8px';
      processed.style.color = '#555';
      processed.textContent =
        trans('vadkuz-flarum2-russian-langpack.admin.sync.current_extension', 'Last processed') +
        ': ' +
        data.processed.extension +
        (data.processed.result ? ' (' + data.processed.result + ')' : '');
      panel.appendChild(processed);
    }

    if (data.pendingPreview && data.pendingPreview.length) {
      var preview = document.createElement('div');
      preview.style.fontSize = '12px';
      preview.style.color = '#555';
      preview.style.marginBottom = '6px';
      preview.textContent = trans(
        'vadkuz-flarum2-russian-langpack.admin.sync.pending_preview',
        'Next in queue'
      ) + ':';
      panel.appendChild(preview);

      var previewList = document.createElement('div');
      previewList.style.fontSize = '12px';
      previewList.style.color = '#666';
      previewList.style.wordBreak = 'break-word';
      previewList.textContent = data.pendingPreview.slice(0, 8).join(', ');
      panel.appendChild(previewList);
    }

    if (data.lastMessage) {
      var message = document.createElement('div');
      message.style.fontSize = '12px';
      message.style.color = '#666';
      message.style.marginTop = '10px';
      message.textContent =
        trans('vadkuz-flarum2-russian-langpack.admin.sync.last_message', 'Message') +
        ': ' +
        localizeSyncMessage(data.lastMessage);
      panel.appendChild(message);
    }

    if (data.updatedAt) {
      var updatedAt = document.createElement('div');
      updatedAt.style.fontSize = '12px';
      updatedAt.style.color = '#666';
      updatedAt.style.marginTop = '4px';
      updatedAt.textContent =
        trans('vadkuz-flarum2-russian-langpack.admin.sync.updated_at', 'Updated at') +
        ': ' +
        data.updatedAt;
      panel.appendChild(updatedAt);
    }
  }

  function renderStatus() {
    if (!isOwnExtensionPage()) {
      removePanel();
      return;
    }

    hideDefaultNoSettingsMessage();

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

    setPanelProgress(state.data);
  }

  async function apiRequest(path, method) {
    var url = getApiBaseUrl() + path;

    if (app && typeof app.request === 'function') {
      return app.request({
        method: method || 'GET',
        url: url,
      });
    }

    var headers = {};
    if (app && app.session && app.session.csrfToken) {
      headers['X-CSRF-Token'] = app.session.csrfToken;
      if (app.session.user && typeof app.session.user.id === 'function') {
        headers.Authorization = 'Token ' + app.session.csrfToken + '; userId=' + app.session.user.id();
      }
    }

    var response = await fetch(url, {
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
