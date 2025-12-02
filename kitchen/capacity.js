const { DynamoDBClient, UpdateItemCommand } = require('@aws-sdk/client-dynamodb');
const { SQSClient, SendMessageCommand, ReceiveMessageCommand, DeleteMessageCommand } = require('@aws-sdk/client-sqs');
const { publishEvent } = require('../utils/events');

const dynamo = new DynamoDBClient({});
const sqs = new SQSClient({});

const KITCHEN_TABLE = process.env.KITCHEN_TABLE;
const ORDERS_TABLE = process.env.ORDERS_TABLE;
const QUEUE_URL = process.env.WAITING_QUEUE_URL;

// Actualiza el estado en DynamoDB
async function updateOrderStatus(tenantId, orderId, status, kitchenId = null) {
    const updateParams = {
        TableName: ORDERS_TABLE,
        Key: { PK: { S: TENANT#${tenantId} }, SK: { S: ORDER#${orderId} } },
        UpdateExpression: "SET #s = :s, updatedAt = :now",
        ExpressionAttributeNames: { "#s": "status" },
        ExpressionAttributeValues: { ":s": { S: status }, ":now": { S: new Date().toISOString() } }
    };
    
    // Si asignamos cocina, actualizar ese campo tambien
    if (kitchenId) {
        updateParams.UpdateExpression += ", kitchenId = :k";
        updateParams.ExpressionAttributeValues[":k"] = { S: kitchenId };
    }

    await dynamo.send(new UpdateItemCommand(updateParams));
}

// 1. Check Capacity (OrderCreated -> Allocator)
exports.check = async (event) => {
  const detail = event.detail; // Payload de EventBridge
  const { tenantId, orderId } = detail;
  const kitchenId = detail.kitchenId; // Puede venir null si el cliente no eligió

  if (!kitchenId) {
    console.log("No kitchenId specified. Skipping strict capacity check (or implement logic to find best kitchen).");
    return;
  }

  try {
    // Intenta reservar espacio atómicamente
    await dynamo.send(new UpdateItemCommand({
      TableName: KITCHEN_TABLE,
      Key: { tenantId: { S: tenantId }, kitchenId: { S: kitchenId } },
      UpdateExpression: "SET currentCooking = currentCooking + :inc",
      ConditionExpression: "currentCooking < maxCooking",
      ExpressionAttributeValues: { ":inc": { N: "1" } }
    }));

    // ÉXITO: Hay espacio
    console.log([Capacity] Kitchen ${kitchenId} accepted order ${orderId});
    await updateOrderStatus(tenantId, orderId, 'PREPARING');
    
    // Notificar que empezó a cocinarse
    await publishEvent('bemmbos.kitchen', 'OrderAllocated', { ...detail, status: 'PREPARING' });

  } catch (err) {
    if (err.name === 'ConditionalCheckFailedException') {
      // LLENO: Encolar
      console.log([Capacity] Kitchen ${kitchenId} FULL. Queuing order ${orderId});
      
      await sqs.send(new SendMessageCommand({
        QueueUrl: QUEUE_URL,
        MessageBody: JSON.stringify(detail),
        MessageGroupId: kitchenId // util si la cola es FIFO, sino se ignora
      }));

      await updateOrderStatus(tenantId, orderId, 'QUEUED');
      await publishEvent('bemmbos.kitchen', 'OrderQueued', { ...detail, status: 'QUEUED' });
    } else {
      console.error("Dynamo Error:", err);
      throw err;
    }
  }
};

// 2. Process Queue (KitchenSpaceAvailable -> QueueWorker)
exports.processQueue = async (event) => {
  const { tenantId, kitchenId } = event.detail;
  console.log([Queue] Space available in ${kitchenId}. Checking SQS...);

  // 1. Liberar el espacio que disparó este evento
  // IMPORTANTE: Esto asume que el evento se disparó porque algo salió. 
  // Decrementamos primero para reflejar la realidad en DB.
  try {
    await dynamo.send(new UpdateItemCommand({
        TableName: KITCHEN_TABLE,
        Key: { tenantId: { S: tenantId }, kitchenId: { S: kitchenId } },
        UpdateExpression: "SET currentCooking = currentCooking - :dec",
        // Evitar negativos por si acaso
        ConditionExpression: "currentCooking > :zero",
        ExpressionAttributeValues: { ":dec": { N: "1" }, ":zero": { N: "0" } }
    }));
  } catch (e) {
      console.log("Counter already at zero or error decrementing:", e.message);
  }

  // 2. Buscar en SQS
  const queueRes = await sqs.send(new ReceiveMessageCommand({
    QueueUrl: QUEUE_URL,
    MaxNumberOfMessages: 1, // Procesamos de a 1
    WaitTimeSeconds: 2
  }));

  if (queueRes.Messages && queueRes.Messages.length > 0) {
    const msg = queueRes.Messages[0];
    const orderDetail = JSON.parse(msg.Body);

    // Simplificación: Asumimos que la cola es FIFO o que si sacamos uno que no es para esta cocina, lo devolvemos.
    // Para este lab, asumiremos que si sale de la cola, entra a esta cocina si coincide el ID.
    
    if (orderDetail.kitchenId === kitchenId) {
        console.log([Queue] Dequeued order ${orderDetail.orderId} for kitchen ${kitchenId});

        // Ocupar el espacio recién liberado
        await dynamo.send(new UpdateItemCommand({
            TableName: KITCHEN_TABLE,
            Key: { tenantId: { S: tenantId }, kitchenId: { S: kitchenId } },
            UpdateExpression: "SET currentCooking = currentCooking + :inc",
            ExpressionAttributeValues: { ":inc": { N: "1" } }
        }));

        await updateOrderStatus(tenantId, orderDetail.orderId, 'PREPARING');
        await publishEvent('bemmbos.kitchen', 'OrderAllocated', { ...orderDetail, status: 'PREPARING' });

        // Borrar mensaje
        await sqs.send(new DeleteMessageCommand({
            QueueUrl: QUEUE_URL,
            ReceiptHandle: msg.ReceiptHandle
        }));
    } else {
        // Si tienes múltiples cocinas usando la misma cola SQS standard, esto puede pasar.
        // En producción usarías un MessageGroupId o colas separadas.
        // Aquí simplemente no lo borramos (vuelve a la cola despues del visibility timeout)
        console.log(Order ${orderDetail.orderId} is for kitchen ${orderDetail.kitchenId}, but space is in ${kitchenId}. Ignored.);
    }
  } else {
      console.log("[Queue] No orders waiting.");
  }
};
