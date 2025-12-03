const { DynamoDBClient, UpdateItemCommand } = require("@aws-sdk/client-dynamodb");
const { EventBridgeClient, PutEventsCommand } = require("@aws-sdk/client-eventbridge");

const dynamo = new DynamoDBClient({});
const eb = new EventBridgeClient({});
const ORDERS_TABLE = process.env.ORDERS_TABLE;

exports.handler = async (event) => {
    console.log(`[Step 4] Finalizing order ${event.orderId}`);
    
    // Recibimos la decisión tomada por la Step Function (Choice State)
    const finalStatus = event.dispatchInfo?.status || "READY";
    const message = event.dispatchInfo?.msg || "Pedido listo";
    const targetEmail = event.customerEmail;

    // 1. Actualizar DB
    await dynamo.send(new UpdateItemCommand({
        TableName: ORDERS_TABLE,
        Key: { 
            PK: { S: `TENANT#${event.tenantId}` }, 
            SK: { S: `ORDER#${event.orderId}` } 
        },
        UpdateExpression: "SET #s = :s, finalMessage = :m, updatedAt = :now",
        ExpressionAttributeNames: { "#s": "status" },
        ExpressionAttributeValues: { 
            ":s": { S: finalStatus },
            ":m": { S: message },
            ":now": { S: new Date().toISOString() }
        }
    }));

    // 2. Notificar (EventBridge -> SNS -> Email)
    if (targetEmail) {
        await eb.send(new PutEventsCommand({
            Entries: [{
                Source: "bembos.kitchen",
                DetailType: "OrderReady",
                Detail: JSON.stringify({ 
                    orderId: event.orderId, 
                    status: finalStatus,
                    message: message,
                    customerEmail: targetEmail
                }),
                EventBusName: process.env.NOTIFICATION_BUS
            }]
        }));
    }

    return { ...event, step: "FINISHED", finalStatus };
};
