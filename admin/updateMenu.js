const { randomBytes } = require("crypto");
const { v4: uuidv4 } = require("uuid");
const { S3Client, PutObjectCommand } = require("@aws-sdk/client-s3");
const { DynamoDBClient, PutItemCommand, UpdateItemCommand, QueryCommand } = require("@aws-sdk/client-dynamodb");

const s3 = new S3Client({});
const dynamo = new DynamoDBClient({});

const MENU_BUCKET = process.env.MENU_BUCKET || process.env.BUCKET || "menu-bucket";
const MENU_TABLE = process.env.MENU_TABLE || "MenuTable"; // Per-dish table: PK=tenantId, SK=dishId

const { json } = require("../http");

function generateDishId() {
  return `DISH-${uuidv4()}`;
}

function isValidUrl(u) {
  try {
    const url = new URL(u);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch (e) {
    return false;
  }
}

function sanitizeFilename(name) {
  return name.replace(/[^a-zA-Z0-9._-]/g, "_");
}

async function uploadBase64ToS3(base64OrDataUri, tenantId, filename, contentType) {
  // soporta data:[mime];base64,XXXX o raw base64
  let matches = base64OrDataUri.match(/^data:(.+);base64,(.+)$/);
  let b64;
  if (matches) {
    contentType = contentType || matches[1];
    b64 = matches[2];
  } else {
    b64 = base64OrDataUri;
  }

  const buffer = Buffer.from(b64, "base64");
  const ext = (contentType || "image/jpeg").split("/", 2)[1] || "jpg";
  const key = `${tenantId}/menu/${Date.now()}-${randomBytes(6).toString("hex")}-${sanitizeFilename(filename || `image.${ext}`)}`;

  await s3.send(
    new PutObjectCommand({
      Bucket: MENU_BUCKET,
      Key: key,
      Body: buffer,
      ContentType: contentType || `image/${ext}`,
      ACL: "public-read",
    })
  );

  // Construir URL pública (asume bucket público / CORS configurado)
  const url = `https://${MENU_BUCKET}.s3.amazonaws.com/${encodeURIComponent(key)}`;
  return url;
}

exports.handler = async (event) => {
  try {
    const body = JSON.parse(event.body || "{}");
  const { tenantId, dishId, name, description, price, available, role, imageUrl, imageBase64, imageFilename, imageContentType } = body;

    // Campos mínimos
    if (!tenantId || (!dishId && !name) || (price === undefined || price === null)) {
      return json(400, { message: "Missing fields: tenantId, name (for create) and price are required" }, event);
    }

    // Role: por seguridad, este endpoint es para admin. Requerir role === 'admin' si se provee.
    if (!role || String(role).toLowerCase() !== "admin") {
      return json(403, { message: "Forbidden: admin role required" }, event);
    }

  const normalizedName = name ? String(name).trim() : null;
  const numericPrice = Number(price);
  if (!dishId && !normalizedName) return json(400, { message: "Invalid name" }, event);
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

    // Create new dish
    if (!dishId) {
      const newDishId = generateDishId();
      const item = {
        tenantId: { S: tenantId },
        dishId: { S: newDishId },
        name: { S: normalizedName },
        price: { N: String(numericPrice) },
        available: { BOOL: available === undefined ? true : !!available },
        createdAt: { S: now },
        updatedAt: { S: now },
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
    }

    // Update existing dish (upsert fields)
    const updateExprParts = ["updatedAt = :updatedAt", "price = :price"];
    const exprAttrValues = {
      ":updatedAt": { S: now },
      ":price": { N: String(numericPrice) },
    };
    const exprAttrNames = {};

    if (normalizedName) {
      updateExprParts.push("#name = :name");
      exprAttrValues[":name"] = { S: normalizedName };
      exprAttrNames["#name"] = "name";
    }
    if (description !== undefined) {
      updateExprParts.push("description = :description");
      exprAttrValues[":description"] = { S: String(description) };
    }
    if (available !== undefined) {
      updateExprParts.push("available = :available");
      exprAttrValues[":available"] = { BOOL: !!available };
    }
    if (finalImageUrl) {
      updateExprParts.push("imageUrl = :imageUrl");
      exprAttrValues[":imageUrl"] = { S: finalImageUrl };
    }

    const UpdateExpression = "SET " + updateExprParts.join(", ");

    try {
      await dynamo.send(
        new UpdateItemCommand({
          TableName: MENU_TABLE,
          Key: { tenantId: { S: tenantId }, dishId: { S: dishId } },
          UpdateExpression,
          ExpressionAttributeValues: exprAttrValues,
          ExpressionAttributeNames: Object.keys(exprAttrNames).length ? exprAttrNames : undefined,
          ConditionExpression: "attribute_exists(dishId)",
        })
      );
    } catch (err) {
      if (err.name === "ConditionalCheckFailedException") {
        return json(404, { message: "Dish not found" }, event);
      }
      console.error("Dynamo error (update dish):", err);
      return json(500, { message: "Failed to update dish" }, event);
    }
    return json(200, { message: "Dish updated", dishId, imageUrl: finalImageUrl }, event);
  } catch (err) {
    console.error("UPDATE MENU ERROR:", err);
    return json(500, { message: "Server error", error: err.message }, event);
  }
};
