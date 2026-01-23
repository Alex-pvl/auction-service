# Telegram Auction Service

Сервис для создания мульти-раундовых аукционов на цифровые товары.<br>
Tech Stack: `TypeScript`, `Node.js`, `Fastify`, `MongoDB`, `Redis`.

## Flows
### Auction Creation Flow
Для создания Аукциона необходимо указать следующие параметры:
- Название Аукциона (опционально)
- Название цифровой товара, выставляемого на Аукцион
- Минимальная ставка
- Количество победителей
- Количество раундов
- Продолжительность первого раунда (опционально)
- Продолжительность остальных раундов
- Дата и время начала Аукциона<br>

Что просчитывается автоматически, после заполнения вышеперечисленных параметров:
- ID Аукциона
- Количество победителей за раунд
- Планируемые дата и время окончания Аукциона
- Статус `DRAFT` Аукциона
- Количество оставшихся цифровых товаров
- Текущий раунд<br>

Также, если мы говорим про экосистему Telegram, то в таком случае мы можем получить initData.user.id или initData.user.username для привязки Аукциона к пользователю. ID пользователя будем передавать в http заголовке X-User-Id

### Auction Edit Flow
Редактировать можно те же поля, которые присутствуют в форме создания Аукциона. Присутствует проверка на `status == DRAFT` и `creator_id`, чтобы избежать `idor` уязвимости.

### Auction Join Flow
При открытии старницы "прямого эфира" Аукциона открывается веб-сокет и показывается текущее состояние Аукциона. Если он еще не в статусе `LIVE`, появляется обратный отсчет до начала Аукциона.

### Auction Bid Flow 
Участник делает ставку и видит, какое место на текущий момент он занимает. После ставки он может добавить валюту к текущей ставке, если выбыл из выигрышного топа. В тг аукционах в первом раунде действует правило (anti-sniping), в течение последних 30 секунд участники могут перебивать ставку, чтобы занять 1 место. Если кто-то перебил 1 место, то добавляется еще 30 секунд.<br>

Если в раунде никто не сделал ставку, просто переходим на следующий, число предметов не уменьшается.<br>

Если ставка не была выигрышной в раунде, она переносится на следующий. Если в последнем раунде она не выиграла, средства возвращаются на баланс пользователя.<br>

С течением раундов, минимальная ставка увеличивается.<br>

Каждая ставка имеет ключ идемпотентости для избежания дублирования ставок от пользователей.

### Auction Bots Flow
Для демонстрации работы аукциона была создана возможность запуска активности от ботов в каждом раунде аукциона. Панель управления ботами расположена в нижней части страницы прямого эфира аукциона. 

## Архитектура

### Общая структура

Сервис построен на основе многослойной архитектуры с разделением ответственности между компонентами:

```
┌─────────────────────────────────────────────────────────┐
│                    HTTP/WebSocket Layer                 │
│  (Fastify API Routes + WebSocket Server)                │
└────────────────────┬────────────────────────────────────┘
                     │
┌────────────────────▼────────────────────────────────────┐
│                   Service Layer                         │
│  ┌──────────────┐ ┌──────────────┐ ┌──────────────┐     │
│  │ Auctions     │ │ Bids-Redis   │ │ Users        │     │
│  └──────────────┘ │ (Redis Lua)  │ └──────────────┘     │
│  ┌──────────────┐ └──────────────┘ ┌──────────────┐     │
│  │ Lifecycle    │ ┌──────────────┐ │ Deliveries   │     │
│  └──────────────┘ │ Mongo-Sync   │ └──────────────┘     │
│  ┌──────────────┐ └──────────────┘ ┌──────────────┐     │
│  │ Bots         │ ┌──────────────┐ │ WebSocket    │     │
│  └──────────────┘ │ Redis-Bids   │ └──────────────┘     │
│                   └──────────────┘                      │
└────────────────────┬────────────────────────────────────┘
                     │
┌────────────────────▼────────────────────────────────────┐
│              Data & Cache Layer                         │
│  ┌──────────────┐          ┌──────────────┐             │
│  │   MongoDB    │◄────────►│    Redis     │             │
│  │  (Storage)   │  Sync    │ (Real-time   │             │
│  │              │          │  Bids +      │             │
│  │              │          │  Balance +   │             │
│  │              │          │  Rate Limit) │             │
│  └──────────────┘          └──────────────┘             │
└─────────────────────────────────────────────────────────┘
```

### Компоненты системы

