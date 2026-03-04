<?php

namespace Vadkuz\RussianLangpack\Extend;

use Flarum\Extension\Extension;
use Flarum\Extend\ExtenderInterface;
use Flarum\Extend\LifecycleInterface;
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
            $container->make(TranslationSyncManager::class)->reportInstallEvent();
        } catch (\Throwable) {
            // Never block extension enabling because of telemetry/reporting issues.
        }
    }

    public function onDisable(Container $container, Extension $extension): void
    {
    }
}
