# fb-ads-mcp

Facebook Ads MCP сервер для Claude. Позволяет управлять рекламными кампаниями прямо из чата.

## Деплой на Railway (бесплатно)

### 1. Залей файлы в GitHub
Убедись что в репозитории есть:
- `server.js`
- `package.json`
- `README.md`

### 2. Задеплой на Railway
1. Заходи на **railway.app**
2. Нажми **"New Project"**
3. Выбери **"Deploy from GitHub repo"**
4. Выбери репозиторий `fb-ads-mcp`
5. Railway сам установит зависимости и запустит сервер

### 3. Добавь переменные окружения
В Railway → твой проект → вкладка **Variables**, добавь:
```
META_TOKEN=твой_access_token
META_ACCOUNT_ID=1852792902078959
```

### 4. Получи URL сервера
Railway даст тебе URL вида:
```
https://fb-ads-mcp-production.up.railway.app
```

### 5. Подключи к Claude
В claude.ai → Settings → Connectors → Add MCP Server:
```
URL: https://твой-url.up.railway.app/sse
```

## Инструменты

| Инструмент | Что делает |
|---|---|
| `get_campaigns` | Все кампании с метриками |
| `get_adsets` | Адсеты кампании |
| `get_ads` | Объявления и крео |
| `toggle_campaign` | Пауза/запуск кампании |
| `toggle_adset` | Пауза/запуск адсета |
| `update_budget` | Изменить бюджет |
| `duplicate_adset` | Дублировать адсет |
| `check_limits` | Проверить лимиты |
| `get_account_summary` | Сводка по аккаунту |
