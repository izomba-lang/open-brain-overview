# Patches

Fixes for third-party components of the setup that live in separate repositories.

## telegram-mcp-startup-fix.patch

Fixes the Telegram MCP connector ([chigwell/telegram-mcp](https://github.com/chigwell/telegram-mcp)), which used to crash on startup.

**Problem.** On startup the server synchronously loaded all dialogs (`get_dialogs()`). If Telegram responded with FLOOD_WAIT (rate limit), telethon would sleep, the server wouldn't respond to the MCP handshake in time, and the client would consider it disconnected. Every subsequent call then failed with `ConnectionError: Cannot send requests while disconnected`.

**What it changes:**
- Warming the dialog cache is moved to a background task with `FloodWaitError` handling — a flood wait at startup no longer blocks the server from starting.
- Startup `print()` calls are moved from stdout to stderr (for a stdio MCP server, stdout is the JSON-RPC channel).
- Numeric tool parameters now accept `Union[int, str]` with an `int()` cast — clients that pass numbers as strings no longer break the calls.

**How to apply** (if you reinstalled the connector from scratch):

```bash
cd ~/telegram-mcp
git apply /path/to/patches/telegram-mcp-startup-fix.patch
```

Apply to a clean clone. If the connector's code has already diverged from upstream, apply the hunks manually.
