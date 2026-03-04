<?php

namespace Vadkuz\RussianLangpack\Extend;

use DirectoryIterator;
use Flarum\Extension\Extension;
use Flarum\Extension\ExtensionManager;
use Flarum\Extend\ExtenderInterface;
use Flarum\Extend\LifecycleInterface;
use Flarum\Locale\LocaleManager;
use Illuminate\Contracts\Container\Container;
use SplFileInfo;
use Vadkuz\RussianLangpack\Sync\TranslationSyncManager;

class LifecycleHooks implements ExtenderInterface, LifecycleInterface
{
    private const CORE_LOCALE_FILES = ['core', 'validation'];

    /** @var array<string, bool> */
    private array $registeredLocales = [];

    public function extend(Container $container, ?Extension $extension = null): void
    {
        if ($extension === null) {
            return;
        }

        $register = function (LocaleManager $locales) use ($container, $extension): void {
            $this->registerLocale($container, $locales, $extension);
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

    private function registerLocale(Container $container, LocaleManager $locales, Extension $extension): void
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
            if (! $this->shouldLoad($container, $file)) {
                continue;
            }

            $locales->addTranslations($locale, $file->getPathname());
        }
    }

    private function shouldLoad(Container $container, SplFileInfo $file): bool
    {
        if (! $file->isFile()) {
            return false;
        }

        if (! in_array($file->getExtension(), ['yml', 'yaml'], true)) {
            return false;
        }

        $slug = $file->getBasename('.'.$file->getExtension());
        $slug = str_replace(\Symfony\Component\Translation\MessageCatalogueInterface::INTL_DOMAIN_SUFFIX, '', $slug);

        if (in_array($slug, self::CORE_LOCALE_FILES, true)) {
            return true;
        }

        /** @var ExtensionManager|null $extensions */
        static $extensions;
        $extensions ??= $container->make(ExtensionManager::class);

        return $extensions->isEnabled($slug);
    }
}
