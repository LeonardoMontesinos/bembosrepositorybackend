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
	if (typeof password !== "string") return { valid: false, message: "Password must be a string" };
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
	return `WRK-${hash.substring(0, 16)}`;
}

// Validar formato de email
function isValidEmail(email) {
	const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
	return emailRegex.test(email);
}

const { json } = require("../http");

// Roles permitidos para workers
const ALLOWED_ROLES = new Set(["admin", "kitchen", "delivery"]);

exports.handler = async (event) => {
	try {
		const body = JSON.parse(event.body || "{}");
		// Obtener role y tenant del authorizer (protegido). Si no viene, denegar.
		let authRole = null;
		let authTenant = null;
		if (event && event.requestContext && event.requestContext.authorizer) {
			const auth = event.requestContext.authorizer;
			authRole = auth.role || (auth.claims && auth.claims.role) || null;
			authTenant = auth.tenantId || (auth.claims && auth.claims.tenantId) || null;
		}
		if (!authRole || String(authRole).toLowerCase() !== "admin") {
			return json(403, { message: "Forbidden: admin role required" }, event);
		}

		// tenantId for the new worker MUST match the admin's tenant. Ignore body.tenantId or validate it.
		const { tenantId: bodyTenant, email, username, password, role } = body;
		if (!authTenant) {
			return json(400, { message: "Authorizer did not provide tenantId" }, event);
		}
		const tenantId = String(authTenant);
		// If body provided a tenantId different from admin's, reject.
		if (bodyTenant && String(bodyTenant) !== tenantId) {
			return json(400, { message: "tenantId in body must match admin tenant" }, event);
		}

		if (!tenantId || !email || !username || !password || !role) {
			return json(400, { message: "Missing fields" }, event);
		}

		// Validar role permitido
		const normalizedRole = String(role).toLowerCase().trim();
		if (!ALLOWED_ROLES.has(normalizedRole)) {
			return json(400, { message: "Invalid role. Allowed: admin, kitchen, delivery" }, event);
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

		if (typeof tenantId !== "string" || tenantId.trim() === "") {
			return json(400, { message: "Invalid tenantId" }, event);
		}

		const normalizedEmail = email.toLowerCase().trim();
		const normalizedUsername = username.toLowerCase().trim();

		// Verificar si el email ya existe en este tenant
		const emailCheck = await client.send(
			new QueryCommand({
				TableName: USERS_TABLE,
				IndexName: "EmailIndex",
				KeyConditionExpression: "email = :email AND tenantId = :tenantId",
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
				KeyConditionExpression: "username = :username AND tenantId = :tenantId",
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

		return json(201, { message: "Worker created", userId, role: normalizedRole, username: normalizedUsername }, event);
	} catch (err) {
		console.error("CREATE WORKER ERROR:", err);
		return json(500, { message: "Server error", error: err.message }, event);
	}
};