#### 1. **API Layer** (`src/routes/api-fastify.ts`)
- RESTful API endpoints на базе Fastify для управления аукционами
- Обработка HTTP-запросов с валидацией
- Rate limiting через Redis
- Аутентификация через заголовок `X-User-Id`

**Основные endpoints:**
- `GET /api/auctions` - список аукционов
- `POST /api/auctions` - создание аукциона
- `PUT /api/auctions/:id` - обновление аукциона
- `DELETE /api/auctions/:id` - удаление аукциона
- `GET /api/auctions/:id` - получение аукциона
- `POST /api/auctions/:id/release` - публикация аукциона
- `GET /api/auctions/:id/rounds/:roundIdx/bids` - топ ставки раунда
- `GET /api/auctions/:id/my-bid` - ставка текущего пользователя
- `POST /api/users/auth` - авторизация пользователя
- `POST /api/users/:tgId/balance/increase` - пополнение баланса
- `POST /api/users/:tgId/balance/decrease` - уменьшение баланса
- `GET /api/deliveries` - доставки пользователя
- `POST /api/auctions/:id/bots/start` - запуск ботов
- `POST /api/auctions/:id/bots/stop` - остановка ботов
- Ставки делаются через WebSocket (см. раздел WebSocket ниже)

#### 2. **Service Layer** (`src/services/`)

**`auction-lifecycle.ts`** - Менеджер жизненного цикла аукционов
- Event-driven архитектура на основе MongoDB Change Streams
- Управление таймерами раундов
- Обработка переходов между статусами (DRAFT → RELEASED → LIVE → FINISHED)
- Anti-sniping механизм (автоматическое продление раунда при ставках топ-3)
- Фоновая обработка переноса ставок между раундами через Redis Queue
- Обработка доставок выигрышей

**`auctions.ts`** - Бизнес-логика аукционов
- Создание и валидация аукционов
- Расчет параметров (winners_per_round, planned_end_datetime)
- Обновление статусов

**`bids-redis.ts`** - Управление ставками через Redis (основной сервис)
- Обработка ставок через атомарные Lua скрипты в Redis
- Создание ставок с атомарным списанием баланса
- Идемпотентность через `idempotency_key` (проверка в Redis)
- Расчет позиций участников через Redis Sorted Sets
- Поддержка добавления средств к существующей ставке
- Интеграция с anti-sniping механизмом

**`redis-bids.ts`** - Низкоуровневые операции со ставками в Redis
- Выполнение Lua скриптов для атомарных операций
- Управление балансами пользователей в Redis
- Работа с Sorted Sets для рейтинга ставок
- Кэширование данных ставок

**`bids.ts`** - Управление ставками в MongoDB (legacy/fallback)
- Создание ставок с проверкой баланса
- Расчет позиций участников
- Перенос неудачных ставок на следующий раунд
- Возврат средств проигравшим в последнем раунде

**`users.ts`** - Управление пользователями
- Создание пользователей по Telegram ID
- Управление балансом
- Автоматическое создание при первой ставке

**`websocket.ts`** - WebSocket сервер для real-time обновлений
- Подписка на обновления аукциона
- Обработка ставок через WebSocket (тип сообщения "bid")
- Broadcast изменений состояния
- Оптимизация через дедупликацию обновлений
- Периодическое обновление таймеров

**WebSocket сообщения:**
- `{ type: "subscribe", auction_id: "...", user_id: "..." }` - подписка на аукцион
- `{ type: "bid", auction_id: "...", user_id: "...", amount: 100, idempotency_key: "...", add_to_existing: false }` - создание ставки
- `{ type: "bid_success", bid: {...}, place: 1, remaining_balance: 1000 }` - успешная ставка
- `{ type: "bid_error", error: "..." }` - ошибка при создании ставки

**`bots.ts`** - Симуляция активности ботов
- Регистрация ботов для аукциона
- Автоматические ставки в каждом раунде
- Настройка параметров активности

**`deliveries.ts`** - Управление доставками
- Создание записей о выигрышах
- Обработка статусов доставки
- Статистика по доставкам

**`mongo-sync.ts`** - Синхронизация данных между Redis и MongoDB
- Периодическая синхронизация ставок из Redis в MongoDB (каждую секунду)
- Синхронизация балансов пользователей
- Пересчет позиций участников в MongoDB
- Инициализация балансов из MongoDB в Redis при старте

**`cache.ts`** - Кэширование через Redis
- Кэш топ-ставок
- Кэш данных аукциона
- Кэш позиций пользователей
- Инвалидация кэша при изменениях

