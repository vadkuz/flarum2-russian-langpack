<?php

namespace Vadkuz\RussianLangpack\Extend;

use Flarum\Extension\Extension;
use Flarum\Extend\ExtenderInterface;
use Flarum\Extend\LifecycleInterface;
use Flarum\Settings\SettingsRepositoryInterface;
use Illuminate\Contracts\Container\Container;
use Vadkuz\RussianLangpack\Sync\TranslationSyncManager;

class LifecycleHooks implements ExtenderInterface, LifecycleInterface
{
    public function extend(Container $container, ?Extension $extension = null): void
    {
    }

    public function onEnable(Container $container, Extension $extension): void
    {
        try {
            /** @var SettingsRepositoryInterface $settings */
            $settings = $container->make(SettingsRepositoryInterface::class);

            if ($settings->get('vadkuz.russian_langpack.reporting_enabled') === null) {
                $settings->set('vadkuz.russian_langpack.reporting_enabled', '1');
            }

            $webhookUrl = trim((string) ($settings->get('vadkuz.russian_langpack.reporting_webhook_url') ?? ''));
            if ($webhookUrl === '') {
                $settings->set('vadkuz.russian_langpack.reporting_webhook_url', 'https://flarum.vadim.online/api/langpack/ingest');
            }

            $container->make(TranslationSyncManager::class)->reportInstallEvent();
        } catch (\Throwable) {
            // Never block extension enabling because of telemetry/reporting issues.
        }
    }

    public function onDisable(Container $container, Extension $extension): void
    {
    }
}
