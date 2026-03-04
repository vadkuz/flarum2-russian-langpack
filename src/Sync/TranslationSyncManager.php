<?php

namespace Vadkuz\RussianLangpack\Sync;

use Illuminate\Contracts\Config\Repository as ConfigRepository;
use Flarum\Settings\SettingsRepositoryInterface;

class TranslationSyncManager
{
    private const STATE_KEY = 'vadkuz.russian_langpack.sync_state';
    private const REPORTING_SHARED_KEY_KEY = 'vadkuz.russian_langpack.reporting_shared_key';
    private const EXTENSIONS_ENABLED_KEY = 'extensions_enabled';
    private const MAX_RETRIES = 3;
    private const MIN_TICK_INTERVAL_SECONDS = 8;
    private const MISSING_COOLDOWN_SECONDS = 21600;
    private const FAILED_COOLDOWN_SECONDS = 1800;
    private const MAX_RETRY_BACKOFF_SECONDS = 900;
    private const REPORTING_INTERVAL_MINUTES = 60;
    private const REPORTING_WEBHOOK_URL = 'https://flarum.vadim.online/api/langpack/ingest';

    private const SELF_EXTENSION_ID = 'vadkuz-flarum2-russian-langpack';
    private string $packageRoot;
    private string $catalogLocaleDir;
    private string $coreLocaleDir;
    private string $runtimeLocaleDir;
    /** @var array<string, bool> */
    private array $nativeTranslationPresence = [];

    public function __construct(
        private readonly SettingsRepositoryInterface $settings,
        private readonly ConfigRepository $config
    )
    {
        $this->packageRoot = dirname(__DIR__, 2);
        $this->catalogLocaleDir = $this->packageRoot.'/locale-catalog';
        $this->coreLocaleDir = $this->packageRoot.'/locale-core';
        $this->runtimeLocaleDir = $this->packageRoot.'/runtime-locale';
    }

    /**
     * @return array<string, mixed>
     */
    public function getStatus(): array
    {
        return $this->withLock(function (): array {
            $state = $this->loadState();

            $state = $this->refreshQueue($state);
            $state = $this->maybeSendReport($state, null, false, 'status');
            $this->saveState($state);

            return $this->buildResponse($state, null);
        });
    }

    /**
     * @return array<string, mixed>
     */
    public function tick(): array
    {
        return $this->withLock(function (): array {
            $state = $this->loadState();

            $state = $this->refreshQueue($state);
            $nowTs = time();
            $lastTickTs = (int) ($state['lastTickTs'] ?? 0);
            if ($lastTickTs > 0 && ($nowTs - $lastTickTs) < self::MIN_TICK_INTERVAL_SECONDS) {
                $state['updatedAt'] = gmdate('c');
                $this->saveState($state);

                return $this->buildResponse($state, null);
            }
            $state['lastTickTs'] = $nowTs;

            $processed = null;
            $pending = $this->normalizeStringList($state['pending'] ?? []);

            if ($pending !== []) {
                $extensionId = array_shift($pending);
                $state['pending'] = $pending;

                $result = $this->syncOneExtension($extensionId);
                $processed = [
                    'extension' => $extensionId,
                    'result' => $result['status'],
                    'message' => $result['message'],
                ];

                if ($result['status'] === 'synced') {
                    $state['cacheDirty'] = true;
                    $synced = $this->normalizeStringList($state['synced'] ?? []);
                    $synced[] = $extensionId;
                    $state['synced'] = array_values(array_unique($synced));
                    $state['missing'] = array_values(array_diff(
                        $this->normalizeStringList($state['missing'] ?? []),
                        [$extensionId]
                    ));
                    $failed = $this->normalizeIntMap($state['failed'] ?? []);
                    unset($failed[$extensionId]);
                    $state['failed'] = $failed;
                    $missingCooldownUntil = $this->normalizeTimestampMap($state['missingCooldownUntil'] ?? []);
                    unset($missingCooldownUntil[$extensionId]);
                    $state['missingCooldownUntil'] = $missingCooldownUntil;
                    $retryAfter = $this->normalizeTimestampMap($state['retryAfter'] ?? []);
                    unset($retryAfter[$extensionId]);
                    $state['retryAfter'] = $retryAfter;
                    $state['lastAction'] = 'synced';
                } elseif ($result['status'] === 'missing') {
                    $missing = $this->normalizeStringList($state['missing'] ?? []);
                    $missing[] = $extensionId;
                    $state['missing'] = array_values(array_unique($missing));
                    $missingCooldownUntil = $this->normalizeTimestampMap($state['missingCooldownUntil'] ?? []);
                    $missingCooldownUntil[$extensionId] = time() + self::MISSING_COOLDOWN_SECONDS;
                    $state['missingCooldownUntil'] = $missingCooldownUntil;
                    $retryAfter = $this->normalizeTimestampMap($state['retryAfter'] ?? []);
                    unset($retryAfter[$extensionId]);
                    $state['retryAfter'] = $retryAfter;
                    $state['lastAction'] = 'missing';
                } else {
                    $failed = $this->normalizeIntMap($state['failed'] ?? []);
                    $attempts = ($failed[$extensionId] ?? 0) + 1;
                    $failed[$extensionId] = $attempts;
                    $state['failed'] = $failed;
                    $retryAfter = $this->normalizeTimestampMap($state['retryAfter'] ?? []);

                    if ($attempts < self::MAX_RETRIES) {
                        $retryAfter[$extensionId] = time() + min(
                            self::MAX_RETRY_BACKOFF_SECONDS,
                            30 * (2 ** max(0, $attempts - 1))
                        );
                        $state['retryAfter'] = $retryAfter;
                        $state['lastAction'] = 'retry_scheduled';
                    } else {
                        $missing = $this->normalizeStringList($state['missing'] ?? []);
                        $missing[] = $extensionId;
                        $state['missing'] = array_values(array_unique($missing));
                        $missingCooldownUntil = $this->normalizeTimestampMap($state['missingCooldownUntil'] ?? []);
                        $missingCooldownUntil[$extensionId] = time() + self::FAILED_COOLDOWN_SECONDS;
                        $state['missingCooldownUntil'] = $missingCooldownUntil;
                        unset($retryAfter[$extensionId]);
                        $state['retryAfter'] = $retryAfter;
                        $state['lastAction'] = 'failed';
                    }
                }

                $state['lastMessage'] = $result['message'];
            } else {
                $state['lastAction'] = 'idle';
                $state['lastMessage'] = 'No pending translations.';
            }

            $pendingAfterTick = $this->normalizeStringList($state['pending'] ?? []);
            $cacheDirty = (bool) ($state['cacheDirty'] ?? false);
            if ($cacheDirty && $pendingAfterTick === []) {
                $this->invalidateTranslationCache();
                $state['cacheDirty'] = false;
            }

            $now = gmdate('c');
            $state['lastRunAt'] = $now;
            $state['updatedAt'] = $now;
            $state = $this->maybeSendReport($state, $processed, false, 'tick');
            $this->saveState($state);

            return $this->buildResponse($state, $processed);
        });
    }

