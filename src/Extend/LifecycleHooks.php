<?php

namespace Vadkuz\RussianLangpack\Extend;

use DirectoryIterator;
use Flarum\Extension\Extension;
use Flarum\Extend\ExtenderInterface;
use Flarum\Extend\LifecycleInterface;
use Flarum\Locale\LocaleManager;
use Flarum\Locale\Translator;
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

        $addedTranslations = 0;

        foreach (new DirectoryIterator($directory) as $file) {
            if (! $file->isFile()) {
                continue;
            }

            if (! in_array($file->getExtension(), ['yml', 'yaml'], true)) {
                continue;
            }

            $locales->addTranslations($locale, $file->getPathname());
            $addedTranslations++;
        }

        // Locale manager can be resolved after translator already built an empty
        // catalogue for this locale. In that case, newly added resources are not
        // visible until we drop in-memory cached catalogues.
        if ($addedTranslations > 0) {
            $this->resetTranslatorCatalogues($locales->getTranslator());
        }
    }

    private function resetTranslatorCatalogues(Translator $translator): void
    {
        try {
            $reflection = new \ReflectionObject($translator);
            while ($reflection) {
                if ($reflection->hasProperty('catalogues')) {
                    $prop = $reflection->getProperty('catalogues');
                    $prop->setAccessible(true);
                    $prop->setValue($translator, []);
                    break;
                }

                $reflection = $reflection->getParentClass();
            }
        } catch (\Throwable) {
            // Best-effort only: never break locale loading on reflection issues.
        }
    }
}