#### 3. **Data Layer**

**MongoDB** (`src/storage/mongo.ts`) - Основное хранилище данных

**Модели данных:**
- **Auction** - информация об аукционе
  - Статусы: `DRAFT`, `RELEASED`, `LIVE`, `FINISHED`, `DELETED`
  - Индексы: `status`, `creator_id`, `status + start_datetime`
  
- **Bid** - ставки участников (синхронизируются из Redis)
  - Индексы: `auction_id + round_id + amount`, `idempotency_key` (unique)
  - Примечание: Активные ставки хранятся в Redis, синхронизация в MongoDB происходит асинхронно
  
- **Round** - информация о раундах
  - Индексы: `auction_id + idx` (unique)
  
- **User** - пользователи
  - Индексы: `tg_id` (unique), `username`
  - Примечание: Балансы хранятся в Redis, синхронизируются с MongoDB асинхронно
  
- **Deliveries** - доставки выигрышей
  - Статусы: `PENDING`, `DELIVERED`, `FAILED`
  - Индексы: `auction_id`, `winner_user_id`, `status`

**Redis** - Real-time хранилище ставок, кэширование и очереди

**Структура данных в Redis:**
- `user_balance:{tg_id}` - баланс пользователя (String)
- `bid:{auction_id}:{round_id}:{user_id}` - данные ставки (String, JSON)
- `round_bids:{auction_id}:{round_id}` - рейтинг ставок (Sorted Set, score = -amount для сортировки по убыванию)
- `idempotency:{key}` - проверка идемпотентности (String, TTL 1 час)
- `bid_transfer_queue` - очередь для переноса ставок (List)

**Функциональность:**
- **Real-time ставки**: Хранение активных ставок в Redis с использованием Sorted Sets для рейтинга
- **Балансы пользователей**: Хранение балансов в Redis для быстрого доступа и атомарных операций
- **Lua скрипты**: Атомарные операции со ставками и балансами через Lua скрипты
  - `create-bid.lua` - атомарное создание ставки со списанием баланса
  - `add-to-bid.lua` - атомарное добавление средств к существующей ставке
  - `get-user-place.lua` - получение позиции пользователя в рейтинге
- **Кэширование**: Кэширование часто запрашиваемых данных (топ-ставки, аукционы)
- **Rate limiting**: Rate limiting для API endpoints
- **Очереди**: Очередь для асинхронной обработки переноса ставок (`bid_transfer_queue`)
- **TTL**: Автоматическая инвалидация кэша через TTL (24 часа для ставок)

#### 4. **Middleware** (`src/middleware/rateLimit.ts`)
- Rate limiting на основе Redis
- Разные лимиты для разных типов запросов
- Отключение для load testing

#### 5. **Lua Scripts** (`src/scripts/`)
Атомарные операции в Redis для обеспечения консистентности данных:

**`create-bid.lua`** - Атомарное создание ставки
- Проверка идемпотентности
- Проверка достаточности баланса
- Атомарное списание баланса
- Создание записи о ставке
- Добавление в рейтинг (Sorted Set)
- Возврат результата операции

**`add-to-bid.lua`** - Атомарное добавление средств к ставке
- Проверка существования ставки
- Проверка достаточности баланса
- Атомарное списание и обновление ставки
- Обновление позиции в рейтинге

**`get-user-place.lua`** - Получение позиции пользователя
- Быстрый поиск позиции в Sorted Set
- Возврат места в рейтинге

### Потоки данных

#### Обработка ставки
```
Client → WebSocket → Bids-Redis Service
                        ↓
              Redis (Lua Script)
              - Атомарное списание баланса
              - Создание/обновление ставки
              - Обновление рейтинга (Sorted Set)
                        ↓
              Mongo-Sync Service (асинхронно)
              - Синхронизация в MongoDB
                        ↓
              WebSocket Broadcast
                        ↓
         Lifecycle Manager (если топ-3)
         - Anti-sniping продление раунда
```

#### Жизненный цикл аукциона
```
MongoDB Change Stream → Lifecycle Manager
                            ↓
                    Timer Management
                            ↓
                    Round Transitions
                            ↓
                    Bid Transfer Queue (Redis)
                            ↓
                    Delivery Processing
                            ↓
                    Mongo-Sync Service
                    (синхронизация ставок и балансов)
```

#### Real-time обновления
```
State Change → WebSocket Service
                    ↓
            Subscription Map
                    ↓
            Broadcast to Clients
```