    /**
     * @return array<string, mixed>
     */
    public function reportInstallEvent(): array
    {
        return $this->withLock(function (): array {
            $state = $this->loadState();
            $state = $this->refreshQueue($state);
            $state['updatedAt'] = gmdate('c');
            $state = $this->maybeSendReport($state, null, true, 'extension_enabled');
            $this->saveState($state);

            return $this->buildResponse($state, null);
        });
    }

    /**
     * @param callable(): array<string, mixed> $callback
     * @return array<string, mixed>
     */
    private function withLock(callable $callback): array
    {
        $this->ensureRuntimeLocaleDir();
        $lockPath = $this->runtimeLocaleDir.'/.sync.lock';
        $lockHandle = @fopen($lockPath, 'c+');

        if (! is_resource($lockHandle)) {
            return $this->buildBusyResponse('Could not open sync lock file.');
        }

        if (! @flock($lockHandle, LOCK_EX | LOCK_NB)) {
            fclose($lockHandle);

            return $this->buildBusyResponse('Sync is already running.');
        }

        try {
            return $callback();
        } finally {
            @flock($lockHandle, LOCK_UN);
            fclose($lockHandle);
        }
    }

    private function ensureRuntimeLocaleDir(): void
    {
        if (! is_dir($this->runtimeLocaleDir)) {
            @mkdir($this->runtimeLocaleDir, 0755, true);
        }
    }

    private function invalidateTranslationCache(): void
    {
        $basePath = dirname($this->packageRoot, 3);
        $localeCacheDir = $basePath.'/storage/locale';

        foreach (glob($localeCacheDir.'/*.php') ?: [] as $path) {
            @unlink($path);
        }
    }

    /**
     * @return array<string, mixed>
     */
    private function loadState(): array
    {
        $raw = $this->settings->get(self::STATE_KEY);
        if (! is_string($raw) || trim($raw) === '') {
            return $this->defaultState();
        }

        $decoded = json_decode($raw, true);
        if (! is_array($decoded)) {
            return $this->defaultState();
        }

        return array_replace($this->defaultState(), $decoded);
    }

    /**
     * @param array<string, mixed> $state
     */
    private function saveState(array $state): void
    {
        $this->settings->set(self::STATE_KEY, json_encode($state, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES));
    }

    /**
     * @return array<string, mixed>
     */
    private function defaultState(): array
    {
        return [
            'extensionsHash' => '',
            'pending' => [],
            'synced' => [],
            'missing' => [],
            'failed' => [],
            'lastAction' => 'idle',
            'lastMessage' => '',
            'lastRunAt' => null,
            'updatedAt' => null,
            'prunedRuntimeFiles' => 0,
            'lastReportAt' => null,
            'lastReportStatus' => null,
            'lastReportHttpCode' => null,
            'lastReportMessage' => null,
            'cacheDirty' => false,
            'missingCooldownUntil' => [],
            'retryAfter' => [],
            'lastTickTs' => 0,
        ];
    }

