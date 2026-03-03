<?php

namespace Vadkuz\RussianLangpack\Extend;

use Flarum\Extension\Extension;
use Flarum\Extend\ExtenderInterface;
use Flarum\Extend\LifecycleInterface;
use Illuminate\Contracts\Container\Container;
use Flarum\Settings\SettingsRepositoryInterface;
use Vadkuz\RussianLangpack\Sync\TranslationSyncManager;

class LifecycleHooks implements ExtenderInterface, LifecycleInterface
{
    private const AUTOSYNC_ENABLED_KEY = 'vadkuz.russian_langpack.autosync_enabled';

    public function extend(Container $container, ?Extension $extension = null): void
    {
        try {
            /** @var SettingsRepositoryInterface $settings */
            $settings = $container->make(SettingsRepositoryInterface::class);
            if ($settings->get(self::AUTOSYNC_ENABLED_KEY) === null) {
                $settings->set(self::AUTOSYNC_ENABLED_KEY, '1');
            }
        } catch (\Throwable) {
            // Never block bootstrap because of settings initialization issues.
        }
    }

    public function onEnable(Container $container, Extension $extension): void
    {
        try {
            /** @var SettingsRepositoryInterface $settings */
            $settings = $container->make(SettingsRepositoryInterface::class);
            if ($settings->get(self::AUTOSYNC_ENABLED_KEY) === null) {
                $settings->set(self::AUTOSYNC_ENABLED_KEY, '1');
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
