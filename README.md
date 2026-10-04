# SUKAAA — Railway + PostgreSQL

## Marginalia

`marginalia.html` теперь хранит список дел в PostgreSQL через API:

- `GET /api/storage?keys=marginalia_tasks_v2`
- `POST /api/storage`

Ключ `marginalia_tasks_v2` содержит JSON-массив задач.

При первом открытии Marginalia:
1. существующие задачи из PostgreSQL загружаются;
2. если остались старые задачи в localStorage — они один раз переносятся в PostgreSQL;
3. если данных нет — создаются стартовые задачи и сохраняются в PostgreSQL.

## Railway

1. Добавь в проект PostgreSQL через **New → Database → Add PostgreSQL**.
2. Подключи PostgreSQL к `SUKAAA`, чтобы сервис получил `DATABASE_URL`.
3. Сделай Redeploy.
4. Не задавай порт вручную: сервер использует `process.env.PORT`.

`/health` возвращает состояние приложения.

## PDF-инструменты (Stirling-PDF через `/pdf`)

Сайт проксирует путь `/pdf` на отдельный сервис Stirling-PDF (reverse proxy в `server.js`).

1. В том же проекте Railway: **New → Docker Image** → `stirlingtools/stirling-pdf:latest`
   (лучше закрепить конкретную версию).
2. Переменные сервиса Stirling-PDF:
   - `SYSTEM_ROOTURIPATH=/pdf`
   - `LANGS=ru_RU` (по желанию)
   - порт по умолчанию 8080; публичный домен для него создавать **не нужно**.
3. В сервисе сайта (`SUKAAA`) добавь переменную:
   - `STIRLING_URL=http://<имя-сервиса>.railway.internal:8080`
4. Redeploy обоих сервисов. Страница: `/#pdf` или `/pdf/`.

Если `STIRLING_URL` не задан, `/pdf` отключён.

### OCR на русском и кыргызском

В стандартном образе нет русского словаря Tesseract. Папка `stirling/` содержит Dockerfile,
который добавляет `rus` и `kir`. В Railway у сервиса `stirling-pdf`:
**Settings → Source** → подключить репозиторий `app_node`, **Root Directory** = `/stirling`.
Переменные сервиса (`PORT`, `SYSTEM_ROOTURIPATH`, `SYSTEM_DEFAULTLOCALE` и др.) сохраняются.
