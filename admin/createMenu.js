const { DynamoDBClient, PutItemCommand } = require("@aws-sdk/client-dynamodb");
const dynamo = new DynamoDBClient({});
const MENU_TABLE = process.env.MENU_TABLE || "MenuTable"; // Per-dish table: PK=tenantId, SK=dishId
const { json } = require("../http");
const { generateDishId, isValidUrl, uploadBase64ToS3 } = require("./menuHelpers");

exports.handler = async (event) => {
  try {
    const body = JSON.parse(event.body || "{}");
    const { name, description, price, available, imageUrl, imageBase64, imageFilename, imageContentType } = body;

    // Obtener role y tenant desde authorizer (más seguro). Fallback a body.role/tenantId solo si authorizer ausente.
    let role = null;
    let tenantId = null;
    if (event && event.requestContext && event.requestContext.authorizer) {
      const auth = event.requestContext.authorizer;
      // compatibilidad: algunos setups colocan claims bajo authorizer.claims
      const claims = auth.claims || auth;
      role = auth.role || (claims && claims.role) || null;
      tenantId = auth.tenantId || (claims && claims.tenantId) || null;
    }
    if (!role && body.role) role = body.role;
    if (!tenantId && body.tenantId) tenantId = body.tenantId;

    // Campos mínimos para crear
    if (!tenantId || !name || (price === undefined || price === null)) {
      return json(400, { message: "Missing fields: tenantId (from authorizer), name and price are required" }, event);
    }

    // Role: por seguridad, este endpoint es para admin. Requerir role === 'admin'.
    if (!role || String(role).toLowerCase() !== "admin") {
      return json(403, { message: "Forbidden: admin role required" }, event);
    }

    const normalizedName = String(name).trim();
    const numericPrice = Number(price);
    if (!normalizedName) return json(400, { message: "Invalid name" }, event);
    if (Number.isNaN(numericPrice) || numericPrice < 0) return json(400, { message: "Invalid price" }, event);

    let finalImageUrl = null;

    if (imageUrl) {
      if (!isValidUrl(imageUrl)) return json(400, { message: "Invalid imageUrl" }, event);
      finalImageUrl = imageUrl;
    } else if (imageBase64) {
      // subir a S3
      try {
        finalImageUrl = await uploadBase64ToS3(imageBase64, tenantId, imageFilename, imageContentType);
      } catch (err) {
        console.error("S3 upload error:", err);
        return json(500, { message: "Failed to upload image" }, event);
      }
    }

    const now = new Date().toISOString();
    const newDishId = generateDishId();

    const item = {
      tenantId: { S: tenantId },
      dishId: { S: newDishId },
      name: { S: normalizedName },
      price: { N: String(numericPrice) },
      available: { BOOL: available === undefined ? true : !!available },
      createdAt: { S: now },
      updatedAt: { S: now },
      offers: { BOOL: false }
    };
    if (description) item.description = { S: String(description) };
    if (finalImageUrl) item.imageUrl = { S: finalImageUrl };

    try {
      await dynamo.send(
        new PutItemCommand({
          TableName: MENU_TABLE,
          Item: item,
          ConditionExpression: "attribute_not_exists(dishId)",
        })
      );
    } catch (err) {
      if (err.name === "ConditionalCheckFailedException") {
        return json(409, { message: "Dish already exists" }, event);
      }
      console.error("Dynamo error (create dish):", err);
      return json(500, { message: "Failed to create dish" }, event);
    }

    return json(201, { message: "Dish created", dishId: newDishId, imageUrl: finalImageUrl }, event);
  } catch (err) {
    console.error("CREATE MENU ERROR:", err);
    return json(500, { message: "Server error", error: err.message }, event);
  }
};