    /**
     * @param array<string, mixed> $state
     * @return array<string, mixed>
     */
    private function refreshQueue(array $state): array
    {
        $enabled = $this->getEnabledExtensionIds();
        sort($enabled);
        $state = $this->cleanupStateMaps($state, $enabled);

        $hydratedFromLocalCatalog = $this->hydrateRuntimeFromLocalCatalog($enabled);
        if ($hydratedFromLocalCatalog > 0) {
            $state['cacheDirty'] = true;
        }

        $extensionsHash = sha1(json_encode($enabled, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES));
        $pending = $this->buildPendingQueue($enabled, $state);
        $currentPending = $this->normalizeStringList($state['pending'] ?? []);

        if (($state['extensionsHash'] ?? '') === $extensionsHash && $currentPending === $pending) {
            return $state;
        }

        $state['extensionsHash'] = $extensionsHash;
        $state['pending'] = $pending;
        $state['synced'] = [];
        $state['prunedRuntimeFiles'] = $this->pruneRuntimeLocales($enabled);
        if ((int) $state['prunedRuntimeFiles'] > 0) {
            $state['cacheDirty'] = true;
        }
        $state['lastAction'] = 'queue_refreshed';
        $state['lastMessage'] = 'Queue refreshed from enabled extensions.';
        $state['updatedAt'] = gmdate('c');

        return $state;
    }

    /**
     * @param list<string> $enabled
     */
    private function hydrateRuntimeFromLocalCatalog(array $enabled): int
    {
        $copied = 0;

        foreach ($enabled as $extensionId) {
            if (! $this->shouldSyncExtension($extensionId)) {
                continue;
            }

            if (is_file($this->coreLocaleDir.'/'.$extensionId.'.yml')) {
                continue;
            }

            $runtimePath = $this->runtimeLocaleDir.'/'.$extensionId.'.yml';
            if (is_file($runtimePath)) {
                continue;
            }

            $catalogPath = $this->catalogLocaleDir.'/'.$extensionId.'.yml';
            if (! is_file($catalogPath)) {
                continue;
            }

            $catalogBody = @file_get_contents($catalogPath);
            if (! is_string($catalogBody) || $catalogBody === '' || ! $this->isLikelyYaml($catalogBody)) {
                continue;
            }

            $written = @file_put_contents($runtimePath, $catalogBody, LOCK_EX);
            if (is_int($written) && $written > 0) {
                $copied++;
            }
        }

        return $copied;
    }

    /**
     * @param list<string> $enabled
     * @return list<string>
     */
    private function buildPendingQueue(array $enabled, array $state): array
    {
        $pending = [];
        $now = time();
        $missingCooldownUntil = $this->normalizeTimestampMap($state['missingCooldownUntil'] ?? []);
        $retryAfter = $this->normalizeTimestampMap($state['retryAfter'] ?? []);

        foreach ($enabled as $extensionId) {
            if (! $this->shouldSyncExtension($extensionId)) {
                continue;
            }

            if ($this->hasAvailableTranslation($extensionId)) {
                continue;
            }

            if (($missingCooldownUntil[$extensionId] ?? 0) > $now) {
                continue;
            }

            if (($retryAfter[$extensionId] ?? 0) > $now) {
                continue;
            }

            $pending[] = $extensionId;
        }

        return $pending;
    }

    /**
     * @param array<string, mixed> $state
     * @param list<string> $enabled
     * @return array<string, mixed>
     */
    private function cleanupStateMaps(array $state, array $enabled): array
    {
        $enabledSet = array_fill_keys($enabled, true);
        $now = time();

        $missingCooldownUntil = $this->normalizeTimestampMap($state['missingCooldownUntil'] ?? []);
        foreach ($missingCooldownUntil as $extensionId => $untilTs) {
            if (! isset($enabledSet[$extensionId]) || $untilTs <= $now || $this->hasAvailableTranslation($extensionId)) {
                unset($missingCooldownUntil[$extensionId]);
            }
        }
        $state['missingCooldownUntil'] = $missingCooldownUntil;

        $retryAfter = $this->normalizeTimestampMap($state['retryAfter'] ?? []);
        foreach ($retryAfter as $extensionId => $untilTs) {
            if (! isset($enabledSet[$extensionId]) || $untilTs <= $now || $this->hasAvailableTranslation($extensionId)) {
                unset($retryAfter[$extensionId]);
            }
        }
        $state['retryAfter'] = $retryAfter;

        $failed = $this->normalizeIntMap($state['failed'] ?? []);
        foreach (array_keys($failed) as $extensionId) {
            if (! isset($enabledSet[$extensionId]) || $this->hasAvailableTranslation($extensionId)) {
                unset($failed[$extensionId]);
            }
        }
        $state['failed'] = $failed;

        $missing = $this->normalizeStringList($state['missing'] ?? []);
        $missing = array_values(array_filter($missing, function (string $extensionId) use ($enabledSet): bool {
            return isset($enabledSet[$extensionId]) && ! $this->hasAvailableTranslation($extensionId);
        }));
        $state['missing'] = $missing;

        return $state;
    }

