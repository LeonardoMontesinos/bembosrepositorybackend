// Lightweight helper to standardize Lambda proxy JSON responses with CORS
// Configure allowed origins via env ALLOWED_ORIGINS (comma-separated),
// defaults to localhost:5173 for local development

const DEFAULT_ALLOWED_ORIGINS = ["*"]; // default to any origin

function getAllowedOrigins() {
  const env = process.env.ALLOWED_ORIGINS;
  if (!env || !env.trim()) return DEFAULT_ALLOWED_ORIGINS;
  const trimmed = env.trim();
  if (trimmed === "*") return "*";
  return trimmed
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function pickOrigin(event) {
  try {
    const origins = getAllowedOrigins();
    if (origins === "*") return "*";
    const incoming = (event && event.headers && (event.headers.origin || event.headers.Origin)) || "";
    if (incoming && origins.includes(incoming)) return incoming;
    // Fallback to first allowed origin
    return origins[0] || "*";
  } catch {
    return DEFAULT_ALLOWED_ORIGINS[0];
  }
}

function corsHeaders(event) {
  const origin = pickOrigin(event);
  const allowCredsEnv = (process.env.CORS_ALLOW_CREDENTIALS || "false").toLowerCase() === "true";
  // If wildcard origin, credentials must be disabled per CORS spec
  const allowCredentials = origin === "*" ? false : allowCredsEnv;
  return {
    "Access-Control-Allow-Origin": origin,
    ...(allowCredentials ? { "Access-Control-Allow-Credentials": "true" } : {}),
    "Access-Control-Allow-Headers": "Content-Type,Authorization,X-Requested-With",
    "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS",
    Vary: "Origin",
  };
}

function json(statusCode, body, event) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json",
      ...corsHeaders(event),
    },
    body: JSON.stringify(body),
  };
}

module.exports = { json, corsHeaders };