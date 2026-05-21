# Patches

Заплатки к сторонним компонентам сетапа, которые живут в отдельных репозиториях.

## telegram-mcp-startup-fix.patch

Чинит Telegram MCP-коннектор ([chigwell/telegram-mcp](https://github.com/chigwell/telegram-mcp)), который падал при запуске.

**Проблема.** При старте сервер синхронно грузил все диалоги (`get_dialogs()`). Если Telegram отвечал FLOOD_WAIT (rate-limit), telethon засыпал, сервер не успевал ответить на MCP-handshake, и клиент считал его отключённым. Все последующие вызовы летели в `ConnectionError: Cannot send requests while disconnected`.

**Что меняет:**
- Прогрев кэша диалогов вынесен в фоновую задачу с перехватом `FloodWaitError` — flood wait на старте больше не блокирует запуск.
- Стартовые `print()` переведены из stdout в stderr (для stdio-MCP stdout — это канал JSON-RPC).
- Числовые параметры тулов принимают `Union[int, str]` с приведением `int()` — клиенты, передающие числа строками, не ломают вызовы.

**Как применить** (если переустановил коннектор с нуля):

```bash
cd ~/telegram-mcp
git apply /path/to/patches/telegram-mcp-startup-fix.patch
```

Применять к чистому клону. Если код коннектора уже разошёлся с оригиналом — накладывать вручную по hunk'ам.
