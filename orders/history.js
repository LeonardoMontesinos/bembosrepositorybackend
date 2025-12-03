const { DynamoDBClient, QueryCommand } = require("@aws-sdk/client-dynamodb");
const { json } = require("../http");

const dynamo = new DynamoDBClient({});
const AUDIT_TABLE = process.env.AUDIT_TABLE;

exports.handler = async (event) => {
  try {
    const orderId = event.pathParameters.id;
    if (!orderId) return json(400, { message: "Missing orderId" }, event);

    // Consultar todos los cambios de ese pedido
    const result = await dynamo.send(new QueryCommand({
      TableName: AUDIT_TABLE,
      KeyConditionExpression: "PK = :pk",
      ExpressionAttributeValues: {
        ":pk": { S: `ORDER#${orderId}` }
      },
      ScanIndexForward: true // Cronológico (del más viejo al más nuevo)
    }));

    const history = (result.Items || []).map(item => ({
      from: item.oldStatus?.S,
      to: item.newStatus?.S,
      at: item.changedAt?.S,
      by: item.modifiedBy?.S
    }));

    return json(200, { orderId, history }, event);

  } catch (err) {
    console.error("GET HISTORY ERROR:", err);
    return json(500, { message: "Server error" }, event);
  }
};
