<?php

/*
 * This file is part of the Russian language pack for Flarum.
 *
 * For detailed copyright and license information, please view the
 * LICENSE file that was distributed with this source code.
 */

use Flarum\Extend;
use Vadkuz\RussianLangpack\Api\Controller\SyncStatusController;
use Vadkuz\RussianLangpack\Api\Controller\SyncTickController;
use Vadkuz\RussianLangpack\Extend\LifecycleHooks;

return [
    new Extend\LanguagePack(),
    // Runtime files are extension-slug YAMLs (e.g. fof-links.yml),
    // so they must be loaded as a language pack path for the same locale.
    new Extend\LanguagePack('/runtime-locale'),
    new LifecycleHooks(),

    (new Extend\Frontend('admin'))
        ->js(__DIR__.'/js/dist/admin.js'),

    (new Extend\Routes('api'))
        ->get('/ru-langpack/sync/status', 'vadkuz.ru-langpack.sync.status', SyncStatusController::class)
        ->post('/ru-langpack/sync/tick', 'vadkuz.ru-langpack.sync.tick', SyncTickController::class),
];
