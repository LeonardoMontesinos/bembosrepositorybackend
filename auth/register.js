const { createHash, randomBytes } = require("crypto");
const { DynamoDBClient, PutItemCommand, QueryCommand } = require("@aws-sdk/client-dynamodb");

const client = new DynamoDBClient({});
const USERS_TABLE = process.env.USER_TABLE || "UserTable";

// Hash seguro nativo (SHA256 + salt)
function hashPassword(password) {
  const salt = randomBytes(16).toString("hex");
  const hash = createHash("sha256").update(salt + password).digest("hex");
  return `${salt}:${hash}`;
}

// Validar fortaleza de contraseña
function isStrongPassword(password) {
  // Mínimo 8 caracteres
  if (password.length < 8) {
    return { valid: false, message: "Password must be at least 8 characters long" };
  }
  
  // Al menos una minúscula
  if (!/[a-z]/.test(password)) {
    return { valid: false, message: "Password must contain at least one lowercase letter" };
  }
  
  // Al menos un número
  if (!/[0-9]/.test(password)) {
    return { valid: false, message: "Password must contain at least one number" };
  }
  
  return { valid: true };
}

// Generador de userId único incluyendo tenantId para evitar colisiones entre tenants
function generateUserId(email, username, tenantId) {
  const raw = `${email}:${username}:${tenantId}:${Date.now()}:${Math.random()}`;
  const hash = createHash("sha256").update(raw).digest("hex");
  return `USR-${hash.substring(0, 16)}`;
}

// Validar formato de email
function isValidEmail(email) {
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(email);
}

// Validar role
function isValidRole(role) {
  const validRoles = ["Kitchen", "User", "Admin","Delivery"];
  return validRoles.includes(role);
}

// NOTE: department logic removed — this service is multitenant and departments were not required.

const { json } = require("../http");

exports.handler = async (event) => {
  try {
    const body = JSON.parse(event.body);
    const { tenantId, email, username, password, role } = body;

    if (!tenantId || !email || !username || !password || !role) {
      return json(400, { message: "Missing fields" }, event);
    }

    // Validar formato de email
    if (!isValidEmail(email)) {
      return json(400, { message: "Invalid email format" }, event);
    }

    // Validar fortaleza de contraseña
    const passwordValidation = isStrongPassword(password);
    if (!passwordValidation.valid) {
      return json(400, { message: passwordValidation.message }, event);
    }

    // Validar role
    if (!isValidRole(role)) {
      return json(400, { message: "Invalid role. Must be one of: Kitchen, User, Admin, Delivery" }, event);
    }

    // tenantId should be a non-empty string — minimal validation
    if (typeof tenantId !== "string" || tenantId.trim() === "") {
      return json(400, { message: "Invalid tenantId" }, event);
    }

    // Normalizar email y username para comparacion
    const normalizedEmail = email.toLowerCase().trim();
    const normalizedUsername = username.toLowerCase().trim();
    const normalizedRole = role.toLowerCase();

    // Verificar si el email ya existe en este tenant (Query + Filter para ser compatible con distintos diseños de índices)
    const emailCheck = await client.send(
      new QueryCommand({
        TableName: USERS_TABLE,
        IndexName: "EmailIndex",
        KeyConditionExpression: "email = :email",
        FilterExpression: "tenantId = :tenantId",
        ExpressionAttributeValues: {
          ":email": { S: normalizedEmail },
          ":tenantId": { S: tenantId },
        },
      })
    );

    if (emailCheck.Items && emailCheck.Items.length > 0) {
      return json(409, { message: "Email already registered for this tenant" }, event);
    }

    // Verificar si el username ya existe en este tenant
    const usernameCheck = await client.send(
      new QueryCommand({
        TableName: USERS_TABLE,
        IndexName: "UsernameIndex",
        KeyConditionExpression: "username = :username",
        FilterExpression: "tenantId = :tenantId",
        ExpressionAttributeValues: {
          ":username": { S: normalizedUsername },
          ":tenantId": { S: tenantId },
        },
      })
    );

    if (usernameCheck.Items && usernameCheck.Items.length > 0) {
      return json(409, { message: "Username already taken for this tenant" }, event);
    }

  const hashedPassword = hashPassword(password);
  const userId = generateUserId(normalizedEmail, normalizedUsername, tenantId);

    // Insertar con ConditionExpression para evitar duplicados por userId
    try {
      const item = {
        tenantId: { S: tenantId },
        userId: { S: userId },
        email: { S: normalizedEmail },
        username: { S: normalizedUsername },
        password: { S: hashedPassword },
        role: { S: normalizedRole },
      };

      await client.send(
        new PutItemCommand({
          TableName: USERS_TABLE,
          Item: item,
          ConditionExpression: "attribute_not_exists(userId)",
        })
      );
    } catch (putError) {
      if (putError.name === "ConditionalCheckFailedException") {
        return json(409, { message: "User already exists" }, event);
      }
      throw putError;
    }

    return json(201, { message: "User created", userId }, event);

  } catch (err) {
    console.error("REGISTER ERROR:", err);
    
    return json(500, { message: "Server error", error: err.message }, event);
  }
};