    private function hasAvailableTranslation(string $extensionId): bool
    {
        return $this->getTranslationSource($extensionId) !== 'none';
    }

    /**
     * @return 'core'|'runtime'|'native'|'none'
     */
    private function getTranslationSource(string $extensionId): string
    {
        if (is_file($this->coreLocaleDir.'/'.$extensionId.'.yml')) {
            return 'core';
        }

        if (is_file($this->runtimeLocaleDir.'/'.$extensionId.'.yml')) {
            return 'runtime';
        }

        if ($this->hasNativeRussianTranslation($extensionId)) {
            return 'native';
        }

        return 'none';
    }

    private function hasNativeRussianTranslation(string $extensionId): bool
    {
        $packageName = $this->toPackageStyleName($extensionId);
        if ($packageName === '' || ! str_contains($packageName, '/')) {
            return false;
        }

        if (array_key_exists($packageName, $this->nativeTranslationPresence)) {
            return $this->nativeTranslationPresence[$packageName];
        }

        $installPath = $this->getInstalledPackagePath($packageName);
        if ($installPath === null || $installPath === '' || ! is_dir($installPath)) {
            $this->nativeTranslationPresence[$packageName] = false;
            return false;
        }

        $directCandidates = [
            $installPath.'/locale/ru.yml',
            $installPath.'/locale/ru.yaml',
            $installPath.'/locale/ru.json',
            $installPath.'/locale/ru_RU.yml',
            $installPath.'/locale/ru_RU.yaml',
            $installPath.'/locale/ru_RU.json',
            $installPath.'/locale/ru-RU.yml',
            $installPath.'/locale/ru-RU.yaml',
            $installPath.'/locale/ru-RU.json',
            $installPath.'/locales/ru.yml',
            $installPath.'/locales/ru.yaml',
            $installPath.'/locales/ru.json',
            $installPath.'/resources/locale/ru.yml',
            $installPath.'/resources/locale/ru.yaml',
            $installPath.'/resources/locale/ru.json',
        ];

        foreach ($directCandidates as $path) {
            if (is_file($path)) {
                $this->nativeTranslationPresence[$packageName] = true;
                return true;
            }
        }

        $globPatterns = [
            $installPath.'/locale/ru/*',
            $installPath.'/locale/ru_RU/*',
            $installPath.'/locale/ru-RU/*',
            $installPath.'/locales/ru/*',
            $installPath.'/locales/ru_RU/*',
            $installPath.'/locales/ru-RU/*',
            $installPath.'/resources/locale/ru/*',
            $installPath.'/resources/locale/ru_RU/*',
            $installPath.'/resources/locale/ru-RU/*',
        ];

        foreach ($globPatterns as $pattern) {
            $paths = glob($pattern);
            if ($paths === false) {
                continue;
            }

            foreach ($paths as $path) {
                if (is_file($path)) {
                    $this->nativeTranslationPresence[$packageName] = true;
                    return true;
                }
            }
        }

        $this->nativeTranslationPresence[$packageName] = false;

        return false;
    }

    private function shouldSyncExtension(string $extensionId): bool
    {
        if ($extensionId === self::SELF_EXTENSION_ID) {
            return false;
        }

        if (str_starts_with($extensionId, 'flarum-lang-')) {
            return false;
        }

        if (str_contains($extensionId, '-langpack')) {
            return false;
        }

        return true;
    }

    /**
     * @param list<string> $enabledExtensions
     */
    private function pruneRuntimeLocales(array $enabledExtensions): int
    {
        $keep = array_fill_keys($enabledExtensions, true);
        $removed = 0;

        foreach (glob($this->runtimeLocaleDir.'/*.yml') ?: [] as $path) {
            $basename = pathinfo($path, PATHINFO_FILENAME);
            if (! isset($keep[$basename])) {
                if (@unlink($path)) {
                    $removed++;
                }
            }
        }

        return $removed;
    }

    /**
     * @return list<string>
     */
    private function getEnabledExtensionIds(): array
    {
        $raw = $this->settings->get(self::EXTENSIONS_ENABLED_KEY);
        if (! is_string($raw) || trim($raw) === '') {
            return [];
        }

        $decoded = json_decode($raw, true);
        if (! is_array($decoded)) {
            return [];
        }

        $ids = [];
        if (array_is_list($decoded)) {
            foreach ($decoded as $value) {
                if (is_string($value)) {
                    $normalized = $this->normalizeExtensionId($value);
                    if ($normalized !== '') {
                        $ids[] = $normalized;
                    }
                }
            }
        } else {
            foreach ($decoded as $key => $value) {
                if (is_string($key) && $this->isEnabledValue($value)) {
                    $normalized = $this->normalizeExtensionId($key);
                    if ($normalized !== '') {
                        $ids[] = $normalized;
                    }
                } elseif (is_string($value)) {
                    $normalized = $this->normalizeExtensionId($value);
                    if ($normalized !== '') {
                        $ids[] = $normalized;
                    }
                }
            }
        }

        return array_values(array_unique($ids));
    }

