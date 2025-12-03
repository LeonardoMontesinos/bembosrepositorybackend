const { PutItemCommand } = require("@aws-sdk/client-dynamodb");
const { PutObjectCommand } = require('@aws-sdk/client-s3');
const { EventBridgeClient, PutEventsCommand } = require("@aws-sdk/client-eventbridge");
const { dynamo, s3, TABLE_NAME, BUCKET_NAME } = require("./db"); // Asumo que estos exports existen en db.js
const { response, generateOrderId, logOrderEvent, getUserFromEvent } = require("./utils");

const eventBridge = new EventBridgeClient({});

exports.handler = async (event) => {
  try {
    const user = getUserFromEvent(event);
    const body = JSON.parse(event.body || "{}");
    const { items, type, total, kitchenId } = body; 

    // Validaciones básicas
    if (!items || !items.length) {
      return response(400, { message: "No items provided" });
    }

    const tenantId = user.tenantId || 'DEFAULT';
    const createdBy = user.userId || user.sub || 'anonymous';
    const orderId = generateOrderId();
    const now = new Date().toISOString();
    const assignedKitchenId = kitchenId || "kitchen_1"; 
    const orderType = type || "STORE";

    // 1. Guardar en DynamoDB
    const item = {
      PK: { S: `TENANT#${tenantId}` },
      SK: { S: `ORDER#${orderId}` },
      tenantId: { S: tenantId },
      orderId: { S: orderId },
      status: { S: "CREATED" },
      type: { S: orderType },
      items: { S: JSON.stringify(items) },
      total: { N: total ? String(total) : "0" },
      kitchenId: { S: assignedKitchenId },
      createdBy: { S: createdBy },
      createdAt: { S: now },
      updatedAt: { S: now }
    };

    await dynamo.send(new PutItemCommand({
      TableName: TABLE_NAME,
      Item: item
    }));

    // 2. Copia opcional en S3 (Tu lógica original)
    const s3Body = JSON.stringify({
      orderId, tenantId, createdAt: now, createdBy, status: "CREATED", type: orderType, total
    });
    
    // Envolvemos S3 en try-catch no bloqueante por si falla
    try {
        await s3.send(new PutObjectCommand({
            Bucket: BUCKET_NAME,
            Key: `${orderId}.json`,
            Body: s3Body,
            ContentType: "application/json",
        }));
    } catch (e) { console.warn("S3 Backup failed", e); }

    // 3. Log de auditoría
    await logOrderEvent({
      orderId, tenantId, userId: createdBy, eventType: "CREATE",
      payload: { status: "CREATED", type: orderType, total }
    });

    // ---------------------------------------------------------
    // 4. NUEVO: Emitir evento a IngestionBus (EventBridge)
    // ---------------------------------------------------------
    await eventBridge.send(new PutEventsCommand({
      Entries: [{
        Source: "bembos.orders",
        DetailType: "OrderCreated",
        Detail: JSON.stringify({
           orderId, 
           tenantId, 
           kitchenId: assignedKitchenId, 
           type: orderType, 
           items,
           customerEmail: user.email
        }),
        EventBusName: process.env.INGESTION_BUS
      }]
    }));

    return response(201, {
      message: "Order created and sent to kitchen workflow",
      orderId,
      status: "CREATED"
    });

  } catch (error) {
    console.error("CREATE ORDER ERROR:", error);
    return response(500, { message: "Internal Server Error", error: error.message });
  }
};