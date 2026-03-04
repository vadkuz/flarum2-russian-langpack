# flarum2-russian-langpack

Russian language pack for Flarum 2.x.

## Composer Package

`vadkuz/flarum2-russian-langpack`

## 🇷🇺 Русский

### Установка (через Packagist)

```bash
composer require vadkuz/flarum2-russian-langpack
php flarum extension:enable vadkuz-flarum2-russian-langpack
php flarum cache:clear
php flarum assets:publish
```

В админке Flarum выберите русский язык по умолчанию: `Appearance -> Languages`.

### Автосинхронизация недостающих переводов (без cron)

- По умолчанию загружается базовый набор из `locale` + динамические файлы из `runtime-locale`.
- Полный словарь хранится в `locale-catalog` и не подключается напрямую, чтобы уменьшить нагрузку.
- Синхронизация запускается автоматически только на странице расширения `Русский (Flarum2)` в админке.
- Список задач строится по `settings.extensions_enabled` (только включенные расширения форума).
- Если локальный runtime-перевод отсутствует, расширение сначала копирует `locale-catalog/<extension-id>.yml`, а если файла нет — пробует загрузить его с GitHub.
- Если файл не найден, интерфейс этого расширения остается на EN fallback.

### Удаление

```bash
composer remove vadkuz/flarum2-russian-langpack
php flarum cache:clear
php flarum assets:publish
```

## 🇬🇧 English

### Installation (via Packagist)

```bash
composer require vadkuz/flarum2-russian-langpack
php flarum extension:enable vadkuz-flarum2-russian-langpack
php flarum cache:clear
php flarum assets:publish
```

In Flarum admin panel, set Russian as default language: `Appearance -> Languages`.

### Automatic missing translation sync (no cron)

- By default base locales from `locale` + dynamic files from `runtime-locale` are loaded.
- Full dictionary is stored in `locale-catalog` and is not loaded directly, which reduces runtime load.
- Sync runs automatically only when the `Русский (Flarum2)` extension page is open in admin.
- Queue is generated from `settings.extensions_enabled` (enabled forum extensions only).
- If runtime translation is missing, extension first copies `locale-catalog/<extension-id>.yml`, and if not found then tries to download it from GitHub.
- If a file is not available, UI falls back to English for that extension.

### Removal

```bash
composer remove vadkuz/flarum2-russian-langpack
php flarum cache:clear
php flarum assets:publish
```
