import { DynamoDBClient, PutItemCommand, UpdateItemCommand, QueryCommand } from "@aws-sdk/client-dynamodb";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";

const dynamo = new DynamoDBClient({ region: "us-east-1" });
const s3 = new S3Client({ region: "us-east-1" });

const TABLE_NAME = "OrdersTable";
const BUCKET_NAME = "restaurant-orders-dashboard";

/**
 * Handler principal (maneja varias rutas de Order API)
 */
export const handler = async (event) => {
  try {
    const method = event.httpMethod;
    const path = event.path;
    const user = event.requestContext?.authorizer?.claims || {}; // si usas JWT con API Gateway
    const role = user.role || "USER"; // OWNER (restaurante) o USER (cliente)
    const tenantId = user.tenantId || "DEFAULT";

    console.log("📩 Incoming request:", { method, path });

    // --- Crear pedido ---
    if (method === "POST" && path === "/orders") {
      const data = JSON.parse(event.body || "{}");
      const orderId = `ORD-${Date.now()}`;
      const items = data.items || [];
      const total = data.total || 0;

      const now = new Date().toISOString();

      await dynamo.send(
        new PutItemCommand({
          TableName: TABLE_NAME,
          Item: {
            PK: { S: `TENANT#${tenantId}` },
            SK: { S: `ORDER#${orderId}` },
            createdAt: { S: now },
            updatedAt: { S: now },
            createdBy: { S: user.sub || "anonymous" },
            status: { S: "CREATED" },
            items: { S: JSON.stringify(items) },
            total: { N: total.toString() },
          },
        })
      );

      await s3.send(
        new PutObjectCommand({
          Bucket: BUCKET_NAME,
          Key: `${orderId}.json`,
          Body: JSON.stringify({
            orderId,
            tenantId,
            createdAt: now,
            createdBy: user.sub,
            status: "CREATED",
          }),
          ContentType: "application/json",
        })
      );

      
      return response(201, {
        message: "Order created successfully",
        order: {
          orderId,
          tenantId,
          status: "CREATED",
          items,
          total,
          createdAt: now,
          updatedAt: now,
          createdBy: user.sub || "anonymous"
        }
      });      
    }

    // --- Listar pedidos ---
    if (method === "GET" && path === "/orders") {
      // Si el usuario es OWNER (restaurante), lista todos los pedidos
      // Si es USER, solo los creados por él
      const filterExpression =
        role === "OWNER" ? undefined : "createdBy = :createdBy";

      const expressionValues =
        role === "OWNER"
          ? {}
          : { ":createdBy": { S: user.sub || "anonymous" } };

      const queryParams = {
        TableName: TABLE_NAME,
        KeyConditionExpression: "PK = :pk",
        ExpressionAttributeValues: {
          ":pk": { S: `TENANT#${tenantId}` },
          ...expressionValues,
        },
      };

      if (filterExpression) {
        queryParams.FilterExpression = filterExpression;
      }

      const result = await dynamo.send(new QueryCommand(queryParams));

      const orders = result.Items?.map((item) => ({
        orderId: item.SK.S.replace("ORDER#", ""),
        status: item.status?.S,
        total: Number(item.total?.N),
        createdAt: item.createdAt?.S,
        updatedAt: item.updatedAt?.S,
        createdBy: item.createdBy?.S,
      }));

      return response(200, { orders });
    }

    // --- Obtener detalle de un pedido ---
    if (method === "GET" && path.match(/^\/orders\/[^/]+$/)) {
      const orderId = path.split("/")[2];

      const result = await dynamo.send(
        new QueryCommand({
          TableName: TABLE_NAME,
          KeyConditionExpression: "PK = :pk AND SK = :sk",
          ExpressionAttributeValues: {
            ":pk": { S: `TENANT#${tenantId}` },
            ":sk": { S: `ORDER#${orderId}` },
          },
        })
      );

      if (!result.Items || result.Items.length === 0)
        return response(404, { message: "Order not found" });

      const order = result.Items[0];

      // Si es usuario normal, no puede ver pedidos ajenos
      if (role === "USER" && order.createdBy.S !== user.sub)
        return response(403, { message: "Forbidden" });

      return response(200, {
        orderId,
        status: order.status.S,
        items: JSON.parse(order.items.S),
        total: Number(order.total.N),
        createdAt: order.createdAt.S,
        updatedAt: order.updatedAt.S,
        createdBy: order.createdBy.S,
      });
    }

    // --- Cancelar pedido (soft delete) ---
    if (method === "DELETE" && path.match(/^\/orders\/[^/]+$/)) {
      const orderId = path.split("/")[2];

      // Primero obtener el pedido
      const result = await dynamo.send(
        new QueryCommand({
          TableName: TABLE_NAME,
          KeyConditionExpression: "PK = :pk AND SK = :sk",
          ExpressionAttributeValues: {
            ":pk": { S: `TENANT#${tenantId}` },
            ":sk": { S: `ORDER#${orderId}` },
          },
        })
      );

      if (!result.Items || result.Items.length === 0)
        return response(404, { message: "Order not found" });

      const order = result.Items[0];

      // Solo el creador o el OWNER pueden cancelar
      if (role !== "OWNER" && order.createdBy.S !== user.sub)
        return response(403, { message: "Forbidden" });

      await dynamo.send(
        new UpdateItemCommand({
          TableName: TABLE_NAME,
          Key: {
            PK: { S: `TENANT#${tenantId}` },
            SK: { S: `ORDER#${orderId}` },
          },
          UpdateExpression: "SET #s = :s, updatedAt = :t",
          ExpressionAttributeNames: { "#s": "status" },
          ExpressionAttributeValues: {
            ":s": { S: "CANCELLED" },
            ":t": { S: new Date().toISOString() },
          },
        })
      );

      return response(200, { message: `Order ${orderId} cancelled.` });
    }

    // Si no coincide ninguna ruta
    return response(404, { message: "Route not found" });
  } catch (err) {
    console.error("❌ Error:", err);
    return response(500, { error: err.message });
  }
};

// --- Helper para respuestas ---
const response = (statusCode, body) => ({
  statusCode,
  body: JSON.stringify(body),
});
