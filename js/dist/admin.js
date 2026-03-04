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
    reloadedAfterSync: false,
  };
  var loadingSkeletonTimer = null;
  var loadingSkeletonMinUntil = 0;
  var loadingSkeletonDelayTimer = null;

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

  function registerExtensionSettings() {
    // Autosync is always enabled in simplified mode.
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

    panel = document.createElement('div');
    panel.id = PANEL_ID;
    panel.style.marginTop = '12px';
    panel.style.padding = '12px';
    panel.style.border = '1px solid rgba(0,0,0,0.1)';
    panel.style.borderRadius = '8px';
    panel.style.background = '#fff';
    panel.dataset.skeletonUntil = String(Date.now() + 450);

    host.appendChild(panel);
    return panel;
  }

  function getSkeletonMinUntil() {
    var minUntil = loadingSkeletonMinUntil;
    var panel = document.getElementById(PANEL_ID);
    if (panel && panel.dataset && panel.dataset.skeletonUntil) {
      var panelMinUntil = parseInt(panel.dataset.skeletonUntil, 10);
      if (!Number.isNaN(panelMinUntil) && panelMinUntil > minUntil) {
        minUntil = panelMinUntil;
      }
    }
    return minUntil;
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
      '@keyframes vadkuzRuSkeletonShimmer {',
      '  0% { background-position: 100% 0; }',
      '  100% { background-position: -100% 0; }',
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
      '#' + PANEL_ID + ' .vadkuz-ru-skeleton {',
      '  border-radius: 6px;',
      '  background: linear-gradient(90deg, #eceff3 25%, #f7f9fb 37%, #eceff3 63%);',
      '  background-size: 400% 100%;',
      '  animation: vadkuzRuSkeletonShimmer 1.2s ease-in-out infinite;',
      '}',
      '#' + PANEL_ID + ' .vadkuz-ru-check-btn {',
      '  font-size: 12px;',
      '  font-weight: 600;',
      '  padding: 6px 10px;',
      '  border-radius: 6px;',
      '  border: 1px solid #c7ced8 !important;',
      '  background: #ffffff !important;',
      '  color: #1f2937 !important;',
      '  cursor: pointer;',
      '  transition: background-color .12s ease, border-color .12s ease, box-shadow .12s ease, transform .05s ease;',
      '}',
      '#' + PANEL_ID + ' .vadkuz-ru-check-btn:hover:not(:disabled) {',
      '  background: #eef4ff !important;',
      '  border-color: #4b77d9 !important;',
      '  box-shadow: 0 0 0 2px rgba(31, 111, 235, 0.14) !important;',
      '}',
      '#' + PANEL_ID + ' .vadkuz-ru-check-btn:active:not(:disabled) {',
      '  background: #e1ebff !important;',
      '  border-color: #315fbf !important;',
      '  transform: translateY(1px) scale(0.99);',
      '  box-shadow: inset 0 1px 2px rgba(0, 0, 0, 0.12) !important;',
      '}',
      '#' + PANEL_ID + ' .vadkuz-ru-check-btn:focus-visible {',
      '  outline: none;',
      '  box-shadow: 0 0 0 2px rgba(31, 111, 235, 0.30) !important;',
      '  border-color: #1f6feb !important;',
      '}',
      '#' + PANEL_ID + ' .vadkuz-ru-check-btn:disabled {',
      '  cursor: not-allowed;',
      '  opacity: .72;',
      '  background: #f3f4f6 !important;',
      '  border-color: #d1d5db !important;',
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

  function skeletonBlock(height, width, marginBottom, radius) {
    var el = document.createElement('div');
    el.className = 'vadkuz-ru-skeleton';
    el.style.height = (height || 12) + 'px';
    el.style.width = width || '100%';
    el.style.borderRadius = (typeof radius === 'number' ? radius : 6) + 'px';
    if (typeof marginBottom === 'number') {
      el.style.marginBottom = marginBottom + 'px';
    }
    return el;
  }

  function setPanelSkeleton() {
    var panel = ensurePanel();
    if (!panel) return;
    panel.innerHTML = '';

    panel.appendChild(skeletonBlock(16, '220px', 12, 6));

    var statusRow = document.createElement('div');
    statusRow.style.display = 'flex';
    statusRow.style.alignItems = 'center';
    statusRow.style.gap = '8px';
    statusRow.style.marginBottom = '10px';
    statusRow.appendChild(skeletonBlock(8, '8px', 0, 999));
    statusRow.appendChild(skeletonBlock(12, '130px', 0, 6));
    panel.appendChild(statusRow);

    var progressWrap = document.createElement('div');
    progressWrap.style.height = '12px';
    progressWrap.style.background = '#ececec';
    progressWrap.style.borderRadius = '999px';
    progressWrap.style.overflow = 'hidden';
    progressWrap.style.marginBottom = '10px';
    progressWrap.appendChild(skeletonBlock(12, '62%', 0, 999));
    panel.appendChild(progressWrap);

    panel.appendChild(skeletonBlock(13, '280px', 10, 6));

    var metrics = document.createElement('div');
    metrics.style.display = 'flex';
    metrics.style.flexWrap = 'wrap';
    metrics.style.gap = '8px';
    metrics.style.marginBottom = '12px';
    for (var i = 0; i < 4; i += 1) {
      var card = document.createElement('div');
      card.style.flex = '1 1 120px';
      card.style.minWidth = '120px';
      card.style.border = '1px solid rgba(0,0,0,0.08)';
      card.style.borderRadius = '6px';
      card.style.padding = '10px';
      card.style.background = '#f8f8f8';
      card.appendChild(skeletonBlock(12, '70%', 8, 4));
      card.appendChild(skeletonBlock(18, '26px', 0, 4));
      metrics.appendChild(card);
    }
    panel.appendChild(metrics);

    panel.appendChild(skeletonBlock(12, '320px', 8, 6));

    var sections = document.createElement('div');
    sections.style.display = 'flex';
    sections.style.flexWrap = 'wrap';
    sections.style.gap = '8px';
    sections.style.marginBottom = '10px';
    for (var s = 0; s < 2; s += 1) {
      var section = document.createElement('div');
      section.style.flex = '1 1 320px';
      section.style.minWidth = '260px';
      section.style.border = '1px solid #e5e7eb';
      section.style.borderRadius = '8px';
      section.style.padding = '10px';
      section.style.background = '#fafafa';
      section.appendChild(skeletonBlock(12, '160px', 8, 4));
      var chips = document.createElement('div');
      chips.style.display = 'flex';
      chips.style.flexWrap = 'wrap';
      chips.style.gap = '6px';
      for (var c = 0; c < 8; c += 1) {
        chips.appendChild(skeletonBlock(24, (78 + (c % 4) * 20) + 'px', 0, 999));
      }
      section.appendChild(chips);
      sections.appendChild(section);
    }
    panel.appendChild(sections);

    panel.appendChild(skeletonBlock(12, '300px', 6, 6));
    panel.appendChild(skeletonBlock(12, '220px', 0, 6));
  }

  function startLoadingSkeletonLoop() {
    var minUntil = Date.now() + 450;
    if (minUntil > loadingSkeletonMinUntil) {
      loadingSkeletonMinUntil = minUntil;
    }
    if (loadingSkeletonTimer) return;
    loadingSkeletonTimer = window.setInterval(function () {
      if (!isOwnExtensionPage() || state.data || state.error) {
        stopLoadingSkeletonLoop();
        return;
      }
      setPanelSkeleton();
    }, 150);
  }

  function stopLoadingSkeletonLoop() {
    if (!loadingSkeletonTimer) return;
    window.clearInterval(loadingSkeletonTimer);
    loadingSkeletonTimer = null;
  }

  function clearLoadingDelayTimer() {
    if (!loadingSkeletonDelayTimer) return;
    window.clearTimeout(loadingSkeletonDelayTimer);
    loadingSkeletonDelayTimer = null;
  }

  function asCount(value) {
    var n = Number(value);
    if (!isFinite(n) || n < 0) return 0;
    return Math.floor(n);
  }

  function asUnixTs(value) {
    var n = Number(value);
    if (!isFinite(n) || n <= 0) return 0;
    return Math.floor(n);
  }

  function secondsLeft(ts) {
    var now = Math.floor(Date.now() / 1000);
    return Math.max(0, ts - now);
  }

  function formatAgoFromTs(ts) {
    if (!ts || ts <= 0) return '—';
    var sec = secondsLeft(ts);
    if (sec === 0) {
      var delta = Math.max(0, Math.floor(Date.now() / 1000) - ts);
      if (delta <= 4) return trans('vadkuz-flarum2-russian-langpack.admin.sync.just_now', 'только что');
      if (delta < 60) return delta + ' c назад';
      var mins = Math.floor(delta / 60);
      if (mins < 60) return mins + ' мин назад';
      var hours = Math.floor(mins / 60);
      return hours + ' ч назад';
    }
    return '—';
  }

  function statusSection(title, items, chipBg, chipColor) {
    var wrap = document.createElement('div');
    wrap.style.flex = '1 1 320px';
    wrap.style.minWidth = '260px';
    wrap.style.border = '1px solid #e5e7eb';
    wrap.style.borderRadius = '8px';
    wrap.style.padding = '10px';
    wrap.style.background = '#fafafa';

    var heading = document.createElement('div');
    heading.textContent = title + ' (' + items.length + ')';
    heading.style.fontSize = '12px';
    heading.style.fontWeight = '700';
    heading.style.color = '#374151';
    heading.style.marginBottom = '8px';
    wrap.appendChild(heading);

    if (!items.length) {
      var empty = document.createElement('div');
      empty.style.fontSize = '12px';
      empty.style.color = '#9ca3af';
      empty.textContent = '—';
      wrap.appendChild(empty);
      return wrap;
    }

    var groups = {};
    items.forEach(function (id) {
      var text = String(id || '').trim();
      if (!text) return;
      var idx = text.indexOf('/');
      var vendor = idx > 0 ? text.slice(0, idx) : 'other';
      if (!groups[vendor]) groups[vendor] = [];
      groups[vendor].push(text);
    });

    Object.keys(groups)
      .sort()
      .forEach(function (vendor) {
        var groupWrap = document.createElement('div');
        groupWrap.style.marginBottom = '8px';

        var groupTitle = document.createElement('div');
        groupTitle.textContent = vendor + ' (' + groups[vendor].length + ')';
        groupTitle.style.fontSize = '11px';
        groupTitle.style.fontWeight = '700';
        groupTitle.style.color = '#6b7280';
        groupTitle.style.marginBottom = '4px';
        groupWrap.appendChild(groupTitle);

        var list = document.createElement('div');
        list.style.display = 'flex';
        list.style.flexWrap = 'wrap';
        list.style.gap = '6px';

        groups[vendor].sort().forEach(function (id) {
          var chip = document.createElement('span');
          chip.textContent = id;
          chip.style.fontSize = '12px';
          chip.style.lineHeight = '1.2';
          chip.style.padding = '4px 8px';
          chip.style.borderRadius = '999px';
          chip.style.background = chipBg;
          chip.style.color = chipColor;
          chip.style.border = '1px solid rgba(0,0,0,0.08)';
          list.appendChild(chip);
        });

        groupWrap.appendChild(list);
        wrap.appendChild(groupWrap);
      });

    return wrap;
  }

  function setPanelProgress(data) {
    var panel = ensurePanel();
    if (!panel) return;

    panel.innerHTML = '';

    var pending = asCount(data.pendingCount);
    var failed = asCount(data.failedCount);
    var translatedCount = asCount(data.translatedExtensionsCount);
    var missingCount = asCount(data.missingExtensionsCount);

    var title = document.createElement('div');
    title.textContent = trans(
      'vadkuz-flarum2-russian-langpack.admin.sync.panel_title',
      'Russian Translation Sync'
    );
    title.style.fontWeight = '700';
    title.style.marginBottom = '10px';
    panel.appendChild(title);

    var isActive = pending > 0;
    var tickMeta = data.tickMeta && typeof data.tickMeta === 'object' ? data.tickMeta : null;
    var lastTickTs = tickMeta ? asUnixTs(tickMeta.lastTickTs) : 0;
    var nextTickTs = tickMeta ? asUnixTs(tickMeta.nextTickTs) : 0;

    var uiState = 'ok';
    if (isActive) {
      uiState = 'syncing';
    } else if (failed > 0) {
      uiState = 'warn';
    }

    var uiStateLabel = uiState === 'syncing'
      ? trans('vadkuz-flarum2-russian-langpack.admin.sync.state_syncing', 'Идёт проверка')
      : uiState === 'warn'
      ? trans('vadkuz-flarum2-russian-langpack.admin.sync.state_warn', 'Требуется внимание')
      : trans('vadkuz-flarum2-russian-langpack.admin.sync.state_ok', 'Переводы актуальны');
    var uiStateColor = uiState === 'syncing' ? '#1f6feb' : uiState === 'warn' ? '#b45309' : '#166534';
    var uiStateBg = uiState === 'syncing' ? '#e8f1ff' : uiState === 'warn' ? '#fff5eb' : '#eaf8ef';
    var uiStateBorder = uiState === 'syncing' ? '#cfe2ff' : uiState === 'warn' ? '#ffd7a6' : '#bfe5cc';

    var status = document.createElement('div');
    status.style.display = 'flex';
    status.style.alignItems = 'center';
    status.style.justifyContent = 'space-between';
    status.style.gap = '8px';
    status.style.marginBottom = '8px';

    var statusBadge = document.createElement('span');
    statusBadge.textContent = trans('vadkuz-flarum2-russian-langpack.admin.sync.status', 'Статус') + ': ' + uiStateLabel;
    statusBadge.style.display = 'inline-flex';
    statusBadge.style.alignItems = 'center';
    statusBadge.style.padding = '4px 10px';
    statusBadge.style.borderRadius = '999px';
    statusBadge.style.fontSize = '12px';
    statusBadge.style.fontWeight = '700';
    statusBadge.style.color = uiStateColor;
    statusBadge.style.background = uiStateBg;
    statusBadge.style.border = '1px solid ' + uiStateBorder;
    status.appendChild(statusBadge);

    var checkNowBtn = document.createElement('button');
    checkNowBtn.type = 'button';
    checkNowBtn.className = 'vadkuz-ru-check-btn';
    checkNowBtn.textContent = trans('vadkuz-flarum2-russian-langpack.admin.sync.check_now', 'Проверить сейчас');
    checkNowBtn.disabled = !!state.inFlight;
    checkNowBtn.style.cursor = state.inFlight ? 'not-allowed' : 'pointer';

    var setBtnBase = function () {
      checkNowBtn.style.backgroundColor = state.inFlight ? '#f3f4f6' : '#ffffff';
      checkNowBtn.style.borderColor = state.inFlight ? '#d1d5db' : '#c7ced8';
      checkNowBtn.style.boxShadow = 'none';
      checkNowBtn.style.transform = 'none';
    };
    var setBtnHover = function () {
      if (state.inFlight) return;
      checkNowBtn.style.backgroundColor = '#eef4ff';
      checkNowBtn.style.borderColor = '#4b77d9';
      checkNowBtn.style.boxShadow = '0 0 0 2px rgba(31, 111, 235, 0.14)';
    };
    var setBtnActive = function () {
      if (state.inFlight) return;
      checkNowBtn.style.backgroundColor = '#e1ebff';
      checkNowBtn.style.borderColor = '#315fbf';
      checkNowBtn.style.boxShadow = 'inset 0 1px 2px rgba(0, 0, 0, 0.12)';
      checkNowBtn.style.transform = 'translateY(1px) scale(0.99)';
    };
    var setBtnFocus = function () {
      if (state.inFlight) return;
      checkNowBtn.style.boxShadow = '0 0 0 2px rgba(31, 111, 235, 0.30)';
      checkNowBtn.style.borderColor = '#1f6feb';
    };

    setBtnBase();
    checkNowBtn.addEventListener('mouseenter', setBtnHover);
    checkNowBtn.addEventListener('mouseleave', setBtnBase);
    checkNowBtn.addEventListener('mousedown', setBtnActive);
    checkNowBtn.addEventListener('mouseup', setBtnHover);
    checkNowBtn.addEventListener('focus', setBtnFocus);
    checkNowBtn.addEventListener('blur', setBtnBase);
    checkNowBtn.addEventListener('click', function () {
      if (state.inFlight) return;
      state.lastRequestAt = 0;
      runStatus().then(runTick);
    });
    status.appendChild(checkNowBtn);
    panel.appendChild(status);

    var line1 = document.createElement('div');
    line1.style.fontSize = '13px';
    line1.style.color = '#374151';
    line1.style.marginTop = '2px';
    line1.style.marginBottom = '6px';
    line1.textContent =
      trans('vadkuz-flarum2-russian-langpack.admin.sync.checked', 'Проверено') +
      ': ' +
      formatAgoFromTs(lastTickTs) +
      ' · ' +
      trans('vadkuz-flarum2-russian-langpack.admin.sync.next_check_in', 'Следующая проверка через') +
      ': ' +
      (nextTickTs > 0 ? secondsLeft(nextTickTs) + ' c' : '0 c');
    panel.appendChild(line1);

    var line3 = document.createElement('div');
    line3.style.fontSize = '13px';
    line3.style.color = '#374151';
    line3.textContent =
      trans('vadkuz-flarum2-russian-langpack.admin.sync.queue', 'В очереди') +
      ': ' +
      pending;
    panel.appendChild(line3);

    var translatedExtensions = Array.isArray(data.translatedExtensions) ? data.translatedExtensions : [];
    var missingExtensions = Array.isArray(data.missingExtensions) ? data.missingExtensions : [];
    if (translatedExtensions.length || missingExtensions.length) {
      var sections = document.createElement('div');
      sections.style.display = 'flex';
      sections.style.flexWrap = 'wrap';
      sections.style.gap = '8px';
      sections.style.marginBottom = '8px';

      sections.appendChild(
        statusSection(
          trans('vadkuz-flarum2-russian-langpack.admin.sync.translated_extensions', 'Перевод есть'),
          translatedExtensions,
          '#e8f8ef',
          '#116329'
        )
      );
      sections.appendChild(
        statusSection(
          trans('vadkuz-flarum2-russian-langpack.admin.sync.missing_extensions', 'Перевод отсутствует'),
          missingExtensions,
          '#fff0f0',
          '#9b1c1c'
        )
      );

      panel.appendChild(sections);
    }

  }

  function renderStatus() {
    if (!isOwnExtensionPage()) {
      clearLoadingDelayTimer();
      stopLoadingSkeletonLoop();
      removePanel();
      return;
    }

    if (state.error) {
      clearLoadingDelayTimer();
      stopLoadingSkeletonLoop();
      setPanelText(state.error, true);
      return;
    }

    if (!state.data) {
      clearLoadingDelayTimer();
      startLoadingSkeletonLoop();
      setPanelSkeleton();
      return;
    }

    var now = Date.now();
    var minUntil = getSkeletonMinUntil();
    if (now < minUntil) {
      setPanelSkeleton();
      clearLoadingDelayTimer();
      loadingSkeletonDelayTimer = window.setTimeout(function () {
        loadingSkeletonDelayTimer = null;
        renderStatus();
      }, minUntil - now);
      return;
    }

    clearLoadingDelayTimer();
    stopLoadingSkeletonLoop();
    var panel = ensurePanel();
    if (panel && panel.dataset) {
      delete panel.dataset.skeletonUntil;
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
      var previousData = state.data;
      state.error = '';
      state.data = await apiRequest('/ru-langpack/sync/tick', 'POST');
      maybeReloadAfterSync(previousData, state.data);
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

  function maybeReloadAfterSync(previousData, currentData) {
    if (!isOwnExtensionPage()) return;
    if (state.reloadedAfterSync) return;
    if (!currentData) return;

    var previousPending = asCount(previousData && previousData.pendingCount);
    var currentPending = asCount(currentData.pendingCount);
    var currentSynced = asCount(currentData.syncedCount);

    // Apply freshly downloaded runtime translations immediately after sync queue completion.
    if (previousPending > 0 && currentPending === 0 && currentSynced > 0) {
      state.reloadedAfterSync = true;
      window.setTimeout(function () {
        window.location.reload();
      }, 600);
    }
  }

  function runLoop() {
    if (!isOwnExtensionPage()) {
      clearLoadingDelayTimer();
      stopLoadingSkeletonLoop();
      removePanel();
      return;
    }

    if (!state.data) {
      startLoadingSkeletonLoop();
      setPanelSkeleton();
      if (!ensurePanel()) {
        // Wait until Flarum renders extension settings container,
        // so skeleton is visible before first status response.
        window.setTimeout(runLoop, 120);
        return;
      }
      runStatus().then(runTick);
      return;
    }

    runTick();
  }

  function boot() {
    if (booted || !app) return;
    booted = true;
    registerExtensionSettings();

    window.addEventListener('hashchange', function () {
      state.lastRequestAt = 0;
      state.reloadedAfterSync = false;
      state.data = null;
      state.error = '';
      loadingSkeletonMinUntil = 0;
      clearLoadingDelayTimer();
      registerExtensionSettings();
      startLoadingSkeletonLoop();
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
