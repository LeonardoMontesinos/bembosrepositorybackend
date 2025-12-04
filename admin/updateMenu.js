const { DynamoDBClient, UpdateItemCommand } = require("@aws-sdk/client-dynamodb");
const dynamo = new DynamoDBClient({});
const MENU_TABLE = process.env.MENU_TABLE || "MenuTable";
const { json } = require("../http");
const { isValidUrl, uploadBase64ToS3 } = require("./menuHelpers");

exports.handler = async (event) => {
  try {
    const body = JSON.parse(event.body || "{}");
    const {
      dishId,
      name,
      description,
      price,
      available,
      offers,
      imageUrl,
      imageBase64,
      imageFilename,
      imageContentType
    } = body;

    // Obtener role y tenant desde authorizer
    let role = null;
    let tenantId = null;
    if (event?.requestContext?.authorizer) {
      const auth = event.requestContext.authorizer;
      const claims = auth.claims || auth;
      role = auth.role || claims.role || null;
      tenantId = auth.tenantId || claims.tenantId || null;
    }
    if (!role && body.role) role = body.role;
    if (!tenantId && body.tenantId) tenantId = body.tenantId;

    // Validar mínimos
    if (!tenantId || !dishId) {
      return json(400, { message: "Missing tenantId or dishId" }, event);
    }

    if (!role || String(role).toLowerCase() !== "admin") {
      return json(403, { message: "Forbidden: admin role required" }, event);
    }

    // Imagen
    let finalImageUrl = null;

    if (imageUrl) {
      if (!isValidUrl(imageUrl)) {
        return json(400, { message: "Invalid imageUrl" }, event);
      }
      finalImageUrl = imageUrl;
    } else if (imageBase64) {
      try {
        finalImageUrl = await uploadBase64ToS3(
          imageBase64,
          tenantId,
          imageFilename,
          imageContentType
        );
      } catch (err) {
        console.error("S3 upload error:", err);
        return json(500, { message: "Failed to upload image" }, event);
      }
    }

    const updateExprParts = ["updatedAt = :updatedAt"];
    const exprAttrValues = {
      ":updatedAt": { S: new Date().toISOString() }
    };
    const exprAttrNames = {};

    if (name !== undefined) {
      updateExprParts.push("#name = :name");
      exprAttrValues[":name"] = { S: String(name).trim() };
      exprAttrNames["#name"] = "name";
    }

    if (description !== undefined) {
      if (description === null) {
        updateExprParts.push("REMOVE description");
      } else {
        updateExprParts.push("description = :description");
        exprAttrValues[":description"] = { S: String(description) };
      }
    }

    if (price !== undefined) {
      const numericPrice = Number(price);
      if (Number.isNaN(numericPrice) || numericPrice < 0) {
        return json(400, { message: "Invalid price" }, event);
      }
      updateExprParts.push("price = :price");
      exprAttrValues[":price"] = { N: String(numericPrice) };
    }

    if (available !== undefined) {
      updateExprParts.push("available = :available");
      exprAttrValues[":available"] = { BOOL: !!available };
    }

    if (offers !== undefined) {
      updateExprParts.push("offers = :offers");
      exprAttrValues[":offers"] = { BOOL: !!offers };
    }

    if (finalImageUrl) {
      updateExprParts.push("imageUrl = :imageUrl");
      exprAttrValues[":imageUrl"] = { S: finalImageUrl };
    }

    const UpdateExpression = "SET " + updateExprParts.join(", ");

    await dynamo.send(
      new UpdateItemCommand({
        TableName: MENU_TABLE,
        Key: {
          tenantId: { S: tenantId },
          dishId: { S: dishId },
        },
        UpdateExpression,
        ExpressionAttributeValues: exprAttrValues,
        ExpressionAttributeNames:
          Object.keys(exprAttrNames).length ? exprAttrNames : undefined,
        ConditionExpression:
          "attribute_exists(tenantId) AND attribute_exists(dishId)",
        ReturnValues: "ALL_NEW",
      })
    );

    return json(
      200,
      {
        message: "Dish updated",
        dishId,
        imageUrl: finalImageUrl, // return only if updated
      },
      event
    );
  } catch (err) {
    console.error("UPDATE MENU ERROR:", err);
    return json(500, { message: "Server error", error: err.message }, event);
  }
};