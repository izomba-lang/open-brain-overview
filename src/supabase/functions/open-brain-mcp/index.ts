// open-brain-mcp — MCP server entrypoint.
// Thin transport shell: serve + auth + HTTP routing. Tool logic lives in
// handlers/*.ts; the MCP protocol layer (TOOLS catalog + JSON-RPC dispatch)
// lives in transport.ts.

import { handleMcpRequest, sseEncode, CORS_HEADERS } from "./transport.ts";

// --- Auth ---

function authenticate(req: Request): boolean {
  const expectedKey = Deno.env.get("MCP_ACCESS_KEY");
  if (!expectedKey) return false;

  const headerKey = req.headers.get("x-brain-key");
  if (headerKey === expectedKey) return true;

  const url = new URL(req.url);
  const queryKey = url.searchParams.get("key");
  if (queryKey === expectedKey) return true;

  return false;
}

// --- Main HTTP handler ---

Deno.serve(async (req: Request) => {
  // CORS preflight
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: CORS_HEADERS });
  }

  // Auth check
  if (!authenticate(req)) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json", ...CORS_HEADERS },
    });
  }

  const url = new URL(req.url);
  const path = url.pathname.split("/").pop(); // last segment

  // --- SSE transport: GET /sse — open event stream with endpoint discovery ---
  if (req.method === "GET" && path === "sse") {
    const host = url.hostname;
    const key = url.searchParams.get("key") || "";
    const messagesUrl = `https://${host}/functions/v1/open-brain-mcp/messages?key=${encodeURIComponent(key)}`;

    let keepAliveTimer: ReturnType<typeof setInterval>;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(sseEncode("endpoint", messagesUrl));
        // Keep-alive ping every 30s to prevent timeout
        keepAliveTimer = setInterval(() => {
          try {
            controller.enqueue(new TextEncoder().encode(": ping\n\n"));
          } catch {
            clearInterval(keepAliveTimer);
          }
        }, 30_000);
      },
      cancel() {
        clearInterval(keepAliveTimer);
      },
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
        ...CORS_HEADERS,
      },
    });
  }

  // --- SSE transport: POST /messages — JSON-RPC, response in POST body ---
  // Serverless-compatible: no cross-request state needed
  if (req.method === "POST" && path === "messages") {
    try {
      const body = await req.json();
      const result = await handleMcpRequest(body);
      if (!result) {
        return new Response(null, { status: 202, headers: CORS_HEADERS });
      }
      return new Response(JSON.stringify(result), {
        headers: { "Content-Type": "application/json", ...CORS_HEADERS },
      });
    } catch (err) {
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          error: {
            code: -32700,
            message: `Parse error: ${err instanceof Error ? err.message : "Unknown"}`,
          },
        }),
        { status: 400, headers: { "Content-Type": "application/json", ...CORS_HEADERS } }
      );
    }
  }

  // Health check
  if (path === "health" || req.method === "GET") {
    return new Response(JSON.stringify({ status: "ok", server: "open-brain-mcp" }), {
      headers: { "Content-Type": "application/json", ...CORS_HEADERS },
    });
  }

  // MCP endpoint — handle POST with JSON-RPC (Streamable HTTP transport)
  if (req.method === "POST") {
    try {
      const body = await req.json();

      // Handle batch requests
      if (Array.isArray(body)) {
        const results = [];
        for (const item of body) {
          const result = await handleMcpRequest(item);
          if (result) results.push(result);
        }
        return new Response(JSON.stringify(results), {
          headers: { "Content-Type": "application/json", ...CORS_HEADERS },
        });
      }

      // Single request
      const result = await handleMcpRequest(body);
      if (!result) {
        return new Response(null, { status: 204, headers: CORS_HEADERS });
      }
      return new Response(JSON.stringify(result), {
        headers: { "Content-Type": "application/json", ...CORS_HEADERS },
      });
    } catch (err) {
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          error: {
            code: -32700,
            message: `Parse error: ${err instanceof Error ? err.message : "Unknown"}`,
          },
        }),
        { status: 400, headers: { "Content-Type": "application/json", ...CORS_HEADERS } }
      );
    }
  }

  // DELETE — close session (no-op)
  if (req.method === "DELETE") {
    return new Response(JSON.stringify({ ok: true }), {
      headers: { "Content-Type": "application/json", ...CORS_HEADERS },
    });
  }

  return new Response("Method not allowed", { status: 405 });
});