### Особенности архитектуры

1. **Event-Driven подход**
   - Использование MongoDB Change Streams для отслеживания изменений
   - Асинхронная обработка через Redis Queue
   - Минимизация polling через event-driven обновления

2. **Масштабируемость**
   - Stateless API серверы (можно горизонтально масштабировать)
   - Redis для распределенного кэширования, rate limiting и real-time операций
   - Оптимизированные индексы MongoDB
   - Атомарные операции через Lua скрипты для консистентности данных

3. **Надежность**
   - Идемпотентность операций (idempotency_key в Redis)
   - Атомарные операции со ставками через Lua скрипты
   - Синхронизация данных между Redis и MongoDB
   - Graceful shutdown с корректным завершением соединений
   - Обработка ошибок и таймаутов

4. **Производительность**
   - Real-time обработка ставок в Redis (без блокировок MongoDB)
   - Атомарные операции через Lua скрипты (одна операция вместо множества)
   - Sorted Sets для быстрого получения рейтинга
   - Многоуровневое кэширование (Redis)
   - Оптимизация WebSocket обновлений (дедупликация)
   - Индексы для быстрых запросов
   - Асинхронная синхронизация с MongoDB

5. **Безопасность**
   - Rate limiting для защиты от DDoS
   - Валидация входных данных
   - Проверка прав доступа (creator_id)
   - Защита от IDOR уязвимостей
   - Атомарные операции предотвращают race conditions


## Testing
### Prod
- [Web](https://tagwaiter.ru)
- [Mini App](https://t.me/CryptoAuctionDemoBot)

### Local
Для запуска локально необходимо выполнить следующие команды
```bash
cp .env.example .env
docker-compose up -d
chmod +x .init-replica-set.sh
./init-replica-set.sh
npm i
npm run build
npm run dev
# goto http://localhost:3000/
```

### Load
```bash
npm i && npm run build
npm run dev
npm run load-test
```
Пример вывода
```
============================================================
  Auction Service Load Test
============================================================
Base URL: http://localhost:3000
Number of users: 1000
Bids per user: 1
Concurrent bids: 100
Bid amount range: 200 - 1000
Add to existing ratio: 0%
Ramp-up time: 0s
============================================================

✓ MongoDB connected
✓ Redis connected
✓ Rate limiter is disabled for load testing

✓ Server is healthy

Creating new auction for load test...
✓ Created auction: 69725eee1e1321a99c97bc0e
Releasing auction...
✓ Auction released
Waiting for auction to become LIVE...
Start time passed, waiting for status change... (3s elapsed, status: RELEASED)
Start time passed, waiting for status change... (6s elapsed, status: RELEASED)
Start time passed, waiting for status change... (9s elapsed, status: RELEASED)
Start time passed, waiting for status change... (12s elapsed, status: RELEASED)
Start time passed, waiting for status change... (15s elapsed, status: RELEASED)
Start time passed, waiting for status change... (18s elapsed, status: RELEASED)
Start time passed, waiting for status change... (21s elapsed, status: RELEASED)
Start time passed, waiting for status change... (24s elapsed, status: RELEASED)
Start time passed, waiting for status change... (27s elapsed, status: RELEASED)
Status changed: RELEASED → LIVE
✓ Auction 69725eee1e1321a99c97bc0e is now LIVE
Fetching auction data...
Auction parameters:
  Min bid: 100
  Effective bid range: 200 - 1000
  Rounds: 5
  Winners per round: 20

Creating users...
Created 1000/1000 users...
✓ Created 1000 users

Starting load test with 1000 total bids...

Progress: 1000/1000 (100.0%) - 1000 successful - 2012.0724346076458 req/s

============================================================
  Load Test Results
============================================================
Total requests: 1000
Successful: 1000 (100.00%)
Failed: 0 (0.00%)

Throughput:
  Requests per second: 2012.07
  Test duration: 0.50s

Response times (ms):
  Average: 38.95
  Min: 27
  Max: 83
  p50: 34
  p95: 81
  p99: 83
  p99.9: 83

Bid types:
  New bids: 1000
  Add to existing: 0

Note: Using direct method calls instead of WebSocket connections for load testing
============================================================

✓ MongoDB connection closed
✓ Load test completed successfully
```

## Demo

[demo video link](https://drive.google.com/drive/folders/1neewyHGuzeYfQeevTvT3qNlISiY8R80M?usp=drive_link)
