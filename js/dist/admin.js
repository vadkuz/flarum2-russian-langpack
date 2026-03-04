(function () {
  function unwrapModule(module) {
    if (!module) return null;
    return module.default || module;
  }

  var reg = flarum.reg;
  var app = null;
  var booted = false;

  var EXTENSION_ID = 'vadkuz-flarum2-russian-langpack';
  var AUTOSYNC_SETTING_KEY = 'vadkuz.russian_langpack.autosync_enabled';
  var PANEL_ID = 'vadkuz-ru-sync-panel';
  var PANEL_STYLE_ID = 'vadkuz-ru-sync-panel-style';
  var TICK_INTERVAL_MS = 12000;
  var settingsRegistered = false;

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
    if (settingsRegistered) return;
    if (!app || !app.registry || typeof app.registry.for !== 'function') return;

    var registry = app.registry.for(EXTENSION_ID);
    if (!registry || typeof registry.registerSetting !== 'function') return;

    registry.registerSetting({
      setting: AUTOSYNC_SETTING_KEY,
      type: 'boolean',
      label: trans(
        'vadkuz-flarum2-russian-langpack.admin.settings.autosync_label',
        'Включить автосинхронизацию переводов'
      ),
      help: trans(
        'vadkuz-flarum2-russian-langpack.admin.settings.autosync_help',
        'Если выключено, автоматическая подгрузка runtime-переводов из локального каталога/GitHub приостанавливается.'
      ),
    });

    settingsRegistered = true;
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
      'Autosync is disabled in extension settings.': [
        'vadkuz-flarum2-russian-langpack.admin.sync.msg.autosync_disabled',
        'Автосинхронизация отключена в настройках расширения.',
      ],
      'Reporting is disabled.': [
        'vadkuz-flarum2-russian-langpack.admin.sync.msg.reporting_disabled',
        'Webhook-отчёты отключены.',
      ],
      'Webhook URL is not configured.': [
        'vadkuz-flarum2-russian-langpack.admin.sync.msg.reporting_webhook_missing',
        'Webhook URL не настроен.',
      ],
      'Report interval not reached.': [
        'vadkuz-flarum2-russian-langpack.admin.sync.msg.reporting_interval_skip',
        'Интервал отправки отчёта ещё не наступил.',
      ],
      'Report sent.': [
        'vadkuz-flarum2-russian-langpack.admin.sync.msg.reporting_sent',
        'Webhook-отчёт отправлен.',
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

    var webhookStatus = text.match(/^Webhook responded with status (\d+)(:?)(.*)$/i);
    if (webhookStatus) {
      return trans(
        'vadkuz-flarum2-russian-langpack.admin.sync.msg.reporting_webhook_status',
        'Webhook вернул код {status}.',
        { status: webhookStatus[1] }
      );
    }

    var webhookFailed = text.match(/^Webhook request failed:/i);
    if (webhookFailed) {
      return trans(
        'vadkuz-flarum2-russian-langpack.admin.sync.msg.reporting_webhook_failed',
        'Ошибка запроса к webhook.'
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
    var synced = asCount(data.syncedCount);
    var missing = asCount(data.missingCount);
    var failed = asCount(data.failedCount);

    var autosyncEnabled = data.autosyncEnabled !== false;
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

    var isActive = autosyncEnabled && pending > 0;

    var status = document.createElement('div');
    status.className = 'vadkuz-ru-sync-status';
    status.style.fontSize = '12px';
    status.style.fontWeight = '600';
    status.style.marginBottom = '8px';

    var statusDot = document.createElement('span');
    statusDot.className = 'vadkuz-ru-sync-dot' + (isActive ? ' is-active' : '');
    status.appendChild(statusDot);

    var statusLabel = document.createElement('span');
    statusLabel.textContent = !autosyncEnabled
      ? trans('vadkuz-flarum2-russian-langpack.admin.sync.disabled', 'Autosync disabled')
      : isActive
      ? trans('vadkuz-flarum2-russian-langpack.admin.sync.syncing', 'Syncing...')
      : trans('vadkuz-flarum2-russian-langpack.admin.sync.idle', 'Waiting');
    statusLabel.style.color = !autosyncEnabled ? '#8a6d3b' : isActive ? '#1f6feb' : '#666';
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
    progressBar.style.backgroundColor = !autosyncEnabled ? '#9e9e9e' : pending > 0 ? '#1f8b4c' : '#2d7a2d';
    progressBar.style.transition = 'width 250ms ease';
    progressWrap.appendChild(progressBar);
    panel.appendChild(progressWrap);

    var progressText = document.createElement('div');
    progressText.textContent =
      trans('vadkuz-flarum2-russian-langpack.admin.sync.queue_progress', 'Sync queue') +
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
      metricItem(
        trans(
          'vadkuz-flarum2-russian-langpack.admin.sync.synced_session',
          'Synced in this session'
        ),
        synced
      )
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

    var translatedExtensions = Array.isArray(data.translatedExtensions) ? data.translatedExtensions : [];
    var missingExtensions = Array.isArray(data.missingExtensions) ? data.missingExtensions : [];
    if (translatedExtensions.length || missingExtensions.length) {
      var extTitle = document.createElement('div');
      extTitle.style.fontSize = '12px';
      extTitle.style.fontWeight = '700';
      extTitle.style.color = '#374151';
      extTitle.style.marginTop = '12px';
      extTitle.style.marginBottom = '8px';
      extTitle.textContent = trans(
        'vadkuz-flarum2-russian-langpack.admin.sync.extensions_status_title',
        'Общий статус переводов (сейчас)'
      );
      panel.appendChild(extTitle);

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
