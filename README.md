# flarum2-russian-langpack

Русский языковой пакет для Flarum 2.x.

## Пакет Composer

`vadkuz/flarum2-russian-langpack`

## Установка (рекомендуется, через Packagist)

```bash
composer require vadkuz/flarum2-russian-langpack
php flarum extension:enable vadkuz-flarum2-russian-langpack
php flarum cache:clear
php flarum assets:publish
```

В админке Flarum выберите русский язык по умолчанию: `Appearance -> Languages`.

## Установка (для локальной разработки, path repository)

1. Скопируйте папку расширения в `extensions/flarum2-russian-langpack`.
2. В корне Flarum добавьте path-репозиторий:

```bash
composer config repositories.flarum2-russian-langpack '{"type":"path","url":"extensions/flarum2-russian-langpack","options":{"symlink":true}}'
```

3. Установите пакет из локальной папки:

```bash
composer require vadkuz/flarum2-russian-langpack:"*@dev" -W
```

4. Включите расширение и очистите кэш:

```bash
php flarum extension:enable vadkuz-flarum2-russian-langpack
php flarum cache:clear
php flarum assets:publish
```

## Удаление

```bash
composer remove vadkuz/flarum2-russian-langpack
php flarum cache:clear
php flarum assets:publish
```
