const { DynamoDBClient, UpdateItemCommand } = require("@aws-sdk/client-dynamodb");
const dynamo = new DynamoDBClient({});
const TABLE_NAME = process.env.ORDERS_TABLE;

exports.handler = async (event) => {
    console.log(`[Step 1] Preparing order ${event.orderId}`);
    
    // Actualizamos el estado en la BD
    await dynamo.send(new UpdateItemCommand({
        TableName: TABLE_NAME,
        Key: { 
            PK: { S: `TENANT#${event.tenantId}` }, 
            SK: { S: `ORDER#${event.orderId}` } 
        },
        UpdateExpression: "SET #s = :s, updatedAt = :now",
        ExpressionAttributeNames: { "#s": "status" },
        ExpressionAttributeValues: { 
            ":s": { S: "PREPARING" },
            ":now": { S: new Date().toISOString() }
        }
    }));

    // Pasamos el evento al siguiente paso
    return { ...event, step: "PREPARED" };
};
