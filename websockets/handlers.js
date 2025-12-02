const { DynamoDBClient, PutItemCommand, DeleteItemCommand, QueryCommand } = require('@aws-sdk/client-dynamodb');
const { ApiGatewayManagementApiClient, PostToConnectionCommand } = require('@aws-sdk/client-apigatewaymanagementapi');

const dynamo = new DynamoDBClient({});
const TABLE = process.env.WEBSOCKET_TABLE;

// $connect
exports.connect = async (event) => {
  const connectionId = event.requestContext.connectionId;
  const tenantId = event.queryStringParameters?.tenantId || "DEFAULT";
  
  console.log([WS] New connection ${connectionId} for tenant ${tenantId});

  try {
      await dynamo.send(new PutItemCommand({
        TableName: TABLE,
        Item: {
          tenantId: { S: tenantId },
          connectionId: { S: connectionId }
        }
      }));
      return { statusCode: 200, body: 'Connected' };
  } catch (e) {
      console.error(e);
      return { statusCode: 500, body: 'Failed to connect' };
  }
};

// Broadcast function
exports.broadcast = async (event) => {
  // El evento viene de EventBridge
  const detail = event.detail;
  const type = event['detail-type'];
  const tenantId = detail.tenantId;

  if (!tenantId) return;

  // Obtener conexiones
  const connections = await dynamo.send(new QueryCommand({
    TableName: TABLE,
    KeyConditionExpression: "tenantId = :tid",
    ExpressionAttributeValues: { ":tid": { S: tenantId } }
  }));

  if (!connections.Items || connections.Items.length === 0) return;

  const endpoint = process.env.WEBSOCKET_API_ENDPOINT;
  // Truco para labs: a veces el stage se duplica o falta https
  // Asegúrate de que endpoint comience con https:// y no tenga doble stage
  const client = new ApiGatewayManagementApiClient({ endpoint });

  const message = JSON.stringify({ type, data: detail });

  const promises = connections.Items.map(async (conn) => {
    const connId = conn.connectionId.S;
    try {
      await client.send(new PostToConnectionCommand({
        ConnectionId: connId,
        Data: message
      }));
    } catch (e) {
      if (e.statusCode === 410) {
        console.log([WS] Stale connection ${connId}, removing.);
        await dynamo.send(new DeleteItemCommand({
            TableName: TABLE,
            Key: { tenantId: { S: tenantId }, connectionId: { S: connId } }
        }));
      } else {
          console.error([WS] Error sending to ${connId}, e);
      }
    }
  });

  await Promise.all(promises);
};