    private function isEnabledValue(mixed $value): bool
    {
        if ($value === true || $value === 1) {
            return true;
        }

        if (! is_string($value)) {
            return false;
        }

        $normalized = strtolower(trim($value));

        return in_array($normalized, ['1', 'true', 'enabled', 'yes', 'on'], true);
    }

    /**
     * @param array<string, mixed> $state
     * @param array<string, string>|null $processed
     * @return array<string, mixed>
     */
    private function maybeSendReport(array $state, ?array $processed, bool $force, string $event): array
    {
        $webhookUrl = $this->getReportingWebhookUrl();
        if ($webhookUrl === '') {
            $state['lastReportStatus'] = 'webhook_not_configured';
            $state['lastReportMessage'] = 'Webhook URL is not configured.';

            return $state;
        }

        if (! $force && ! $this->isReportDue($state)) {
            $state['lastReportStatus'] = 'skipped';
            $state['lastReportMessage'] = 'Report interval not reached.';

            return $state;
        }

        $payload = $this->buildReportPayload($state, $processed, $event);
        $result = $this->httpPostJson(
            $webhookUrl,
            $payload
        );

        $state['lastReportAt'] = gmdate('c');
        $state['lastReportHttpCode'] = $result['status'];

        if ($result['status'] >= 200 && $result['status'] < 300) {
            $ingestKey = is_string($result['ingestKey'] ?? null) ? trim((string) $result['ingestKey']) : '';
            if ($ingestKey !== '' && preg_match('/^[a-f0-9]{64}$/i', $ingestKey) === 1) {
                $this->settings->set(self::REPORTING_SHARED_KEY_KEY, strtolower($ingestKey));
            }

            $state['lastReportStatus'] = 'sent';
            $state['lastReportMessage'] = 'Report sent.';
        } else {
            $state['lastReportStatus'] = 'failed';
            $state['lastReportMessage'] = $result['message'];
        }

        return $state;
    }

    /**
     * @param array<string, mixed> $state
     */
    private function isReportDue(array $state): bool
    {
        $lastReportAt = $state['lastReportAt'] ?? null;
        if (! is_string($lastReportAt) || trim($lastReportAt) === '') {
            return true;
        }

        $lastTs = strtotime($lastReportAt);
        if ($lastTs === false) {
            return true;
        }

        $intervalSeconds = $this->getReportingIntervalMinutes() * 60;

        return (time() - $lastTs) >= $intervalSeconds;
    }

    private function getReportingWebhookUrl(): string
    {
        return self::REPORTING_WEBHOOK_URL;
    }

    private function getReportingIntervalMinutes(): int
    {
        return self::REPORTING_INTERVAL_MINUTES;
    }

    /**
     * @param array<string, mixed> $state
     * @param array<string, string>|null $processed
     * @return array<string, mixed>
     */
    private function buildReportPayload(array $state, ?array $processed, string $event): array
    {
        $forumUrl = $this->resolveForumUrl();
        $forumHost = $forumUrl !== '' ? (string) (parse_url($forumUrl, PHP_URL_HOST) ?? '') : '';
        $forumIp = $forumHost !== '' ? $this->resolveForumIp($forumHost) : '';

        $enabled = $this->getEnabledExtensionIds();
        sort($enabled);
        $missing = [];
        foreach ($enabled as $extensionId) {
            if (! $this->shouldSyncExtension($extensionId)) {
                continue;
            }

            if ($this->hasAvailableTranslation($extensionId)) {
                continue;
            }

            $missing[] = $this->toPackageStyleName($extensionId);
        }
        $missing = array_values(array_unique($missing));

        return [
            'event' => $event,
            'sentAt' => gmdate('c'),
            'forum' => [
                'url' => $forumUrl !== '' ? $forumUrl : null,
                'host' => $forumHost !== '' ? $forumHost : null,
                'ip' => $forumIp !== '' ? $forumIp : null,
            ],
            'extensions' => [
                'missingCount' => count($missing),
                'missing' => $missing,
            ],
        ];
    }

    private function resolveForumUrl(): string
    {
        $fromConfigRepo = trim((string) $this->config->get('url', ''));
        if ($fromConfigRepo !== '') {
            return $fromConfigRepo;
        }

        $basePath = dirname($this->packageRoot, 3);
        $configPath = $basePath.'/config.php';

        if (! is_file($configPath)) {
            return '';
        }

        $config = @include $configPath;
        if (! is_array($config)) {
            return '';
        }

        $fromConfigFile = trim((string) ($config['url'] ?? ''));

        return $fromConfigFile;
    }

    private function resolveForumIp(string $host): string
    {
        $normalizedHost = trim($host);
        if ($normalizedHost === '') {
            return '';
        }

        $resolved = @gethostbyname($normalizedHost);
        if (! is_string($resolved) || $resolved === '' || $resolved === $normalizedHost) {
            return '';
        }

        return filter_var($resolved, FILTER_VALIDATE_IP) ? $resolved : '';
    }

