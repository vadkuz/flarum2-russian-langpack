<?php

namespace Vadkuz\RussianLangpack\Sync;

use Flarum\Settings\SettingsRepositoryInterface;

class TranslationSyncManager
{
    private const STATE_KEY = 'vadkuz.russian_langpack.sync_state';
    private const AUTOSYNC_ENABLED_KEY = 'vadkuz.russian_langpack.autosync_enabled';
    private const EXTENSIONS_ENABLED_KEY = 'extensions_enabled';
    private const REMOTE_BASE_URL = 'https://raw.githubusercontent.com/vadkuz/flarum2-russian-langpack/main/locale-catalog/';
    private const MAX_REMOTE_BYTES = 524288;
    private const MAX_RETRIES = 3;

    private const SELF_EXTENSION_ID = 'vadkuz-flarum2-russian-langpack';
    private string $packageRoot;
    private string $catalogLocaleDir;
    private string $coreLocaleDir;
    private string $runtimeLocaleDir;

    public function __construct(private readonly SettingsRepositoryInterface $settings)
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

            if (! $this->isAutosyncEnabled()) {
                $state['pending'] = [];
                $state['lastAction'] = 'disabled';
                $state['lastMessage'] = 'Autosync is disabled in extension settings.';
                $state['updatedAt'] = gmdate('c');
                $this->saveState($state);

                return $this->buildResponse($state, null);
            }

            $state = $this->refreshQueue($state);
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

            if (! $this->isAutosyncEnabled()) {
                $state['pending'] = [];
                $state['lastAction'] = 'disabled';
                $state['lastMessage'] = 'Autosync is disabled in extension settings.';
                $state['lastRunAt'] = gmdate('c');
                $state['updatedAt'] = gmdate('c');
                $this->saveState($state);

                return $this->buildResponse($state, null);
            }

