# flarum2-russian-langpack

Русский языковой пакет для Flarum 2.x.

## Пакет Composer

`vadkuz/flarum2-russian-langpack`

## Установка (локально через path repository)

1. Скопируйте папку расширения в `extensions/flarum2-russian-langpack`.
2. В корне Flarum выполните команду (она сама добавит path-репозиторий в `composer.json`):

```bash
composer config repositories.flarum2-russian-langpack '{"type":"path","url":"extensions/flarum2-russian-langpack","options":{"symlink":true}}'
```

3. Установите пакет:

```bash
composer require vadkuz/flarum2-russian-langpack:"*@dev" -W
```

4. Включите расширение и очистите кэш:

```bash
php flarum extension:enable vadkuz-flarum2-russian-langpack
php flarum cache:clear
php flarum assets:publish
```

5. В админке Flarum выберите русский язык по умолчанию: `Appearance -> Languages`.

## Удаление

```bash
composer remove vadkuz/flarum2-russian-langpack
php flarum cache:clear
php flarum assets:publish
```
