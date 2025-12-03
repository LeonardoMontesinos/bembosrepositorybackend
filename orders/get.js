const { QueryCommand } = require("@aws-sdk/client-dynamodb");
const { dynamo, TABLE_NAME } = require("./db");
const { response } = require("./utils");

async function handleGet(event, user) {
  // Logs de depuración para entender quién llama
  console.log("HANDLE GET INVOKED");
  console.log("User Requesting:", JSON.stringify(user));
  
  const tenantId = user.tenantId || 'DEFAULT';
  const role = (user.role || 'USER').toUpperCase();
  const createdBy = user.sub || user.userId || 'anonymous'; // Aseguramos capturar el ID
  const path = event.path || '';
  const orderId = path.split('/')[2];

  console.log(`Searching Order: ${orderId} for Tenant: ${tenantId}`);

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
  const orderOwner = order.createdBy.S;

  console.log(`Order Owner: ${orderOwner} vs Requester: ${createdBy}`);

  // Lógica de seguridad:
  // Si NO es admin/owner Y el usuario no es el dueño del pedido -> Forbidden
  if (role !== 'OWNER' && role !== 'ADMIN' && orderOwner !== createdBy) {
    console.warn("ACCESS DENIED: User is not owner nor admin");
    return response(403, { 
        message: 'Forbidden: You are not the owner of this order',
        debug: { requester: createdBy, owner: orderOwner } // Esto te ayudará a ver el error en la respuesta
    });
  }

  return response(200, {
    orderId,
    status: order.status.S,
    items: JSON.parse(order.items.S),
    total: Number(order.total.N),
    createdAt: order.createdAt.S,
    updatedAt: order.updatedAt.S,
    createdBy: order.createdBy.S,
    type: order.type ? order.type.S : "STORE" // Devolvemos el tipo también
  });
}

module.exports = { handleGet };