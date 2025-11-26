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
    // Soportar REQUEST authorizer (event.headers) y TOKEN authorizer (event.authorizationToken)
    let token = null;

    if (event && event.headers) {
      // Leer cabecera Authorization (case-insensitive)
      token = event.headers.Authorization || event.headers.authorization;
    }

    // Fallback al campo clásico de TOKEN authorizer
    if (!token && event && event.authorizationToken) {
      token = event.authorizationToken;
    }

    // Validar que el token existe
    if (!token) {
      console.error("AUTHORIZER ERROR: No token provided");
      return {
        principalId: "anonymous",
        policyDocument: {
          Version: "2012-10-17",
          Statement: [
            {
              Action: "execute-api:Invoke",
              Effect: "Deny",
              Resource: event.methodArn || '*',
            },
          ],
        },
        context: {
          error: "No token provided"
        }
      };
    }

    // Verificar que JWT_SECRET está configurado
    if (!process.env.JWT_SECRET) {
      console.error("AUTHORIZER ERROR: JWT_SECRET not configured");
      return {
        principalId: "anonymous",
        policyDocument: {
          Version: "2012-10-17",
          Statement: [
            {
              Action: "execute-api:Invoke",
              Effect: "Deny",
              Resource: event.methodArn || '*',
            },
          ],
        },
        context: {
          error: "JWT_SECRET not configured"
        }
      };
    }

    // Extraer el token (remover "Bearer " si existe)
    const raw = token.replace(/^Bearer\s+/i, "").trim();

    if (!raw || raw.length === 0) {
      console.error("AUTHORIZER ERROR: Empty token after processing");
      return {
        principalId: "anonymous",
        policyDocument: {
          Version: "2012-10-17",
          Statement: [
            {
              Action: "execute-api:Invoke",
              Effect: "Deny",
              Resource: event.methodArn || '*',
            },
          ],
        },
        context: {
          error: "Empty token after processing"
        }
      };
    }

    // Validar formato del token (debe tener 3 partes separadas por puntos)
    const parts = raw.split(".");
    if (parts.length !== 3) {
      console.error("AUTHORIZER ERROR: Invalid token format");
      return {
        principalId: "anonymous",
        policyDocument: {
          Version: "2012-10-17",
          Statement: [
            {
              Action: "execute-api:Invoke",
              Effect: "Deny",
              Resource: event.methodArn || '*',
            },
          ],
        },
        context: {
          error: "Invalid token format"
        }
      };
    }

    const [headerEnc, payloadEnc, signature] = parts;

    // Verificar que las partes no estén vacías
    if (!headerEnc || !payloadEnc || !signature) {
      console.error("AUTHORIZER ERROR: Token parts are empty");
      return {
        principalId: "anonymous",
        policyDocument: {
          Version: "2012-10-17",
          Statement: [
            {
              Action: "execute-api:Invoke",
              Effect: "Deny",
              Resource: event.methodArn || '*',
            },
          ],
        },
        context: {
          error: "Token parts are empty"
        }
      };
    }

    // Verificar firma del token usando el mismo algoritmo (HMAC SHA256) y JWT_SECRET
    const data = `${headerEnc}.${payloadEnc}`;

    const expectedSig = createHmac("sha256", process.env.JWT_SECRET)
      .update(data)
      .digest("base64")
      .replace(/=/g, "")
      .replace(/\+/g, "-")
      .replace(/\//g, "_");

    if (signature !== expectedSig) {
      console.error("AUTHORIZER ERROR: Invalid signature");
      return {
        principalId: "anonymous",
        policyDocument: {
          Version: "2012-10-17",
          Statement: [
            {
              Action: "execute-api:Invoke",
              Effect: "Deny",
              Resource: event.methodArn || '*',
            },
          ],
        },
        context: {
          error: "Invalid signature"
        }
      };
    }

    // Decodificar payload
    let payload;
    try {
      payload = JSON.parse(fromBase64url(payloadEnc));
    } catch (parseError) {
      console.error("AUTHORIZER ERROR: Failed to parse payload", parseError);
      return {
        principalId: "anonymous",
        policyDocument: {
          Version: "2012-10-17",
          Statement: [
            {
              Action: "execute-api:Invoke",
              Effect: "Deny",
              Resource: event.methodArn || '*',
            },
          ],
        },
        context: {
          error: "Failed to parse payload"
        }
      };
    }

    // Validar campos requeridos en el payload
    if (!payload.userId || !payload.role || !payload.email) {
      console.error("AUTHORIZER ERROR: Missing required fields in payload");
      return {
        principalId: "anonymous",
        policyDocument: {
          Version: "2012-10-17",
          Statement: [
            {
              Action: "execute-api:Invoke",
              Effect: "Deny",
              Resource: event.methodArn || '*',
            },
          ],
        },
        context: {
          error: "Missing required fields in payload"
        }
      };
    }

    // Verificar expiración del token
    const now = Math.floor(Date.now() / 1000);
    if (payload.exp && payload.exp < now) {
      console.error("AUTHORIZER ERROR: Token expired");
      return {
        principalId: "anonymous",
        policyDocument: {
          Version: "2012-10-17",
          Statement: [
            {
              Action: "execute-api:Invoke",
              Effect: "Deny",
              Resource: event.methodArn || '*',
            },
          ],
        },
        context: {
          error: "Token expired"
        }
      };
    }

    // Obtener methodArn del evento (puede estar en diferentes lugares según el tipo de authorizer)
    let methodArn = event.methodArn;
    
    // Si no está disponible, intentar construir el ARN o usar wildcard
    if (!methodArn) {
      // Para authorizers de tipo REQUEST, construir ARN desde event.routeArn o usar wildcard
      if (event.routeArn) {
        methodArn = event.routeArn;
      } else if (event.requestContext && event.requestContext.apiId) {
        // Construir ARN básico con wildcard para permitir todas las rutas
        const apiId = event.requestContext.apiId;
        const region = event.requestContext.region || process.env.AWS_REGION || 'us-east-1';
        const accountId = event.requestContext.accountId || '*';
        methodArn = `arn:aws:execute-api:${region}:${accountId}:${apiId}/*/*`;
      } else {
        // Fallback: usar wildcard completo
        methodArn = '*';
      }
    }
    
    // Si el methodArn termina con un método específico, crear wildcard para permitir todas las rutas
    // Esto es necesario porque API Gateway puede pasar ARNs específicos que no coinciden
    if (methodArn && !methodArn.endsWith('*/*')) {
      // Extraer la parte base del ARN (hasta el stage)
      const arnParts = methodArn.split('/');
      if (arnParts.length >= 2) {
        // Reemplazar método y path con wildcards
        methodArn = `${arnParts.slice(0, -2).join('/')}/*/*`;
      }
    }

    // Preparar contexto seguro: API Gateway/Lambda authorizer solo acepta strings
    const safeContext = {};
    for (const key of Object.keys(payload)) {
      // Convertir todos los valores a string
      try {
        safeContext[key] = String(payload[key]);
      } catch (e) {
        safeContext[key] = "" + payload[key];
      }
    }

    // Retornar política IAM con contexto (valores como strings)
    return {
      principalId: String(payload.userId),
      policyDocument: {
        Version: "2012-10-17",
        Statement: [
          {
            Action: "execute-api:Invoke",
            Effect: "Allow",
            Resource: methodArn,
          },
        ],
      },
      context: safeContext,
    };

  } catch (err) {
    console.error("AUTHORIZER ERROR:", err);
    return {
      principalId: "anonymous",
      policyDocument: {
        Version: "2012-10-17",
        Statement: [
          {
            Action: "execute-api:Invoke",
            Effect: "Deny",
            Resource: (event && event.methodArn) || '*',
          },
        ],
      },
      context: {
        error: err.message || "Unauthorized"
      }
    };
  }
};