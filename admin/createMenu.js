const { randomBytes } = require("crypto");
const { v4: uuidv4 } = require("uuid");
const { S3Client, PutObjectCommand } = require("@aws-sdk/client-s3");
const { DynamoDBClient, PutItemCommand } = require("@aws-sdk/client-dynamodb");

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
    const { tenantId, name, description, price, available, role, imageUrl, imageBase64, imageFilename, imageContentType } = body;

    // Campos mínimos para crear
    if (!tenantId || !name || (price === undefined || price === null)) {
      return json(400, { message: "Missing fields: tenantId, name and price are required" }, event);
    }

    // Role: por seguridad, este endpoint es para admin. Requerir role === 'admin' si se provee.
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
