async function handleCreate(event, user) {
  const data = parseBody(event);
  const tenantId = user.tenantId || "DEFAULT";
  const orderId = generateOrderId();
  const now = new Date().toISOString();
  const createdBy = user.sub || 'anonymous';

  // Items
  const items = Array.isArray(data.items) ? data.items : [];

  // Calcular total automáticamente
  const total = items.reduce((acc, item) => {
    const price = Number(item.price) || 0;
    const qty = Number(item.quantity) || 1;
    return acc + price * qty;
  }, 0);

  // Tipo: DELIVERY o TIENDA
  const orderType = (data.orderType || 'TIENDA').toUpperCase();

  // Details
  let details = null;
  if (orderType === 'DELIVERY') {
    details = {
      direccion: data.direccion || "SIN_DIRECCION"
    };
  }

  // Cocina elegida por el cliente
  const kitchenId = data.kitchenId || null;

  // Crear item en Dynamo
  const item = {
    PK: { S: `TENANT#${tenantId}` },
    SK: { S: `ORDER#${orderId}` },
    createdAt: { S: now },
    updatedAt: { S: now },
    createdBy: { S: createdBy },

    // Estado inicial: CREATED (Step Function cambiará luego)
    status: { S: 'CREATED' },

    // Tipo de entrega
    orderType: { S: orderType },
    details: { S: JSON.stringify(details) },

    items: { S: JSON.stringify(items) },
    total: { N: total.toString() },

    // Cocina elegida por el usuario
    kitchenId: kitchenId ? { S: kitchenId } : { NULL: true }
  };

  // Guardar la orden
  await dynamo.send(
    new PutItemCommand({
      TableName: TABLE_NAME,
      Item: item,
    })
  );

  // Copia en S3
  const s3Body = JSON.stringify({
    orderId,
    tenantId,
    createdAt: now,
    createdBy,
    status: 'CREATED',
    kitchenId,
    orderType,
    details
  });

  await s3.send(
    new PutObjectCommand({
      Bucket: BUCKET_NAME,
      Key: `${orderId}.json`,
      Body: s3Body,
      ContentType: 'application/json',
    })
  );

  // Log
  await logOrderEvent({
    orderId,
    tenantId,
    userId: createdBy,
    eventType: 'CREATE',
    payload: {
      status: 'CREATED',
      kitchenId,
      orderType,
      details
    }
  });

  // Respuesta final
  return response(201, {
    message: 'Order created successfully',
    order: {
      orderId,
      tenantId,
      status: 'CREATED',
      kitchenId,
      items,
      total,
      orderType,
      details,
      createdAt: now,
      updatedAt: now,
      createdBy,
    },
  });
}
