const { QueryCommand, UpdateItemCommand } = require("@aws-sdk/client-dynamodb");
const { DynamoDBClient, QueryCommand: KitchenQuery } = require("@aws-sdk/client-dynamodb");
const { dynamo, TABLE_NAME } = require("./db");
const { response, logOrderEvent } = require("./utils");
const userDynamo = new DynamoDBClient({});
const KITCHEN_TABLE = process.env.KITCHEN_TABLE || `KitchenTable-${process.env.SLS_STAGE || 'dev'}`;
const USER_TABLE = process.env.USER_TABLE || 'UserTable';

/**
 * Body: { status: 'CANCELLED' | 'COOKING' | 'SENDED' }
 * Rules:
 * - CANCELLED: allowed only if current status === 'CREATED' and requester is creator or OWNER
 * - COOKING: allowed only for OWNER and if current status === 'CREATED'
 * - SENDED: allowed only for OWNER and if current status === 'COOKING'
 */
async function handleUpdateStatus(event, user) {
  const tenantId = user.tenantId || 'DEFAULT';
  const role = (user.role || 'USER').toUpperCase();
  const createdBy = user.sub || 'anonymous';
  const path = event.path || '';
  const orderId = path.split('/')[2];

  const body = event.body ? JSON.parse(event.body) : {};
  const desired = (body.status || '').toString().toUpperCase();

  const allowedStatuses = ['CREATED', 'COOKING', 'SENDED', 'DELIVERED', 'CANCELLED'];
  if (!allowedStatuses.includes(desired)) {
    return response(400, { message: 'Invalid status' });
  }

  // Get current order
  const result = await dynamo.send(
    new QueryCommand({
      TableName: TABLE_NAME,
      KeyConditionExpression: 'PK = :pk AND SK = :sk',
      ExpressionAttributeValues: {
        ':pk': { S: `TENANT#${tenantId}` },
        ':sk': { S: `ORDER#${orderId}` },
      },
    })
  );

  if (!result.Items || result.Items.length === 0) {
    return response(404, { message: 'Order not found' });
  }

  const order = result.Items[0];
  const current = (order.status && order.status.S) || 'CREATED';

  // Authorization and transition rules
  if (desired === 'CANCELLED') {
    if (current !== 'CREATED') {
      return response(400, { message: 'Order cannot be cancelled at this stage' });
    }
    if (role !== 'OWNER' && order.createdBy.S !== createdBy) {
      return response(403, { message: 'Forbidden' });
    }
  } else if (desired === 'COOKING') {
    if (role !== 'OWNER') return response(403, { message: 'Only OWNER can set COOKING' });
    if (current !== 'CREATED') return response(400, { message: 'Can only set COOKING from CREATED' });
  } else if (desired === 'SENDED') {
    if (role !== 'OWNER') return response(403, { message: 'Only OWNER can set SENDED' });
    if (current !== 'COOKING') return response(400, { message: 'Can only set SENDED from COOKING' });
  } else if (desired === 'DELIVERED') {
    // Delivered can be set only when order was already SENDED. Allowed by OWNER or delivery role.
    if (current !== 'SENDED') return response(400, { message: 'Can only set DELIVERED from SENDED' });
    if (role !== 'OWNER' && role !== 'DELIVERY') return response(403, { message: 'Only OWNER or DELIVERY role can set DELIVERED' });
  }

  const now = new Date().toISOString();
  const updateValues = {
    ':s': { S: desired },
    ':t': { S: now },
  };
  let updateExpr = 'SET #s = :s, updatedAt = :t';
  const attrNames = { '#s': 'status' };

  let deliveryUserIdAssigned = null;
  if (desired === 'SENDED') {
    // Assign any delivery user from TenantRoleIndex GSI
    try {
      const deliveryRes = await userDynamo.send(new KitchenQuery({
        TableName: USER_TABLE,
        IndexName: 'TenantRoleIndex',
        KeyConditionExpression: 'tenantId = :tenant AND role = :role',
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
      console.warn('Delivery assignment failed:', e.message || e);
    }
  }

  await dynamo.send(new UpdateItemCommand({
    TableName: TABLE_NAME,
    Key: { PK: { S: `TENANT#${tenantId}` }, SK: { S: `ORDER#${orderId}` } },
    UpdateExpression: updateExpr,
    ExpressionAttributeNames: attrNames,
    ExpressionAttributeValues: updateValues,
  }));

  await logOrderEvent({ orderId, tenantId, userId: createdBy, eventType: 'STATUS_CHANGE', payload: { from: current, to: desired, deliveryUserId: deliveryUserIdAssigned } });

  // If freeing capacity (COOKING -> SENDED/CANCELLED/DELIVERED), attempt assign one CREATED order
  if (current === 'COOKING' && ['SENDED', 'CANCELLED', 'DELIVERED'].includes(desired)) {
    try {
      // List kitchens
      const kitchensRes = await userDynamo.send(new KitchenQuery({
        TableName: KITCHEN_TABLE,
        KeyConditionExpression: 'tenantId = :t',
        ExpressionAttributeValues: { ':t': { S: tenantId } },
      }));
      const kitchens = (kitchensRes.Items || []).map(k => ({
        kitchenId: k.kitchenId.S,
        maxCooking: Number(k.maxCooking?.N || 5),
      }));
      if (kitchens.length) {
        const allOrders = await dynamo.send(new QueryCommand({
          TableName: TABLE_NAME,
          KeyConditionExpression: 'PK = :pk',
          ExpressionAttributeValues: { ':pk': { S: `TENANT#${tenantId}` } },
        }));
        const cookingCounts = {};
        const createdOrders = [];
        for (const o of (allOrders.Items || [])) {
          const status = o.status?.S;
          const kId = o.kitchenId?.S;
          if (status === 'COOKING' && kId) cookingCounts[kId] = (cookingCounts[kId] || 0) + 1;
          if (status === 'CREATED') createdOrders.push(o);
        }
        if (createdOrders.length) {
          let targetKitchen = null;
            for (const k of kitchens) {
              const currentCount = cookingCounts[k.kitchenId] || 0;
              if (currentCount < k.maxCooking) { targetKitchen = k.kitchenId; break; }
            }
          if (targetKitchen) {
            const orderToAssign = createdOrders[0];
            const assignOrderId = orderToAssign.SK.S.replace('ORDER#', '');
            await dynamo.send(new UpdateItemCommand({
              TableName: TABLE_NAME,
              Key: { PK: { S: `TENANT#${tenantId}` }, SK: { S: `ORDER#${assignOrderId}` } },
              UpdateExpression: 'SET #s = :cooking, kitchenId = :kId, updatedAt = :u',
              ExpressionAttributeNames: { '#s': 'status' },
              ExpressionAttributeValues: {
                ':cooking': { S: 'COOKING' },
                ':kId': { S: targetKitchen },
                ':u': { S: new Date().toISOString() },
              },
            }));
            await logOrderEvent({ orderId: assignOrderId, tenantId, userId: 'system', eventType: 'AUTO_ASSIGN', payload: { kitchenId: targetKitchen } });
          }
        }
      }
    } catch (e) {
      console.warn('Auto reassignment failed:', e.message || e);
    }
  }

  return response(200, { message: `Order ${orderId} status updated to ${desired}`, deliveryUserId: deliveryUserIdAssigned });
}

module.exports = { handleUpdateStatus };
