# ОРК — Отчёты

Приложение для отдела по работе с клиентами кредитно-брокерской компании.

## Модули

| Модуль | Описание |
|--------|----------|
| График работы | Таблица отработанных часов из timeman, редактирование (admin) |
| Конверсия лидов | Лиды из CRM, расчёт фонда, совместные сделки |
| Сводный отчёт | Мотивация по всем менеджерам, экспорт в Excel |

## Стек

- **Frontend**: React 18 + TypeScript + Vite + Tailwind CSS
- **Backend**: Node.js + Express (BlackHole/Vibecode)
- **Интеграция**: Bitrix24 BX24.js SDK (REST API)

---

## Деплой на Vibecode

### 1. Установите зависимости

```bash
cd frontend && npm install
cd ../backend && npm install
```

### 2. Запустите деплой

```bash
VIBE_API_KEY=vibe_api_wXJ94h3wA502Vmsw2ksXZTraKgElqItx_599bd9 bash deploy.sh
```

Или вручную:

```bash
# Build frontend (output → backend/public/)
cd frontend && npm run build

# Build backend
cd ../backend && npm run build

# Запустить локально для теста
node backend/dist/server.js
```

### 3. Запишите URL приложения

После деплоя Vibecode выдаст URL вида `https://ork-reports.vibecode.bitrix24.tech`.

---

## Настройка Битрикс24

### Вариант A: Локальное приложение (быстрый старт)

1. Зайдите в Битрикс24 → **Разработчикам** → **Другое** → **Локальные приложения**
2. Нажмите **"Добавить"**
3. Заполните:
   - **Название**: `ОРК — Отчёты`
   - **URL обработчика**: `https://ваш-url.vibecode.bitrix24.tech`
   - **Права**: `CRM`, `Учёт рабочего времени`, `Пользователи`, `Размещение интерфейсов`
4. Нажмите **Сохранить**
5. Откройте приложение и разрешите доступ

### Вариант B: Через REST API — привязка к левому меню

После установки приложения выполните в консоли браузера (или через BX24.callMethod):

```javascript
BX24.callMethod('placement.bind', {
  PLACEMENT: 'APPLICATION_LEFT_MENU',
  HANDLER: 'https://ваш-url.vibecode.bitrix24.tech',
  LANG_ALL: {
    ru: { NAME: 'ОРК — Отчёты' }
  }
}, function(result) {
  console.log(result.data());
});
```

---

## Конфигурация

### Статусы лидов для исключения

В файле `frontend/src/api/bitrix.ts` измените массив `EXCLUDE_STATUS_IDS_CONFIG`:

```typescript
export const EXCLUDE_STATUS_IDS_CONFIG = [
  'JUNK',       // СПАМ
  'DUPLICATE',  // Дубль
  'RECYCLED',   // Устаревшие
  '12',         // Предложение по сотрудничеству — замените на ID из вашего Битрикс24
];
```

Чтобы узнать ID статусов:
```javascript
BX24.callMethod('crm.status.list', {FILTER: {ENTITY_ID: 'STATUS'}}, console.log)
```

### Воронка "Банкротство"

Приложение автоматически определяет воронку "Банкротство" по имени категории сделки (ищет "банкрот" без учёта регистра). Если у вас другое название, настройте в `frontend/src/api/bitrix.ts`.

---

## Локальная разработка

```bash
# Терминал 1: Backend
cd backend && npm run dev

# Терминал 2: Frontend
cd frontend && npm run dev
```

Frontend запустится на `http://localhost:5173`, backend на `:3001`.

> ⚠️ BX24.js работает только внутри iframe Битрикс24. При локальной разработке используйте `ngrok` или разверните на Vibecode.

---

## Логика расчёта мотивации

```
Конверсия отдела = конвертировано / (всего лидов — исключённые)

Коэффициенты (применяются к итоговой сумме по категории):
  ≤20% → ×1.0   (200₽ категория) / ×1.0   (300₽ категория)
  ≤21% → ×1.69  / ×1.75
  ≤22% → ×1.77  / ×1.84
  ≤23% → ×1.86  / ×1.93
  ≤24% → ×1.94  / ×2.01
  ≤25% → ×2.03  / ×2.10
  >25% → ×2.03  / ×2.10  (макс.)

ЗП менеджера = (Часы × 445) + (Фонд 300₽ × к-т 300) + (Фонд 200₽ × к-т 200) + (Банкротство × 200)
```
