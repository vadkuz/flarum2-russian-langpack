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

## Удаление

```bash
composer remove vadkuz/flarum2-russian-langpack
php flarum cache:clear
php flarum assets:publish
```
