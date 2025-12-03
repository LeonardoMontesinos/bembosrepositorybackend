const { DynamoDBClient, ScanCommand, QueryCommand } = require('@aws-sdk/client-dynamodb');
const { json } = require('../http');

const dynamo = new DynamoDBClient({});
const KITCHEN_TABLE = process.env.KITCHEN_TABLE || `KitchenTable-${process.env.SLS_STAGE || 'dev'}`;

exports.handler = async (event) => {
  try {
    const qs = event.queryStringParameters || {};
    const tenantId = qs.tenantId;

    let command;

    // Si envían tenantId, hacemos Query (más eficiente)
    if (tenantId) {
      command = new QueryCommand({
        TableName: KITCHEN_TABLE,
        KeyConditionExpression: 'tenantId = :t',
        ExpressionAttributeValues: { ':t': { S: tenantId } }
      });
    } else {
      // Si no, hacemos Scan (trae todo, útil para admins o debug)
      command = new ScanCommand({
        TableName: KITCHEN_TABLE
      });
    }

    const result = await dynamo.send(command);

    const kitchens = (result.Items || []).map(k => ({
      tenantId: k.tenantId?.S,
      kitchenId: k.kitchenId?.S,
      name: k.name?.S,
      maxCooking: Number(k.maxCooking?.N || 0),
      currentCooking: Number(k.currentCooking?.N || 0),
      active: k.active?.BOOL || false,
      createdAt: k.createdAt?.S
    }));

    return json(200, { kitchens }, event);
  } catch (err) {
    console.error('LIST KITCHENS ERROR:', err);
    return json(500, { message: 'Server error', error: err.message }, event);
  }
};
