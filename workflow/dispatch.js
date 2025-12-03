const { DynamoDBClient, UpdateItemCommand } = require("@aws-sdk/client-dynamodb");
const { EventBridgeClient, PutEventsCommand } = require("@aws-sdk/client-eventbridge");
const dynamo = new DynamoDBClient({});
const eb = new EventBridgeClient({});

exports.handler = async (event) => {
    console.log(`[Step 4] Dispatching order ${event.orderId}`);
    
    // AHORA: Leemos el estado que decidió la Step Function (Branching)
    // Si por alguna razón no viene, usamos fallback
    const finalStatus = event.dispatchInfo?.status || "READY";
    const customMsg = event.dispatchInfo?.msg || "Tu pedido está listo";

    // 1. Actualizar estado final en DynamoDB
    await dynamo.send(new UpdateItemCommand({
        TableName: process.env.ORDERS_TABLE,
        Key: { PK: { S: `TENANT#${event.tenantId}` }, SK: { S: `ORDER#${event.orderId}` } },
        UpdateExpression: "SET #s = :s, updatedAt = :now",
        ExpressionAttributeNames: { "#s": "status" },
        ExpressionAttributeValues: { 
            ":s": { S: finalStatus },
            ":now": { S: new Date().toISOString() }
        }
    }));

    // 2. Emitir evento al Notification Bus (Para que llegue el correo)
    await eb.send(new PutEventsCommand({
        Entries: [{
            Source: "bembos.kitchen",
            DetailType: "OrderReady",
            Detail: JSON.stringify({ 
                orderId: event.orderId, 
                status: finalStatus,
                message: finalMsg,
                // Pasamos el email para que el SNS sepa a quién filtrar
                customerEmail: targetEmail 
            }),
            EventBusName: process.env.NOTIFICATION_BUS
        }]
    }));

    return { ...event, step: "DISPATCHED", finalStatus };
};