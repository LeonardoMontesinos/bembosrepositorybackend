const { DynamoDBClient, UpdateItemCommand } = require("@aws-sdk/client-dynamodb");
const dynamo = new DynamoDBClient({});

exports.handler = async (event) => {
    console.log(`[Step 3] Cooking order ${event.orderId}...`);
    
    // Actualizar estado en DynamoDB a COOKING
    await dynamo.send(new UpdateItemCommand({
        TableName: process.env.ORDERS_TABLE,
        Key: { PK: { S: `TENANT#${event.tenantId}` }, SK: { S: `ORDER#${event.orderId}` } },
        UpdateExpression: "SET #s = :s",
        ExpressionAttributeNames: { "#s": "status" },
        ExpressionAttributeValues: { ":s": { S: "COOKING" } }
    }));

    // Simulación de tiempo (en producción SF usa .waitForTaskToken)
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    return { ...event, step: "COOKED" };
};