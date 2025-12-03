const { DynamoDBClient, PutItemCommand } = require("@aws-sdk/client-dynamodb");
const { unmarshall } = require("@aws-sdk/util-dynamodb");

const dynamo = new DynamoDBClient({});
const AUDIT_TABLE = process.env.AUDIT_TABLE;

exports.handler = async (event) => {
  // DynamoDB Streams envía lotes de registros
  for (const record of event.Records) {
    try {
      // Solo nos interesan modificaciones o inserciones
      if (record.eventName === "REMOVE") continue;

      // Desempaquetar imágenes de DynamoDB (JSON format)
      const newImage = unmarshall(record.dynamodb.NewImage);
      const oldImage = record.dynamodb.OldImage ? unmarshall(record.dynamodb.OldImage) : {};

      // Detectar cambio de estado
      const oldStatus = oldImage.status || "N/A";
      const newStatus = newImage.status;

      // Si el estado no cambió, ignoramos (para no llenar logs con actualizaciones menores)
      if (oldStatus === newStatus) continue;

      const orderId = newImage.SK.replace("ORDER#", "");
      const tenantId = newImage.tenantId || "DEFAULT";
      const timestamp = new Date().toISOString();

      console.log(`AUDIT: Order ${orderId} changed from ${oldStatus} to ${newStatus}`);

      // Guardar en tabla de auditoría
      await dynamo.send(new PutItemCommand({
        TableName: AUDIT_TABLE,
        Item: {
          PK: { S: `ORDER#${orderId}` },         // Partition Key: ID del pedido
          SK: { S: `CHG#${timestamp}` },         // Sort Key: Tiempo exacto
          tenantId: { S: tenantId },
          oldStatus: { S: oldStatus },
          newStatus: { S: newStatus },
          changedAt: { S: timestamp },
          // Intentamos capturar quién lo hizo si el campo existe
          modifiedBy: { S: newImage.updatedBy || "system/workflow" } 
        },
        // TTL: Opcional, borrar logs después de 90 días automáticamente
        // (Requiere configurar TTL en la tabla, atributo 'expireAt')
        // expireAt: { N: Math.floor(Date.now() / 1000) + 7776000 } 
      }));

    } catch (err) {
      console.error("AUDIT ERROR:", err);
      // No lanzamos error para no bloquear el stream, pero lo logueamos
    }
  }
};
