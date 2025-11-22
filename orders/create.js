const { PutItemCommand, QueryCommand, UpdateItemCommand } = require("@aws-sdk/client-dynamodb");
const { PutObjectCommand } = require("@aws-sdk/client-s3");
const { dynamo, s3, TABLE_NAME, BUCKET_NAME } = require("./db");
const { parseBody, generateOrderId, response, logOrderEvent } = require("./utils");

const { DynamoDBClient, QueryCommand: KitchenQuery } = require("@aws-sdk/client-dynamodb");
const kitchenDynamo = new DynamoDBClient({});
const KITCHEN_TABLE = process.env.KITCHEN_TABLE || `KitchenTable-${process.env.SLS_STAGE || 'dev'}`;

async function selectKitchen(tenantId) {
  // List all kitchens for tenant
  const res = await kitchenDynamo.send(new KitchenQuery({
    TableName: KITCHEN_TABLE,
    KeyConditionExpression: 'tenantId = :t',
    ExpressionAttributeValues: { ':t': { S: tenantId } },
  }));
  const kitchens = (res.Items || []).map(k => ({
    kitchenId: k.kitchenId.S,
    maxCooking: Number(k.maxCooking?.N || 5),
  }));
  if (kitchens.length === 0) return null;

  // Count cooking orders per kitchen
  const ordersRes = await dynamo.send(new QueryCommand({
    TableName: TABLE_NAME,
    KeyConditionExpression: 'PK = :pk',
    ExpressionAttributeValues: { ':pk': { S: `TENANT#${tenantId}` } },
  }));
  const cookingCounts = {};
  for (const o of (ordersRes.Items || [])) {
    const status = o.status?.S;
    const kId = o.kitchenId?.S;
    if (status === 'COOKING' && kId) {
      cookingCounts[kId] = (cookingCounts[kId] || 0) + 1;
    }
  }

  // Pick first kitchen with capacity
  for (const k of kitchens) {
    const current = cookingCounts[k.kitchenId] || 0;
    if (current < k.maxCooking) return k.kitchenId;
  }
  return null;
}

async function handleCreate(event, user) {
  const data = parseBody(event);
  const tenantId = user.tenantId || "DEFAULT";
  const orderId = generateOrderId();
  const items = Array.isArray(data.items) ? data.items : [];
  const total = typeof data.total === 'number' ? data.total : Number(data.total) || 0;
  const now = new Date().toISOString();
  const createdBy = user.sub || 'anonymous';

  const item = {
    PK: { S: `TENANT#${tenantId}` },
    SK: { S: `ORDER#${orderId}` },
    createdAt: { S: now },
    updatedAt: { S: now },
    createdBy: { S: createdBy },
    status: { S: 'CREATED' },
    items: { S: JSON.stringify(items) },
    total: { N: total.toString() },
  };

  await dynamo.send(
    new PutItemCommand({
      TableName: TABLE_NAME,
      Item: item,
    })
  );

  // Attempt kitchen assignment immediately
  const kitchenId = await selectKitchen(tenantId);
  if (kitchenId) {
    await dynamo.send(new UpdateItemCommand({
      TableName: TABLE_NAME,
      Key: { PK: { S: `TENANT#${tenantId}` }, SK: { S: `ORDER#${orderId}` } },
      UpdateExpression: 'SET #s = :cooking, kitchenId = :kId, updatedAt = :u',
      ExpressionAttributeNames: { '#s': 'status' },
      ExpressionAttributeValues: {
        ':cooking': { S: 'COOKING' },
        ':kId': { S: kitchenId },
        ':u': { S: new Date().toISOString() },
      },
    }));
    item.status = { S: 'COOKING' };
    item.kitchenId = { S: kitchenId };
  }

  // Persistir copia en S3 (opcional, asíncrono)
  const s3Body = JSON.stringify({ orderId, tenantId, createdAt: now, createdBy, status: item.status.S, kitchenId: item.kitchenId?.S || null });
  await s3.send(
    new PutObjectCommand({
      Bucket: BUCKET_NAME,
      Key: `${orderId}.json`,
      Body: s3Body,
      ContentType: 'application/json',
    })
  );

  // Log event
  await logOrderEvent({ orderId, tenantId, userId: createdBy, eventType: 'CREATE', payload: { status: item.status.S, kitchenId: item.kitchenId?.S || null } });

  return response(201, {
    message: 'Order created successfully',
    order: {
      orderId,
      tenantId,
    status: item.status.S,
    kitchenId: item.kitchenId?.S || null,
      items,
      total,
      createdAt: now,
      updatedAt: now,
      createdBy,
    },
  });
}

module.exports = { handleCreate };
