const { createHash, randomBytes } = require("crypto");
const { DynamoDBClient, PutItemCommand, QueryCommand } = require("@aws-sdk/client-dynamodb");
// 1. IMPORTAMOS EL CLIENTE SNS
const { SNSClient, SubscribeCommand } = require("@aws-sdk/client-sns");

const client = new DynamoDBClient({});
const sns = new SNSClient({}); // Cliente SNS
const USERS_TABLE = process.env.USER_TABLE || "UserTable";
const CUSTOMER_TOPIC_ARN = process.env.CUSTOMER_TOPIC_ARN; // Traemos el ARN del env

// ... (MANTÉN TUS FUNCIONES AUXILIARES IGUALES: hashPassword, isStrongPassword, generateUserId, isValidEmail) ...
// Hash seguro nativo (SHA256 + salt)
function hashPassword(password) {
  const salt = randomBytes(16).toString("hex");
  const hash = createHash("sha256").update(salt + password).digest("hex");
  return `${salt}:${hash}`;
}

function isStrongPassword(password) {
  if (password.length < 8) return { valid: false, message: "Password must be at least 8 characters long" };
  if (!/[a-z]/.test(password)) return { valid: false, message: "Password must contain at least one lowercase letter" };
  if (!/[0-9]/.test(password)) return { valid: false, message: "Password must contain at least one number" };
  return { valid: true };
}

function generateUserId(email, username, tenantId) {
  const raw = `${email}:${username}:${tenantId}:${Date.now()}:${Math.random()}`;
  const hash = createHash("sha256").update(raw).digest("hex");
  return `USR-${hash.substring(0, 16)}`;
}

function isValidEmail(email) {
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(email);
}

const { json } = require("../http");

exports.handler = async (event) => {
  try {
    const body = JSON.parse(event.body || "{}");
    const { tenantId, email, username, password } = body;

    if (!tenantId || !email || !username || !password) {
      return json(400, { message: "Missing fields" }, event);
    }
    if (!isValidEmail(email)) return json(400, { message: "Invalid email format" }, event);
    
    const passwordValidation = isStrongPassword(password);
    if (!passwordValidation.valid) return json(400, { message: passwordValidation.message }, event);

    if (typeof tenantId !== "string" || tenantId.trim() === "") return json(400, { message: "Invalid tenantId" }, event);

    const normalizedEmail = email.toLowerCase().trim();
    const normalizedUsername = username.toLowerCase().trim();
    const normalizedRole = "user";

    // Verificar email
    const emailCheck = await client.send(new QueryCommand({
        TableName: USERS_TABLE,
        IndexName: "EmailIndex",
        KeyConditionExpression: "email = :email AND tenantId = :tenantId",
        ExpressionAttributeValues: { ":email": { S: normalizedEmail }, ":tenantId": { S: tenantId } },
    }));
    if (emailCheck.Items && emailCheck.Items.length > 0) return json(409, { message: "Email already registered for this tenant" }, event);

    // Verificar username
    const usernameCheck = await client.send(new QueryCommand({
        TableName: USERS_TABLE,
        IndexName: "UsernameIndex",
        KeyConditionExpression: "username = :username AND tenantId = :tenantId",
        ExpressionAttributeValues: { ":username": { S: normalizedUsername }, ":tenantId": { S: tenantId } },
    }));
    if (usernameCheck.Items && usernameCheck.Items.length > 0) return json(409, { message: "Username already taken for this tenant" }, event);

    const hashedPassword = hashPassword(password);
    const userId = generateUserId(normalizedEmail, normalizedUsername, tenantId);

    // Insertar Usuario
    try {
      await client.send(new PutItemCommand({
        TableName: USERS_TABLE,
        Item: {
          tenantId: { S: tenantId },
          userId: { S: userId },
          email: { S: normalizedEmail },
          username: { S: normalizedUsername },
          password: { S: hashedPassword },
          role: { S: normalizedRole },
        },
        ConditionExpression: "attribute_not_exists(userId)",
      }));

      // ======================================================
      // 2. SUSCRIPCIÓN AUTOMÁTICA A SNS (LA MAGIA)
      // ======================================================
      if (CUSTOMER_TOPIC_ARN) {
        try {
            console.log(`Subscribing ${normalizedEmail} to SNS Topic...`);
            const filterPolicy = {
                receiver_email: [normalizedEmail] // Solo acepta mensajes donde receiver_email == mi email
            };
            await sns.send(new SubscribeCommand({
                TopicArn: CUSTOMER_TOPIC_ARN,
                Protocol: 'email',
                Endpoint: normalizedEmail,
                Attributes: {
                    FilterPolicy: JSON.stringify(filterPolicy) // <--- LA MAGIA
                }
            }));
            console.log("Subscription request sent.");
        } catch (snsError) {
            // No fallamos el registro si falla SNS, pero lo logueamos
            console.error("SNS SUBSCRIPTION FAILED:", snsError);
        }
      }

    } catch (putError) {
      if (putError.name === "ConditionalCheckFailedException") return json(409, { message: "User already exists" }, event);
      throw putError;
    }

    return json(201, { 
        message: "User created. Please check your email to confirm notifications.", 
        userId, 
        username: normalizedUsername 
    }, event);

  } catch (err) {
    console.error("REGISTER ERROR:", err);
    return json(500, { message: "Server error", error: err.message }, event);
  }
};