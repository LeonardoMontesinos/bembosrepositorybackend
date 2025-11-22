const { DynamoDBClient, QueryCommand } = require('@aws-sdk/client-dynamodb');
const { json } = require('../http');

const dynamo = new DynamoDBClient({});
const KITCHEN_TABLE = process.env.KITCHEN_TABLE || `KitchenTable-${process.env.SLS_STAGE || 'dev'}`;

exports.handler = async (event) => {
  try {
    const tenantId = (event.queryStringParameters && event.queryStringParameters.tenantId) || null;
    if (!tenantId) {
      return json(400, { message: 'tenantId query param required' }, event);
    }

    const result = await dynamo.send(new QueryCommand({
      TableName: KITCHEN_TABLE,
      KeyConditionExpression: 'tenantId = :t',
      ExpressionAttributeValues: { ':t': { S: tenantId } },
    }));

    const kitchens = (result.Items || []).map(it => ({
      kitchenId: it.kitchenId.S,
      name: it.name?.S,
      maxCooking: Number(it.maxCooking?.N || 0),
      currentCooking: Number(it.currentCooking?.N || 0),
      active: !!it.active?.BOOL,
    }));

    return json(200, { kitchens }, event);
  } catch (err) {
    console.error('LIST KITCHENS ERROR:', err);
    return json(500, { message: 'Server error', error: err.message }, event);
  }
};