    private function getInstalledPackageVersion(string $packageName): ?string
    {
        if (! class_exists(\Composer\InstalledVersions::class)) {
            return null;
        }

        try {
            if (! \Composer\InstalledVersions::isInstalled($packageName)) {
                return null;
            }

            return (string) (\Composer\InstalledVersions::getPrettyVersion($packageName) ?? '');
        } catch (\Throwable) {
            return null;
        }
    }

    private function getInstalledPackagePath(string $packageName): ?string
    {
        if (! class_exists(\Composer\InstalledVersions::class)) {
            return null;
        }

        try {
            if (! \Composer\InstalledVersions::isInstalled($packageName)) {
                return null;
            }

            $path = \Composer\InstalledVersions::getInstallPath($packageName);
            if (! is_string($path) || trim($path) === '') {
                return null;
            }

            return $path;
        } catch (\Throwable) {
            return null;
        }
    }

    /**
     * @param array<string, mixed> $payload
     * @return array{status: int, message: string, ingestKey: string|null}
     */
    private function httpPostJson(string $url, array $payload): array
    {
        if (! function_exists('curl_init')) {
            return ['status' => 500, 'message' => 'cURL extension is not available.', 'ingestKey' => null];
        }

        $body = json_encode($payload, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
        if (! is_string($body) || $body === '') {
            return ['status' => 500, 'message' => 'Could not encode report payload.', 'ingestKey' => null];
        }

        $ch = curl_init($url);
        if ($ch === false) {
            return ['status' => 500, 'message' => 'Could not initialize cURL.', 'ingestKey' => null];
        }

        $timestamp = (string) time();
        $nonce = $this->buildRequestNonce();
        $storedSharedKey = $this->getStoredReportingSharedKey();
        $signatureMode = $storedSharedKey !== '' ? 'shared' : 'bootstrap';
        $secret = $storedSharedKey !== '' ? $storedSharedKey : $this->getBootstrapSigningSecret();
        $signature = hash_hmac('sha256', $timestamp.'.'.$nonce.'.'.$body, $secret);

        $headers = [
            'Content-Type: application/json',
            'Accept: application/json',
            'User-Agent: Flarum2-Russian-Langpack-Report',
            'X-Langpack-Timestamp: '.$timestamp,
            'X-Langpack-Nonce: '.$nonce,
            'X-Langpack-Signature: '.$signature,
            'X-Langpack-Signature-Alg: hmac-sha256',
            'X-Langpack-Signature-Mode: '.$signatureMode,
        ];

        curl_setopt($ch, CURLOPT_CUSTOMREQUEST, 'POST');
        curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
        curl_setopt($ch, CURLOPT_POSTFIELDS, $body);
        curl_setopt($ch, CURLOPT_HTTPHEADER, $headers);
        curl_setopt($ch, CURLOPT_CONNECTTIMEOUT, 4);
        curl_setopt($ch, CURLOPT_TIMEOUT, 8);
        curl_setopt($ch, CURLOPT_FOLLOWLOCATION, false);
        curl_setopt($ch, CURLOPT_SSL_VERIFYPEER, true);
        curl_setopt($ch, CURLOPT_SSL_VERIFYHOST, 2);

        $response = curl_exec($ch);
        $status = (int) curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
        $errno = curl_errno($ch);
        $error = curl_error($ch);
        curl_close($ch);

        if ($errno !== 0) {
            return [
                'status' => 500,
                'message' => 'Webhook request failed: '.($error !== '' ? $error : (string) $errno),
                'ingestKey' => null,
            ];
        }

        $responseBody = is_string($response) ? trim($response) : '';
        $responseJson = null;
        if ($responseBody !== '' && str_starts_with($responseBody, '{')) {
            $decoded = json_decode($responseBody, true);
            if (is_array($decoded)) {
                $responseJson = $decoded;
            }
        }

        if ($status < 200 || $status >= 300) {
            if ($responseBody !== '' && strlen($responseBody) > 120) {
                $responseBody = substr($responseBody, 0, 120).'...';
            }

            return [
                'status' => $status > 0 ? $status : 500,
                'message' => 'Webhook responded with status '.($status > 0 ? $status : 500).($responseBody !== '' ? ': '.$responseBody : '.'),
                'ingestKey' => null,
            ];
        }

        $ingestKey = null;
        if (is_array($responseJson) && is_string($responseJson['ingestKey'] ?? null)) {
            $candidate = strtolower(trim((string) $responseJson['ingestKey']));
            if (preg_match('/^[a-f0-9]{64}$/', $candidate) === 1) {
                $ingestKey = $candidate;
            }
        }

        return ['status' => $status, 'message' => 'OK', 'ingestKey' => $ingestKey];
    }

    private function getBootstrapSigningSecret(): string
    {
        $appKey = (string) ($this->config->get('app.key') ?? '');
        $trimmed = trim($appKey);

        if (str_starts_with($trimmed, 'base64:')) {
            $decoded = base64_decode(substr($trimmed, 7), true);
            if (is_string($decoded) && $decoded !== '') {
                return hash('sha256', 'vadkuz-langpack|'.$decoded);
            }
        }

        if ($trimmed !== '') {
            return hash('sha256', 'vadkuz-langpack|'.$trimmed);
        }

        $forumUrl = (string) ($this->config->get('url') ?? '');

        return hash('sha256', 'vadkuz-langpack|'.$forumUrl.'|fallback-secret');
    }

    private function getStoredReportingSharedKey(): string
    {
        $raw = (string) ($this->settings->get(self::REPORTING_SHARED_KEY_KEY) ?? '');
        $key = strtolower(trim($raw));

        if (preg_match('/^[a-f0-9]{64}$/', $key) !== 1) {
            return '';
        }

        return $key;
    }

    private function buildRequestNonce(): string
    {
        try {
            return bin2hex(random_bytes(8));
        } catch (\Throwable) {
            return sha1((string) microtime(true).'-'.(string) mt_rand());
        }
    }

    private function normalizeExtensionId(string $value): string
    {
        $normalized = strtolower(trim($value));
        if ($normalized === '') {
            return '';
        }

        if (! preg_match('/^[a-z0-9][a-z0-9-]*$/', $normalized)) {
            return '';
        }

        return $normalized;
    }

    /**
     * @return array{status: string, message: string}
     */
    private function syncOneExtension(string $extensionId): array
    {
        $normalized = $this->normalizeExtensionId($extensionId);
        if ($normalized === '') {
            return [
                'status' => 'missing',
                'message' => 'Invalid extension id.',
            ];
        }

        $catalogPath = $this->catalogLocaleDir.'/'.$normalized.'.yml';
        if (is_file($catalogPath)) {
            $catalogBody = @file_get_contents($catalogPath);
            if (is_string($catalogBody) && $catalogBody !== '' && $this->isLikelyYaml($catalogBody)) {
                $targetPath = $this->runtimeLocaleDir.'/'.$normalized.'.yml';
                $written = @file_put_contents($targetPath, $catalogBody, LOCK_EX);

                if (is_int($written) && $written > 0) {
                    return [
                        'status' => 'synced',
                        'message' => 'Translation copied from local catalog.',
                    ];
                }
            }
        }

        return [
            'status' => 'missing',
            'message' => 'Translation is missing in local catalog.',
        ];
    }

    private function isLikelyYaml(string $body): bool
    {
        if (str_contains($body, "\0")) {
            return false;
        }

        return preg_match('/^[a-z0-9][a-z0-9-]*:\s*$/mi', $body) === 1
            || preg_match('/^[a-z0-9][a-z0-9-]*:\s+/mi', $body) === 1;
    }

    /**
     * @param array<string, mixed> $state
     * @param array<string, string>|null $processed
     * @return array<string, mixed>
     */
    private function buildResponse(array $state, ?array $processed): array
    {
        $pending = $this->normalizeStringList($state['pending'] ?? []);
        $synced = $this->normalizeStringList($state['synced'] ?? []);
        $missing = $this->normalizeStringList($state['missing'] ?? []);
        $failed = $this->normalizeIntMap($state['failed'] ?? []);
        $tickMeta = $this->buildTickMeta($state);
        $extensionsStatus = $this->buildExtensionsStatus();
        $translatedExtensions = [];
        $missingExtensions = [];

        foreach ($extensionsStatus as $item) {
            $id = is_string($item['id'] ?? null) ? $item['id'] : '';
            $label = is_string($item['label'] ?? null) ? $item['label'] : $id;
            $hasTranslation = (bool) ($item['hasTranslation'] ?? false);
            if ($id === '') {
                continue;
            }

            if ($hasTranslation) {
                $translatedExtensions[] = $label;
            } else {
                $missingExtensions[] = $label;
            }
        }

        return [
            'ok' => true,
            'busy' => false,
            'pendingCount' => count($pending),
            'syncedCount' => count($synced),
            'missingCount' => count($missing),
            'failedCount' => array_sum($failed),
            'tickMeta' => $tickMeta,
            'pendingPreview' => array_slice($pending, 0, 20),
            'extensionsStatus' => $extensionsStatus,
            'translatedExtensionsCount' => count($translatedExtensions),
            'missingExtensionsCount' => count($missingExtensions),
            'translatedExtensions' => $translatedExtensions,
            'missingExtensions' => $missingExtensions,
            'lastAction' => (string) ($state['lastAction'] ?? 'idle'),
            'lastMessage' => (string) ($state['lastMessage'] ?? ''),
            'lastRunAt' => is_string($state['lastRunAt'] ?? null) ? $state['lastRunAt'] : null,
            'updatedAt' => is_string($state['updatedAt'] ?? null) ? $state['updatedAt'] : null,
            'prunedRuntimeFiles' => (int) ($state['prunedRuntimeFiles'] ?? 0),
            'lastReportAt' => is_string($state['lastReportAt'] ?? null) ? $state['lastReportAt'] : null,
            'lastReportStatus' => is_string($state['lastReportStatus'] ?? null) ? $state['lastReportStatus'] : null,
            'lastReportHttpCode' => (int) ($state['lastReportHttpCode'] ?? 0),
            'lastReportMessage' => is_string($state['lastReportMessage'] ?? null) ? $state['lastReportMessage'] : null,
            'processed' => $processed,
        ];
    }

    /**
     * @param array<string, mixed> $state
     * @return array{lastTickTs: int, nextTickTs: int|null, minTickIntervalSeconds: int, blockedCount: int, nextUnblockTs: int|null, pauseReason: string|null}
     */
    private function buildTickMeta(array $state): array
    {
        $now = time();
        $lastTickTs = max(0, (int) ($state['lastTickTs'] ?? 0));
        $nextTickTs = $lastTickTs > 0 ? $lastTickTs + self::MIN_TICK_INTERVAL_SECONDS : null;
        if (is_int($nextTickTs) && $nextTickTs <= $now) {
            $nextTickTs = null;
        }

        $missingCooldownUntil = $this->normalizeTimestampMap($state['missingCooldownUntil'] ?? []);
        $retryAfter = $this->normalizeTimestampMap($state['retryAfter'] ?? []);

        $enabled = $this->getEnabledExtensionIds();
        $blockedCount = 0;
        $nextUnblockTs = null;
        $pauseReason = null;

        foreach ($enabled as $extensionId) {
            if (! $this->shouldSyncExtension($extensionId)) {
                continue;
            }

            if ($this->hasAvailableTranslation($extensionId)) {
                continue;
            }

            $retryTs = (int) ($retryAfter[$extensionId] ?? 0);
            $missingTs = (int) ($missingCooldownUntil[$extensionId] ?? 0);
            $untilTs = max($retryTs, $missingTs);
            if ($untilTs <= $now) {
                continue;
            }

            $blockedCount++;
            if ($nextUnblockTs === null || $untilTs < $nextUnblockTs) {
                $nextUnblockTs = $untilTs;
                $pauseReason = $retryTs >= $missingTs ? 'retry_backoff' : 'missing_cooldown';
            }
        }

        return [
            'lastTickTs' => $lastTickTs,
            'nextTickTs' => $nextTickTs,
            'minTickIntervalSeconds' => self::MIN_TICK_INTERVAL_SECONDS,
            'blockedCount' => $blockedCount,
            'nextUnblockTs' => $nextUnblockTs,
            'pauseReason' => $pauseReason,
        ];
    }

    /**
     * @return list<array{id: string, label: string, hasTranslation: bool, source: string}>
     */
    private function buildExtensionsStatus(): array
    {
        $enabled = $this->getEnabledExtensionIds();
        sort($enabled);

        $result = [];
        foreach ($enabled as $extensionId) {
            if (! $this->shouldSyncExtension($extensionId)) {
                continue;
            }

            $source = $this->getTranslationSource($extensionId);

            $result[] = [
                'id' => $extensionId,
                'label' => $this->toPackageStyleName($extensionId),
                'hasTranslation' => $source !== 'none',
                'source' => $source,
            ];
        }

        return $result;
    }

    private function toPackageStyleName(string $extensionId): string
    {
        if ($extensionId === '' || ! str_contains($extensionId, '-')) {
            return $extensionId;
        }

        $parts = explode('-', $extensionId);
        $vendor = array_shift($parts);
        if (! is_string($vendor) || $vendor === '' || $parts === []) {
            return $extensionId;
        }

        return $vendor.'/'.implode('-', $parts);
    }

    /**
     * @return array<string, mixed>
     */
    private function buildBusyResponse(string $message): array
    {
        $state = $this->loadState();
        $response = $this->buildResponse($state, null);
        $response['busy'] = true;
        $response['lastMessage'] = $message;

        return $response;
    }

    /**
     * @param mixed $value
     * @return list<string>
     */
    private function normalizeStringList(mixed $value): array
    {
        if (! is_array($value)) {
            return [];
        }

        $items = [];
        foreach ($value as $item) {
            if (is_string($item) && $item !== '') {
                $items[] = $item;
            }
        }

        return array_values(array_unique($items));
    }

    /**
     * @param mixed $value
     * @return array<string, int>
     */
    private function normalizeIntMap(mixed $value): array
    {
        if (! is_array($value)) {
            return [];
        }

        $items = [];
        foreach ($value as $key => $count) {
            if (! is_string($key)) {
                continue;
            }

            $normalized = $this->normalizeExtensionId($key);
            if ($normalized === '') {
                continue;
            }

            $items[$normalized] = max(0, (int) $count);
        }

        return $items;
    }

    /**
     * @param mixed $value
     * @return array<string, int>
     */
    private function normalizeTimestampMap(mixed $value): array
    {
        if (! is_array($value)) {
            return [];
        }

        $items = [];
        foreach ($value as $key => $ts) {
            if (! is_string($key)) {
                continue;
            }

            $normalized = $this->normalizeExtensionId($key);
            if ($normalized === '') {
                continue;
            }

            $items[$normalized] = max(0, (int) $ts);
        }

        return $items;
    }
}
