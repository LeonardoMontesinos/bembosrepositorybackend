const { DynamoDBClient, QueryCommand, UpdateItemCommand } = require("@aws-sdk/client-dynamodb");
const { dynamo, TABLE_NAME } = require("./db"); // Asumo que ./db exporta el cliente configurado
const { response, logOrderEvent } = require("./utils");
const { publishEvent } = require("../utils/events"); // <--- NUEVO: Helper de eventos

const userDynamo = new DynamoDBClient({});
const USER_TABLE = process.env.USER_TABLE || 'UserTable';

/**
 * Body: { status: 'CANCELLED' | 'COOKING' | 'SENDED' | 'DELIVERED' }
 * 
 * Flujo nuevo con Eventos:
 * 1. Valida permisos y transiciones.
 * 2. Actualiza DynamoDB.
 * 3. Si el pedido sale de cocina -> Publica 'KitchenSpaceAvailable' (Reactiva la cola SQS).
 * 4. Publica 'OrderStatusUpdated' (Actualiza WebSockets).
 */
async function handleUpdateStatus(event, user) {
  const tenantId = user.tenantId || 'DEFAULT';
  const role = (user.role || 'USER').toUpperCase();
  const createdBy = user.sub || 'anonymous';
  
  // Obtener ID del path parameters
  const path = event.path || '';
  // Ajuste: Dependiendo de si usas serverless-offline o AWS real, el path parameter suele venir en event.pathParameters
  const orderId = event.pathParameters ? event.pathParameters.id : path.split('/')[2];

  const body = event.body ? JSON.parse(event.body) : {};
  const desired = (body.status || '').toString().toUpperCase();

  // Estados permitidos
  // Nota: 'PREPARING' es sinónimo de 'COOKING' en el nuevo flujo, aceptamos ambos por compatibilidad
  const allowedStatuses = ['CREATED', 'PREPARING', 'COOKING', 'SENDED', 'DELIVERED', 'CANCELLED', 'QUEUED'];
  
  if (!allowedStatuses.includes(desired)) {
    return response(400, { message: Invalid status. Allowed: ${allowedStatuses.join(', ')} });
  }

  // 1. Obtener el pedido actual
  const result = await dynamo.send(
    new QueryCommand({
      TableName: TABLE_NAME,
      KeyConditionExpression: 'PK = :pk AND SK = :sk',
      ExpressionAttributeValues: {
        ':pk': { S: TENANT#${tenantId} },
        ':sk': { S: ORDER#${orderId} },
      },
    })
  );

  if (!result.Items || result.Items.length === 0) {
    return response(404, { message: 'Order not found' });
  }

  const order = result.Items[0];
  const current = (order.status && order.status.S) || 'CREATED';
  const currentKitchenId = order.kitchenId ? order.kitchenId.S : null;

  // 2. Reglas de Transición y Autorización
  if (desired === 'CANCELLED') {
    // Solo se puede cancelar si no ha sido enviado aún
    if (['SENDED', 'DELIVERED'].includes(current)) {
      return response(400, { message: 'Cannot cancel an order that has already been sent' });
    }
    if (role !== 'OWNER' && role !== 'ADMIN' && order.createdBy.S !== createdBy) {
      return response(403, { message: 'Forbidden' });
    }
  } 
  else if (desired === 'COOKING' || desired === 'PREPARING') {
    // Asignación manual o inicio de cocina
    if (role !== 'OWNER' && role !== 'ADMIN' && role !== 'KITCHEN') return response(403, { message: 'Forbidden' });
  } 
  else if (desired === 'SENDED' || desired === 'READY') {
    // Plato listo para salir
    if (role !== 'OWNER' && role !== 'ADMIN' && role !== 'KITCHEN') return response(403, { message: 'Forbidden' });
  } 
  else if (desired === 'DELIVERED') {
    if (current !== 'SENDED') return response(400, { message: 'Can only set DELIVERED from SENDED' });
    if (role !== 'OWNER' && role !== 'ADMIN' && role !== 'DELIVERY') return response(403, { message: 'Only delivery/admin can set DELIVERED' });
  }

  // 3. Preparar Update en DynamoDB
  const now = new Date().toISOString();
  const updateValues = {
    ':s': { S: desired },
    ':t': { S: now },
  };
  let updateExpr = 'SET #s = :s, updatedAt = :t';
  const attrNames = { '#s': 'status' };

  // Lógica de Asignación de Repartidor (Si pasa a SENDED)
  let deliveryUserIdAssigned = null;
  if (desired === 'SENDED' && current !== 'SENDED') {
    try {
      // Buscar un usuario con rol 'delivery' en este tenant
      const deliveryRes = await userDynamo.send(new QueryCommand({
        TableName: USER_TABLE,
        IndexName: 'TenantRoleIndex',
        KeyConditionExpression: 'tenantId = :tenant AND #r = :role',
        ExpressionAttributeNames: { '#r': 'role' }, // 'role' es palabra reservada a veces
        ExpressionAttributeValues: {
          ':tenant': { S: tenantId },
          ':role': { S: 'delivery' },
        },
        Limit: 1,
      }));
      
      if (deliveryRes.Items && deliveryRes.Items.length > 0) {
        deliveryUserIdAssigned = deliveryRes.Items[0].userId.S;
        updateExpr += ', deliveryUserId = :dId';
        updateValues[':dId'] = { S: deliveryUserIdAssigned };
      }
    } catch (e) {
      console.warn('Delivery assignment warning:', e.message);
    }
  }

  // Ejecutar Update
  await dynamo.send(new UpdateItemCommand({
    TableName: TABLE_NAME,
    Key: { PK: { S: TENANT#${tenantId} }, SK: { S: ORDER#${orderId} } },
    UpdateExpression: updateExpr,
    ExpressionAttributeNames: attrNames,
    ExpressionAttributeValues: updateValues,
  }));

  // Log de auditoría en S3
  await logOrderEvent({ 
    orderId, 
    tenantId, 
    userId: createdBy, 
    eventType: 'STATUS_CHANGE', 
    payload: { from: current, to: desired, deliveryUserId: deliveryUserIdAssigned } 
  });

  // --- 🚀 NUEVA LÓGICA EVENT-DRIVEN ---

  // A. Detectar liberación de cocina
  // Si estaba cocinando (COOKING/PREPARING) y pasa a un estado final o de salida (SENDED/CANCELLED/READY)
  const cookingStatuses = ['COOKING', 'PREPARING'];
  const exitStatuses = ['SENDED', 'DELIVERED', 'CANCELLED', 'READY'];

  if (cookingStatuses.includes(current) && exitStatuses.includes(desired)) {
    if (currentKitchenId) {
      console.log([UpdateStatus] Order ${orderId} left kitchen ${currentKitchenId}. Emitting space available.);
      
      // Publicar evento para que SQS procese el siguiente pedido
      await publishEvent('bemmbos.kitchen', 'KitchenSpaceAvailable', {
        tenantId,
        kitchenId: currentKitchenId,
        freedByOrderId: orderId,
        timestamp: now
      });
    }
  }

  // B. Notificar a WebSockets (Dashboard)
  // Esto actualiza las pantallas de cocina/admin en tiempo real
  await publishEvent('bemmbos.orders', 'OrderStatusUpdated', {
    tenantId,
    orderId,
    oldStatus: current,
    newStatus: desired,
    kitchenId: currentKitchenId,
    updatedAt: now,
    deliveryUserId: deliveryUserIdAssigned
  });

  return response(200, { 
    message: Order ${orderId} status updated to ${desired}, 
    deliveryUserId: deliveryUserIdAssigned 
  });
}

module.exports = { handleUpdateStatus };
