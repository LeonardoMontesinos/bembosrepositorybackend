// orders/create.js
const { v4: uuidv4 } = require('uuid');
const { DynamoDBClient, PutItemCommand } = require('@aws-sdk/client-dynamodb');
const { PutObjectCommand, S3Client } = require('@aws-sdk/client-s3');
const { response, parseBody, logOrderEvent } = require('../utils'); // Asegurate que la ruta sea correcta
const { publishEvent } = require('../utils/events');

const dynamo = new DynamoDBClient({});
const s3 = new S3Client({});
const TABLE_NAME = process.env.ORDERS_TABLE;
const BUCKET_NAME = process.env.ORDERS_BUCKET;

async function handleCreate(event, user) {
  const data = parseBody(event);
  const tenantId = user.tenantId || "DEFAULT";
  const orderId = ORD-${uuidv4()};
  const now = new Date().toISOString();
  const createdBy = user.sub || 'anonymous';

  const items = Array.isArray(data.items) ? data.items : [];
  const total = items.reduce((acc, item) => acc + (Number(item.price)||0) * (Number(item.quantity)||1), 0);
  const orderType = (data.orderType || 'TIENDA').toUpperCase();
  const kitchenId = data.kitchenId || null;

  // Estado inicial PENDING (esperando asignación de cocina)
  const initialStatus = 'PENDING';

  const item = {
    PK: { S: TENANT#${tenantId} },
    SK: { S: ORDER#${orderId} },
    createdAt: { S: now },
    updatedAt: { S: now },
    createdBy: { S: createdBy },
    status: { S: initialStatus },
    orderType: { S: orderType },
    items: { S: JSON.stringify(items) },
    total: { N: total.toString() },
    kitchenId: kitchenId ? { S: kitchenId } : { NULL: true },
    details: { S: JSON.stringify(data.details || {}) }
  };

  // 1. Guardar en Dynamo
  await dynamo.send(new PutItemCommand({ TableName: TABLE_NAME, Item: item }));

  // 2. Guardar Backup en S3 (Opcional, lo tenías en tu código)
  await s3.send(new PutObjectCommand({
      Bucket: BUCKET_NAME,
      Key: ${orderId}.json,
      Body: JSON.stringify({ orderId, tenantId, ...data, status: initialStatus }),
      ContentType: 'application/json',
  }));

  // 3. Log (Tu función existente)
  await logOrderEvent({ orderId, tenantId, userId: createdBy, eventType: 'CREATE', payload: { status: initialStatus } });

  // 4. * EVENTO CLAVE * Publicar OrderCreated
  await publishEvent('bemmbos.orders', 'OrderCreated', {
    tenantId,
    orderId,
    kitchenId,
    items,
    status: initialStatus,
    timestamp: now
  });

  return response(201, {
    message: 'Order received',
    orderId,
    status: initialStatus,
    kitchenId
  });
}

module.exports = { handleCreate };
