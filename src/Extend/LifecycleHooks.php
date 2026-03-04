<?php

namespace Vadkuz\RussianLangpack\Extend;

use DirectoryIterator;
use Flarum\Extension\Extension;
use Flarum\Extend\ExtenderInterface;
use Flarum\Extend\LifecycleInterface;
use Flarum\Locale\LocaleManager;
use Illuminate\Contracts\Container\Container;
use Vadkuz\RussianLangpack\Sync\TranslationSyncManager;

class LifecycleHooks implements ExtenderInterface, LifecycleInterface
{
    /** @var array<string, bool> */
    private array $registeredLocales = [];

    public function extend(Container $container, ?Extension $extension = null): void
    {
        if ($extension === null) {
            return;
        }

        $register = function (LocaleManager $locales) use ($extension): void {
            $this->registerLocale($locales, $extension);
        };

        $container->resolving(LocaleManager::class, $register);

        if ($container->resolved(LocaleManager::class)) {
            $register($container->make(LocaleManager::class));
        }
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

    private function registerLocale(LocaleManager $locales, Extension $extension): void
    {
        $locale = $extension->composerJsonAttribute('extra.flarum-locale.code');
        $title = $extension->composerJsonAttribute('extra.flarum-locale.title');

        if (! is_string($locale) || $locale === '' || ! is_string($title) || $title === '') {
            return;
        }

        $key = $extension->getId().'|'.$locale;
        if (isset($this->registeredLocales[$key])) {
            return;
        }
        $this->registeredLocales[$key] = true;

        $directory = $extension->getPath().'/locale';
        if (! is_dir($directory)) {
            return;
        }

        $locales->addLocale($locale, $title);

        $jsPath = $directory.'/config.js';
        if (is_file($jsPath)) {
            $locales->addJsFile($locale, $jsPath);
        }

        $cssPath = $directory.'/config.css';
        if (is_file($cssPath)) {
            $locales->addCssFile($locale, $cssPath);
        }

        foreach (new DirectoryIterator($directory) as $file) {
            if (! $file->isFile()) {
                continue;
            }

            if (! in_array($file->getExtension(), ['yml', 'yaml'], true)) {
                continue;
            }

            $locales->addTranslations($locale, $file->getPathname());
        }
    }
}
