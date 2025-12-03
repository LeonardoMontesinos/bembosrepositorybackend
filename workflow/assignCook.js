const { DynamoDBClient, QueryCommand, UpdateItemCommand } = require("@aws-sdk/client-dynamodb");
const dynamo = new DynamoDBClient({});

const ORDERS_TABLE = process.env.ORDERS_TABLE;
const USER_TABLE = process.env.USER_TABLE;

exports.handler = async (event) => {
    console.log(`[Step 2] Assigning cook for ${event.orderId}`);

    let assignedCook = "Chef Bot"; // Default por si no hay usuarios cocina

    try {
        // 1. Buscar usuarios con rol 'kitchen' en el Tenant
        const result = await dynamo.send(new QueryCommand({
            TableName: USER_TABLE,
            IndexName: "TenantRoleIndex",
            KeyConditionExpression: "tenantId = :t AND #r = :r",
            ExpressionAttributeNames: { "#r": "role" },
            ExpressionAttributeValues: {
                ":t": { S: event.tenantId },
                ":r": { S: "kitchen" }
            }
        }));

        if (result.Items && result.Items.length > 0) {
            // Asignar uno al azar (Round Robin simplificado)
            const randomCook = result.Items[Math.floor(Math.random() * result.Items.length)];
            assignedCook = randomCook.username?.S || randomCook.email?.S;
        }

        // 2. Guardar la asignación en la Orden
        await dynamo.send(new UpdateItemCommand({
            TableName: ORDERS_TABLE,
            Key: { 
                PK: { S: `TENANT#${event.tenantId}` }, 
                SK: { S: `ORDER#${event.orderId}` } 
            },
            UpdateExpression: "SET chefAssigned = :c, updatedAt = :now",
            ExpressionAttributeValues: { 
                ":c": { S: assignedCook },
                ":now": { S: new Date().toISOString() }
            }
        }));

    } catch (e) {
        console.error("Error assigning cook:", e);
        // No fallamos el flujo, solo logueamos
    }

    return { ...event, assignedCook, step: "ASSIGNED" };
};
