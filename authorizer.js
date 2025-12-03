const { createHmac } = require("crypto");

// Convertir Base64URL a Buffer y devolver string JSON
function fromBase64url(str) {
  str = str.replace(/-/g, "+").replace(/_/g, "/");
  const pad = str.length % 4;
  if (pad) str += "=".repeat(4 - pad);
  return Buffer.from(str, "base64").toString();
}

exports.handler = async (event) => {
  try {
    // 1. OBTENCIÓN DEL TOKEN (Soporte Híbrido: HTTP y WebSockets)
    let token = null;

    // A. Intentar Header (API Gateway REST / HTTP)
    if (event.headers) {
      token = event.headers.Authorization || event.headers.authorization;
    }

    // B. Intentar Query String (WebSockets: wss://...?token=XYZ)
    if (!token && event.queryStringParameters && event.queryStringParameters.token) {
      token = event.queryStringParameters.token;
    }

    // C. Intentar Payload clásico (Token Authorizers antiguos)
    if (!token && event.authorizationToken) {
      token = event.authorizationToken;
    }

    // 2. VALIDACIONES BÁSICAS
    if (!token) {
      console.error("AUTHORIZER: No token found");
      throw new Error("Unauthorized");
    }

    if (!process.env.JWT_SECRET) {
      console.error("AUTHORIZER: JWT_SECRET missing");
      throw new Error("Server Error");
    }

    // Limpiar prefijo Bearer si existe
    const raw = token.replace(/^Bearer\s+/i, "").trim();
    const parts = raw.split(".");

    if (parts.length !== 3) {
      console.error("AUTHORIZER: Invalid token structure");
      throw new Error("Unauthorized");
    }

    // 3. VERIFICACIÓN DE FIRMA (HMAC SHA256)
    const [headerEnc, payloadEnc, signature] = parts;
    const data = `${headerEnc}.${payloadEnc}`;
    
    const expectedSig = createHmac("sha256", process.env.JWT_SECRET)
      .update(data)
      .digest("base64")
      .replace(/=/g, "")
      .replace(/\+/g, "-")
      .replace(/\//g, "_");

    if (signature !== expectedSig) {
      console.error("AUTHORIZER: Signature mismatch");
      throw new Error("Unauthorized");
    }

    // 4. DECODIFICAR PAYLOAD Y VALIDAR EXPIRACIÓN
    const payload = JSON.parse(fromBase64url(payloadEnc));
    const now = Math.floor(Date.now() / 1000);

    if (payload.exp && payload.exp < now) {
      console.error("AUTHORIZER: Token expired");
      throw new Error("Unauthorized");
    }

    // 5. CONSTRUCCIÓN DE LA POLÍTICA IAM
    // Determinar el Resource (ARN) al que se da acceso.
    // Usamos wildcard para simplificar y evitar problemas de caché de políticas en WS.
    const methodArn = event.methodArn || event.routeArn || '*';

    // Contexto seguro (Solo strings permitidos en Lambda Authorizers)
    const context = {
      userId: String(payload.userId),
      role: String(payload.role),
      email: String(payload.email),
      tenantId: String(payload.tenantId || "DEFAULT")
    };

    return {
      principalId: payload.userId,
      policyDocument: {
        Version: "2012-10-17",
        Statement: [
          {
            Action: "execute-api:Invoke",
            Effect: "Allow",
            Resource: "*", // Permitir invocar cualquier ruta de esta API
          },
        ],
      },
      context: context,
    };

  } catch (err) {
    console.error("AUTHORIZER ERROR:", err.message);
    // Para API Gateway, lanzar "Unauthorized" gatilla un 401.
    throw new Error("Unauthorized");
  }
};
