const { PutItemCommand } = require("@aws-sdk/client-dynamodb");
const { PutObjectCommand } = require("@aws-sdk/client-s3");
const { dynamo, s3, TABLE_NAME, BUCKET_NAME } = require("./db");
const { parseBody, generateOrderId, response, logOrderEvent } = require("./utils");

async function handleCreate(event, user) {
  try {
    const data = parseBody(event);

    const tenantId = user.tenantId || "DEFAULT";
    const orderId = generateOrderId();
    const now = new Date().toISOString();
    const createdBy = user.userId || "anonymous";

    // -------------------------------
    // 1. Validar tipo de pedido
    // -------------------------------

    const orderType = (data.type || "").toUpperCase();
    if (!["DELIVERY", "EN_TIENDA"].includes(orderType)) {
      return response(400, {
        message: "Invalid order type. Must be DELIVERY or EN_TIENDA",
      });
    }

    // -------------------------------
    // 2. Obtener y validar items
    // -------------------------------

    const items = Array.isArray(data.items) ? data.items : [];

    if (items.length === 0) {
      return response(400, { message: "items is required and must be non-empty" });
    }

    for (const it of items) {
      if (!it.productId) {
        return response(400, {
          message: "Each item must include productId",
        });
      }
    }
    
    for (const it of items) {
      if (typeof it.qty !== "number" || typeof it.price !== "number") {
        return response(400, {
          message: "Each item must include numeric qty and price",
        });
      }
    }

    // -------------------------------
    // 3. Calcular total automáticamente
    // -------------------------------

    const total = items.reduce(
      (sum, item) => sum + Number(item.qty) * Number(item.price),
      0
    );

    // -------------------------------
    // 4. Validar detalles adicionales
    // -------------------------------

    const deliveryDetails = data.deliveryDetails || {};

    // Datos comunes
    const commonDetails = {
      phone: deliveryDetails.phone || null,
      dni: deliveryDetails.dni || null,
      paymentMethod: deliveryDetails.paymentMethod || null,
      notes: deliveryDetails.notes || null,
    };

    // Validación para DELIVERY
    if (orderType === "DELIVERY") {
      if (!deliveryDetails.address) {
        return response(400, {
          message: "address is required when type is DELIVERY",
        });
      }
    }

    const fullDeliveryDetails = {
      ...commonDetails,
      address: orderType === "DELIVERY" ? deliveryDetails.address : null,
    };

    // -------------------------------
    // 5. Construir item DynamoDB
    // -------------------------------

    const item = {
      PK: { S: `TENANT#${tenantId}` },
      SK: { S: `ORDER#${orderId}` },
      createdAt: { S: now },
      updatedAt: { S: now },
      createdBy: { S: createdBy },
      status: { S: "CREATED" },
      type: { S: orderType },
      items: { S: JSON.stringify(items) },
      total: { N: total.toString() },
      deliveryDetails: { S: JSON.stringify(fullDeliveryDetails) },
    };

    // -------------------------------
    // 6. Insertar en DynamoDB
    // -------------------------------

    await dynamo.send(
      new PutItemCommand({
        TableName: TABLE_NAME,
        Item: item,
      })
    );

    // -------------------------------
    // 7. Copia opcional en S3
    // -------------------------------

    const s3Body = JSON.stringify({
      orderId,
      tenantId,
      createdAt: now,
      createdBy,
      status: "CREATED",
      type: orderType,
      total,
      deliveryDetails: fullDeliveryDetails,
    });

    await s3.send(
      new PutObjectCommand({
        Bucket: BUCKET_NAME,
        Key: `${orderId}.json`,
        Body: s3Body,
        ContentType: "application/json",
      })
    );

    // -------------------------------
    // 8. Log de auditoría
    // -------------------------------

    await logOrderEvent({
      orderId,
      tenantId,
      userId: createdBy,
      eventType: "CREATE",
      payload: {
        status: "CREATED",
        type: orderType,
        total,
      },
    });

    // -------------------------------
    // 9. Respuesta final
    // -------------------------------

    return response(201, {
      message: "Order created successfully",
      order: {
        orderId,
        tenantId,
        status: "CREATED",
        type: orderType,
        items,
        total,
        createdAt: now,
        updatedAt: now,
        createdBy,
        deliveryDetails: fullDeliveryDetails,
      },
    });
  } catch (err) {
    console.error("Error creating order", err);
    return response(500, { message: "Internal server error" });
  }
}

module.exports = { handleCreate };

