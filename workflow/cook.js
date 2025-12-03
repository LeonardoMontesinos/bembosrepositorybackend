const { DynamoDBClient, UpdateItemCommand } = require("@aws-sdk/client-dynamodb");
const dynamo = new DynamoDBClient({});
const TABLE_NAME = process.env.ORDERS_TABLE;

exports.handler = async (event) => {
    console.log(`[Step 3] Order ${event.orderId} starts cooking...`);
    
    await dynamo.send(new UpdateItemCommand({
        TableName: TABLE_NAME,
        Key: { 
            PK: { S: `TENANT#${event.tenantId}` }, 
            SK: { S: `ORDER#${event.orderId}` } 
        },
        UpdateExpression: "SET #s = :s, updatedAt = :now",
        ExpressionAttributeNames: { "#s": "status" },
        ExpressionAttributeValues: { 
            ":s": { S: "COOKING" },
            ":now": { S: new Date().toISOString() }
        }
    }));

    // Retornamos inmediato. La Step Function se encargará de esperar los 60 segundos.
    return { ...event, step: "COOKING_STARTED" };
};
