const { DynamoDBClient, QueryCommand, DeleteItemCommand } = require("@aws-sdk/client-dynamodb");
const { ApiGatewayManagementApiClient, PostToConnectionCommand } = require("@aws-sdk/client-apigatewaymanagementapi");
const { unmarshall } = require("@aws-sdk/util-dynamodb");

const dynamo = new DynamoDBClient({});
const CONNECTIONS_TABLE = process.env.CONNECTIONS_TABLE;

// Nota: El endpoint se inyectará en las variables de entorno al desplegar
const callbackUrl = process.env.WEBSOCKET_API_ENDPOINT; 
const apiGw = new ApiGatewayManagementApiClient({ endpoint: callbackUrl });

exports.handler = async (event) => {
  for (const record of event.Records) {
    if (record.eventName === "REMOVE") continue;

    // 1. Detectar cambio de estado
    const newImage = unmarshall(record.dynamodb.NewImage);
    const oldImage = record.dynamodb.OldImage ? unmarshall(record.dynamodb.OldImage) : {};

    if (newImage.status === oldImage.status) continue;

    const userId = newImage.createdBy; // El dueño del pedido
    const orderId = newImage.SK.replace("ORDER#", "");
    const newStatus = newImage.status;

    console.log(`BROADCAST: Notify user ${userId} about order ${orderId} -> ${newStatus}`);

    // 2. Buscar si el usuario tiene conexiones abiertas
    const connections = await dynamo.send(new QueryCommand({
      TableName: CONNECTIONS_TABLE,
      IndexName: "UserIndex",
      KeyConditionExpression: "userId = :uid",
      ExpressionAttributeValues: { ":uid": { S: userId } }
    }));

    if (!connections.Items || connections.Items.length === 0) {
      console.log("User not connected, skipping WS.");
      continue;
    }

    // 3. Enviar mensaje a todas las conexiones del usuario (PC, Móvil, Tablet)
    const message = JSON.stringify({
      type: "ORDER_UPDATE",
      orderId,
      status: newStatus,
      timestamp: new Date().toISOString()
    });

    const sendPromises = connections.Items.map(async (conn) => {
      const connId = conn.connectionId.S;
      try {
        await apiGw.send(new PostToConnectionCommand({
          ConnectionId: connId,
          Data: message
        }));
      } catch (err) {
        if (err.statusCode === 410) {
          // Found stale connection, delete it
          console.log(`Deleting stale connection: ${connId}`);
          await dynamo.send(new DeleteItemCommand({
            TableName: CONNECTIONS_TABLE,
            Key: { connectionId: { S: connId } }
          }));
        } else {
          console.error("WS Send Error:", err);
        }
      }
    });

    await Promise.all(sendPromises);
  }
};
