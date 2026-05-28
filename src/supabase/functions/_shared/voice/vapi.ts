// Тонкая обёртка над Vapi REST API. Только то, что реально нужно MVP.

const VAPI_API_KEY = Deno.env.get("VAPI_API_KEY") || "";
const VAPI_BASE = "https://api.vapi.ai";

export interface VapiCallRequest {
  assistantId: string;
  phoneNumberId: string;
  customer: { number: string };
  assistantOverrides?: {
    variableValues?: Record<string, string>;
    firstMessage?: string;
    model?: { messages?: Array<{ role: string; content: string }> };
  };
  metadata?: Record<string, unknown>;
}

export interface VapiCallResponse {
  id: string;
  status: string;
  [key: string]: unknown;
}

async function vapiFetch(path: string, init: RequestInit = {}): Promise<Response> {
  if (!VAPI_API_KEY) throw new Error("VAPI_API_KEY is not configured");
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${VAPI_API_KEY}`);
  if (init.body && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  const res = await fetch(`${VAPI_BASE}${path}`, { ...init, headers });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Vapi ${path} failed ${res.status}: ${body}`);
  }
  return res;
}

export async function createOutboundCall(req: VapiCallRequest): Promise<VapiCallResponse> {
  const res = await vapiFetch("/call", { method: "POST", body: JSON.stringify(req) });
  return await res.json();
}

export async function getCall(callId: string): Promise<VapiCallResponse> {
  const res = await vapiFetch(`/call/${callId}`);
  return await res.json();
}
