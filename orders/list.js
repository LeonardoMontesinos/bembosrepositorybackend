const { DynamoDBClient, QueryCommand } = require("@aws-sdk/client-dynamodb");
const { json } = require("../http");

const dynamo = new DynamoDBClient({});
const TABLE_NAME = process.env.ORDERS_TABLE || "OrdersTable";

// Roles operativos
const STAFF_ROLES = new Set(["admin", "kitchen", "delivery"]);

// Estados que el Staff necesita ver (Operativos)
const STAFF_VISIBLE_STATUSES = ["CREATED", "COOKING", "SENDED", "READY_PICKUP"];

exports.handler = async (event) => {
  try {
    // 1. Obtener usuario y rol
    const auth = event.requestContext?.authorizer || {};
    const user = auth.claims || auth;
    
    const tenantId = user.tenantId || "DEFAULT";
    const rawRole = user.role || "user";
    const userId = user.userId || user.sub;
    
    const role = String(rawRole).toLowerCase().trim();
    const isStaff = STAFF_ROLES.has(role);

    console.log(`LIST ORDERS: User ${userId} | Role: ${role} | IsStaff: ${isStaff}`);

    // 2. Configurar la Query a DynamoDB
    const ExpressionAttributeNames = { "#status": "status" }; // 'status' es palabra reservada
    const ExpressionAttributeValues = {
      ":pk": { S: `TENANT#${tenantId}` }
    };
    let FilterExpression = "";

    // --- LÓGICA DIFERENCIADA ---

    if (isStaff) {
      // CASO STAFF:
      // - Solo ven pedidos ACTIVOS (filtro de estado).
      // - Ven pedidos de TODOS los usuarios.
      // - Orden: FIFO (Más antiguos primero) para atender en orden.

      const statusKeys = STAFF_VISIBLE_STATUSES.map((status, index) => {
        const key = `:s${index}`;
        ExpressionAttributeValues[key] = { S: status };
        return key;
      });
      
      FilterExpression = `#status IN (${statusKeys.join(", ")})`;

    } else {
      // CASO USUARIO:
      // - Ven pedidos ACTIVOS Y PASADOS (sin filtro de estado = historial completo).
      // - Solo ven SUS PROPIOS pedidos (filtro de propiedad).
      // - Orden: LIFO (Más nuevos primero) para ver su pedido actual arriba.

      FilterExpression = "createdBy = :userId";
      ExpressionAttributeValues[":userId"] = { S: userId };
    }

    // 3. Ejecutar Query
    const command = new QueryCommand({
      TableName: TABLE_NAME,
      KeyConditionExpression: "PK = :pk",
      FilterExpression: FilterExpression,
      ExpressionAttributeNames: Object.keys(ExpressionAttributeNames).length ? ExpressionAttributeNames : undefined,
      ExpressionAttributeValues: ExpressionAttributeValues,
      
      // isStaff = true  -> ScanIndexForward = true (Ascendente/Viejos primero)
      // isStaff = false -> ScanIndexForward = false (Descendente/Nuevos primero)
      ScanIndexForward: isStaff 
    });

    const result = await dynamo.send(command);

    // 4. Formatear
    const orders = (result.Items || []).map((item) => {
      const order = {
        orderId: item.SK.S.replace("ORDER#", ""),
        status: item.status?.S,
        total: Number(item.total?.N || 0),
        type: item.type?.S || "STORE",
        createdAt: item.createdAt?.S,
        kitchenId: item.kitchenId?.S
      };
      
      // Detalles extra según quién lo ve
      if (isStaff) {
        // Staff necesita items detallados y tiempo transcurrido
        order.items = item.items?.S ? JSON.parse(item.items.S) : [];
        order.customer = item.createdBy?.S;
        order.minutesElapsed = Math.floor((Date.now() - new Date(item.createdAt?.S).getTime()) / 60000);
      } else {
        // Usuario quiere ver sus items para recordar qué pidió
        order.items = item.items?.S ? JSON.parse(item.items.S) : [];
      }
      
      return order;
    });

    return json(200, {
      mode: isStaff ? "STAFF_WORK_QUEUE" : "USER_HISTORY",
      count: orders.length,
      orders
    }, event);

  } catch (err) {
    console.error("LIST ORDERS ERROR:", err);
    return json(500, { message: "Server error", error: err.message }, event);
  }
};
