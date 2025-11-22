const { DynamoDBClient, QueryCommand, ScanCommand } = require("@aws-sdk/client-dynamodb");
const { createHash, createHmac } = require("crypto");

const client = new DynamoDBClient({});
const USERS_TABLE = process.env.USER_TABLE || "UserTable";

// Verificar contraseña
function verifyPassword(password, stored) {
  const [salt, hash] = stored.split(":");
  const newHash = createHash("sha256").update(salt + password).digest("hex");
  return newHash === hash;
}

// Helper Base64URL
function base64url(input) {
  return Buffer.from(input)
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

// Generador de JWT nativo
function signJWT(payload, secret, expiresInSec = 3600) {
  const header = {
    alg: "HS256",
    typ: "JWT",
  };

  const current = Math.floor(Date.now() / 1000);
  payload.exp = current + expiresInSec;

  const headerEnc = base64url(JSON.stringify(header));
  const payloadEnc = base64url(JSON.stringify(payload));

  const data = `${headerEnc}.${payloadEnc}`;

  const signature = createHmac("sha256", secret)
    .update(data)
    .digest("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");

  return `${data}.${signature}`;
}

const { json } = require("../http");

exports.handler = async (event) => {
  try {
    const body = JSON.parse(event.body);
    const { tenantId, email, password } = body;

    // Validar campos requeridos
    if (!tenantId || !email || !password) {
      return json(400, { message: "Missing fields: tenantId, email (or username) and password are required" }, event);
    }

    if (typeof tenantId !== "string" || tenantId.trim() === "") {
      return json(400, { message: "Invalid tenantId" }, event);
    }

    // Normalizar identificador (puede ser email o username)
    const identifier = String(email).toLowerCase().trim();

    // Primero intentar buscar por email en EmailIndex (filtrando por tenant)
    let res;
    try {
      res = await client.send(
        new QueryCommand({
          TableName: USERS_TABLE,
          IndexName: "EmailIndex",
          KeyConditionExpression: "email = :email",
          FilterExpression: "tenantId = :tenantId",
          ExpressionAttributeValues: {
            ":email": { S: identifier },
            ":tenantId": { S: tenantId },
          },
        })
      );
    } catch (qErr) {
      // Si el índice no existe o hay otro error, lo ignoramos y seguiremos al siguiente intento
      console.warn("EmailIndex query failed, will fallback to username query or scan:", qErr.message || qErr);
      res = { Items: [] };
    }

    // Si no se encontró por email, intentar por username
    if (!res.Items || res.Items.length === 0) {
      try {
        res = await client.send(
          new QueryCommand({
            TableName: USERS_TABLE,
            IndexName: "UsernameIndex",
            KeyConditionExpression: "username = :username",
            FilterExpression: "tenantId = :tenantId",
            ExpressionAttributeValues: {
              ":username": { S: identifier },
              ":tenantId": { S: tenantId },
            },
          })
        );
      } catch (qErr) {
        console.warn("UsernameIndex query failed, will fallback to scan:", qErr.message || qErr);
        res = { Items: [] };
      }
    }

    // Si aun no hay resultados, fallback a Scan (menos eficiente) que busque por email o username dentro del tenant
    if (!res.Items || res.Items.length === 0) {
      try {
        res = await client.send(
          new ScanCommand({
            TableName: USERS_TABLE,
            FilterExpression: "tenantId = :tenantId AND (email = :identifier OR username = :identifier)",
            ExpressionAttributeValues: {
              ":tenantId": { S: tenantId },
              ":identifier": { S: identifier },
            },
            Limit: 1,
          })
        );
      } catch (scanErr) {
        console.error("Scan fallback failed:", scanErr);
        return json(500, { message: "Server error" }, event);
      }
    }

    if (!res.Items || res.Items.length === 0) {
      return json(401, { message: "Invalid credentials" }, event);
    }

    const user = res.Items[0];

    // Verificar contraseña
    if (!user.password || !user.password.S) {
      return json(401, { message: "Invalid credentials" }, event);
    }

    const valid = verifyPassword(password, user.password.S);
    if (!valid) {
      return json(401, { message: "Invalid credentials" }, event);
    }

    // Validar campos requeridos del usuario
    if (!user.userId || !user.userId.S || !user.role || !user.role.S || !user.email || !user.email.S) {
      console.error("LOGIN ERROR: User data incomplete");
      return json(401, { message: "Invalid credentials" }, event);
    }

    // Verificar que JWT_SECRET está configurado
    if (!process.env.JWT_SECRET) {
      console.error("LOGIN ERROR: JWT_SECRET not configured (env variable missing)");
      return json(500, { message: "Server error: JWT_SECRET is not set in environment" }, event);
    }

    // Generar JWT
    const payload = {
      tenantId: user.tenantId ? user.tenantId.S : tenantId,
      userId: user.userId.S,
      role: user.role.S,
      email: user.email.S,
    };

    const token = signJWT(payload, process.env.JWT_SECRET);

    return json(200, { token }, event);

  } catch (err) {
    console.error("LOGIN ERROR:", err);
    return json(500, { message: "Server error", error: err.message }, event);
  }
};
