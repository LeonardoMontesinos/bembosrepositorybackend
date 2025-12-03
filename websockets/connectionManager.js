const { DynamoDBClient, PutItemCommand, DeleteItemCommand } = require("@aws-sdk/client-dynamodb");
const dynamo = new DynamoDBClient({});
const CONNECTIONS_TABLE = process.env.CONNECTIONS_TABLE;

exports.handler = async (event) => {
  const routeKey = event.requestContext.routeKey;
  const connectionId = event.requestContext.connectionId;

  if (routeKey === "$connect") {
    // En WebSockets, el authorizer pasa el contexto un poco diferente, 
    // o podemos pasar el userId por query param: wss://...?userId=123
    // Asumiremos que el authorizer ya validó y nos pasó el principalId
    const userId = event.requestContext.authorizer?.principalId || "anonymous";
    const tenantId = event.requestContext.authorizer?.tenantId || "DEFAULT";

    console.log(`WS Connected: ${connectionId} User: ${userId}`);

    await dynamo.send(new PutItemCommand({
      TableName: CONNECTIONS_TABLE,
      Item: {
        connectionId: { S: connectionId },
        userId: { S: userId },
        tenantId: { S: tenantId },
        connectedAt: { S: new Date().toISOString() },
        // TTL para limpiar conexiones muertas (opcional, configuralo en la tabla)
        ttl: { N: String(Math.floor(Date.now() / 1000) + 7200) } // 2 horas
      }
    }));
  } 
  else if (routeKey === "$disconnect") {
    console.log(`WS Disconnected: ${connectionId}`);
    await dynamo.send(new DeleteItemCommand({
      TableName: CONNECTIONS_TABLE,
      Key: { connectionId: { S: connectionId } }
    }));
  }

  return { statusCode: 200, body: "OK" };
};
