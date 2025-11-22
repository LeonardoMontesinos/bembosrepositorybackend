const { v4: uuidv4 } = require('uuid');
const { DynamoDBClient, PutItemCommand } = require('@aws-sdk/client-dynamodb');
const { json } = require('../http');

const dynamo = new DynamoDBClient({});
const KITCHEN_TABLE = process.env.KITCHEN_TABLE || `KitchenTable-${process.env.SLS_STAGE || 'dev'}`;

exports.handler = async (event) => {
  try {
    const body = JSON.parse(event.body || '{}');
    const { tenantId, name, role, maxCooking } = body;

    if (!tenantId || !name) {
      return json(400, { message: 'Missing tenantId or name' }, event);
    }
    if (!role || String(role).toLowerCase() !== 'admin') {
      return json(403, { message: 'Forbidden: admin role required' }, event);
    }

    const kitchenId = `KITCHEN-${uuidv4()}`;
    const now = new Date().toISOString();
    const item = {
      tenantId: { S: tenantId },
      kitchenId: { S: kitchenId },
      name: { S: String(name).trim() },
      maxCooking: { N: String(maxCooking && maxCooking > 0 ? maxCooking : 5) },
      currentCooking: { N: '0' },
      active: { BOOL: true },
      createdAt: { S: now },
      updatedAt: { S: now },
    };

    await dynamo.send(new PutItemCommand({
      TableName: KITCHEN_TABLE,
      Item: item,
      ConditionExpression: 'attribute_not_exists(kitchenId)'
    }));

    return json(201, { message: 'Kitchen created', kitchenId }, event);
  } catch (err) {
    console.error('CREATE KITCHEN ERROR:', err);
    return json(500, { message: 'Server error', error: err.message }, event);
  }
};