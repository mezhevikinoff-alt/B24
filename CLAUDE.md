# ОРК Отчеты — Приложение для отдела по работе с клиентами

## Инфраструктура
- Репозиторий: https://github.com/mezhevikinoff-alt/B24
- Сервер приложения: https://app-214265deb83b.vibecode.bitrix24.tech
- Портал Битрикс24: credburo.bitrix24.ru
- Ключ авторизации Vibecode API: `vibe_api_wXJ94h3wA502Vmsw2ksXZTraKgElqItx_599bd9`
- Деплой: автоматически через GitHub Actions при push в ветку main

## Deploy API
- Endpoint: `POST https://vibecode.bitrix24.tech/v1/infra/servers/85110525-94ea-40a1-a611-d9dc9a7dd00d/deploy`
- Сервер "ОРК Статистика": `https://app-214265deb83b.vibecode.bitrix24.tech`
- Auth: `Authorization: Bearer <VIBE_INFRA_KEY>` (GitHub secret)
- App key (vibe_app): хранится в GitHub secret `VIBE_APP_KEY`

## Что делает приложение
- График учёта рабочего времени (данные из timeman Битрикс24)
- Отчёт по конверсии лидов в сделки (данные из CRM)
- Расчёт мотивации менеджеров с коэффициентами
- Сводный отчёт по отделу

## Логика расчётов
- Смена: 12 часов, оплачивается 10,5 ч × 445 руб
- Фонд за лид до 18 часов: 300 руб, свыше 18 часов: 200 руб
- Банкротство: фикс 200 руб
- Совместная сделка: 70% закрывшему, 30% помогавшему
- Коэффициенты конверсии применяются к итоговой сумме за месяц
- Исключаемые статусы: Дубль, СПАМ, Предложение по сотрудничеству

## Структура проекта
- /frontend — React + TypeScript + Vite + Tailwind
- /backend — Node.js + Express
- /.github/workflows/deploy.yml — GitHub Actions деплой

## Реестр приложений КредБюро
Файл APPS_REGISTRY.md в корне этого репозитория содержит список всех
приложений компании. При создании нового приложения Битрикс24 обязательно:
1. Добавить строку в таблицу APPS_REGISTRY.md (Приложение / Репозиторий / Сервер / Статус)
2. Закоммитить и запушить изменение

## История изменений
- 16.06.2025 — создано приложение, настроен деплой через GitHub Actions
- 16.06.2026 — переключён деплой на Vibecode Infra deploy API (POST /v1/infra/servers/{id}/deploy)