            $state = $this->refreshQueue($state);

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
                    $synced = $this->normalizeStringList($state['synced'] ?? []);
                    $synced[] = $extensionId;
                    $state['synced'] = array_values(array_unique($synced));
                    $state['lastAction'] = 'synced';
                } elseif ($result['status'] === 'missing') {
                    $missing = $this->normalizeStringList($state['missing'] ?? []);
                    $missing[] = $extensionId;
                    $state['missing'] = array_values(array_unique($missing));
                    $state['lastAction'] = 'missing';
                } else {
                    $failed = $this->normalizeIntMap($state['failed'] ?? []);
                    $attempts = ($failed[$extensionId] ?? 0) + 1;
                    $failed[$extensionId] = $attempts;
                    $state['failed'] = $failed;

                    if ($attempts < self::MAX_RETRIES) {
                        $pending[] = $extensionId;
                        $state['pending'] = $pending;
                        $state['lastAction'] = 'retry';
                    } else {
                        $missing = $this->normalizeStringList($state['missing'] ?? []);
                        $missing[] = $extensionId;
                        $state['missing'] = array_values(array_unique($missing));
                        $state['lastAction'] = 'failed';
                    }
                }

                $state['lastMessage'] = $result['message'];
            } else {
                $state['lastAction'] = 'idle';
                $state['lastMessage'] = 'No pending translations.';
            }

            $now = gmdate('c');
            $state['lastRunAt'] = $now;
            $state['updatedAt'] = $now;
            $this->saveState($state);

            return $this->buildResponse($state, $processed);
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

        $extensionsHash = sha1(json_encode($enabled, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES));
        if (($state['extensionsHash'] ?? '') === $extensionsHash) {
            return $state;
        }

        $pending = [];
        foreach ($enabled as $extensionId) {
            if (! $this->shouldSyncExtension($extensionId)) {
                continue;
            }

            if ($this->hasRuntimeOrCoreTranslation($extensionId)) {
                continue;
            }

            $pending[] = $extensionId;
        }

        $state['extensionsHash'] = $extensionsHash;
        $state['pending'] = $pending;
        $state['synced'] = [];
        $state['missing'] = [];
        $state['failed'] = [];
        $state['prunedRuntimeFiles'] = $this->pruneRuntimeLocales($enabled);
        $state['lastAction'] = 'queue_refreshed';
        $state['lastMessage'] = 'Queue refreshed from enabled extensions.';
        $state['updatedAt'] = gmdate('c');

        return $state;
    }

    private function hasRuntimeOrCoreTranslation(string $extensionId): bool
    {
        return is_file($this->coreLocaleDir.'/'.$extensionId.'.yml')
            || is_file($this->runtimeLocaleDir.'/'.$extensionId.'.yml');
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

    private function isAutosyncEnabled(): bool
    {
        $raw = $this->settings->get(self::AUTOSYNC_ENABLED_KEY);

        if ($raw === null) {
            return true;
        }

        if ($raw === true || $raw === 1) {
            return true;
        }

        if ($raw === false || $raw === 0) {
            return false;
        }

        if (! is_string($raw)) {
            return true;
        }

        $normalized = strtolower(trim($raw));
        if ($normalized === '') {
            return true;
        }

        if (in_array($normalized, ['1', 'true', 'enabled', 'yes', 'on'], true)) {
            return true;
        }

        if (in_array($normalized, ['0', 'false', 'disabled', 'no', 'off'], true)) {
            return false;
        }

        return true;
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

        $url = self::REMOTE_BASE_URL.$normalized.'.yml';
        $download = $this->httpGet($url);

        if ($download['status'] === 404) {
            return [
                'status' => 'missing',
                'message' => 'Translation not found on GitHub.',
            ];
        }

        if ($download['status'] < 200 || $download['status'] >= 300) {
            return [
                'status' => 'failed',
                'message' => 'GitHub request failed with status '.$download['status'].'.',
            ];
        }

        if ($download['body'] === '' || ! $this->isLikelyYaml($download['body'])) {
            return [
                'status' => 'failed',
                'message' => 'Downloaded file is empty or invalid.',
            ];
        }

        $targetPath = $this->runtimeLocaleDir.'/'.$normalized.'.yml';
        $written = @file_put_contents($targetPath, $download['body'], LOCK_EX);

        if (! is_int($written) || $written <= 0) {
            return [
                'status' => 'failed',
                'message' => 'Could not write runtime locale file.',
            ];
        }

        return [
            'status' => 'synced',
            'message' => 'Translation downloaded from GitHub.',
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
     * @return array{status: int, body: string}
     */
    private function httpGet(string $url): array
    {
        if (! function_exists('curl_init')) {
            return ['status' => 500, 'body' => ''];
        }

        $body = '';
        $received = 0;
        $ch = curl_init($url);

        if ($ch === false) {
            return ['status' => 500, 'body' => ''];
        }

        curl_setopt($ch, CURLOPT_CUSTOMREQUEST, 'GET');
        curl_setopt($ch, CURLOPT_FOLLOWLOCATION, true);
        curl_setopt($ch, CURLOPT_MAXREDIRS, 3);
        curl_setopt($ch, CURLOPT_CONNECTTIMEOUT, 4);
        curl_setopt($ch, CURLOPT_TIMEOUT, 8);
        curl_setopt($ch, CURLOPT_RETURNTRANSFER, false);
        curl_setopt($ch, CURLOPT_USERAGENT, 'Flarum2-Russian-Langpack-Sync');
        curl_setopt($ch, CURLOPT_SSL_VERIFYPEER, true);
        curl_setopt($ch, CURLOPT_SSL_VERIFYHOST, 2);

        curl_setopt($ch, CURLOPT_WRITEFUNCTION, static function ($curl, string $chunk) use (&$body, &$received): int {
            $length = strlen($chunk);
            $received += $length;

            if ($received > self::MAX_REMOTE_BYTES) {
                return 0;
            }

            $body .= $chunk;

            return $length;
        });

        $ok = curl_exec($ch);
        $status = (int) curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
        $errno = curl_errno($ch);
        curl_close($ch);

        if ($ok === false || $errno !== 0) {
            return ['status' => 500, 'body' => ''];
        }

        return ['status' => $status, 'body' => $body];
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

        return [
            'ok' => true,
            'busy' => false,
            'autosyncEnabled' => $this->isAutosyncEnabled(),
            'pendingCount' => count($pending),
            'syncedCount' => count($synced),
            'missingCount' => count($missing),
            'failedCount' => array_sum($failed),
            'pendingPreview' => array_slice($pending, 0, 20),
            'lastAction' => (string) ($state['lastAction'] ?? 'idle'),
            'lastMessage' => (string) ($state['lastMessage'] ?? ''),
            'lastRunAt' => is_string($state['lastRunAt'] ?? null) ? $state['lastRunAt'] : null,
            'updatedAt' => is_string($state['updatedAt'] ?? null) ? $state['updatedAt'] : null,
            'prunedRuntimeFiles' => (int) ($state['prunedRuntimeFiles'] ?? 0),
            'processed' => $processed,
        ];
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
}
