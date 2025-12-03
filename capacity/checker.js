const { DynamoDBClient, UpdateItemCommand, GetItemCommand } = require("@aws-sdk/client-dynamodb");
const { SQSClient, SendMessageCommand } = require("@aws-sdk/client-sqs");
const { SFNClient, StartExecutionCommand } = require("@aws-sdk/client-sfn");
const { SNSClient, PublishCommand } = require("@aws-sdk/client-sns");

const dynamo = new DynamoDBClient({});
const sqs = new SQSClient({});
const sfn = new SFNClient({});
const sns = new SNSClient({});

const MAX_CAPACITY = 5; // En un caso real, leerías esto de KitchenTable

exports.handler = async (event) => {
  const detail = event.detail; // Payload del EventBridge
  const { kitchenId, orderId } = detail;

  // Revisar capacidad
  const state = await dynamo.send(new GetItemCommand({
    TableName: process.env.KITCHEN_STATE_TABLE,
    Key: { kitchenId: { S: kitchenId } }
  }));

  const currentUsed = parseInt(state.Item?.used?.N || "0");

  if (currentUsed < MAX_CAPACITY) {
    // A. HAY ESPACIO: Aumentar contador y lanzar Step Function
    await dynamo.send(new UpdateItemCommand({
      TableName: process.env.KITCHEN_STATE_TABLE,
      Key: { kitchenId: { S: kitchenId } },
      UpdateExpression: "SET used = if_not_exists(used, :z) + :inc",
      ExpressionAttributeValues: { ":inc": { N: "1" }, ":z": { N: "0" } }
    }));

    await sfn.send(new StartExecutionCommand({
      stateMachineArn: process.env.STATE_MACHINE_ARN,
      input: JSON.stringify(detail),
      name: `Order-${orderId}-${Date.now()}`
    }));

  } else {
    // B. LLENO: Mandar a SQS y Avisar a Operaciones
    console.log(`Kitchen ${kitchenId} Full. Queueing order ${orderId}`);
    
    // 1. Encolar en SQS
    await sqs.send(new SendMessageCommand({
      QueueUrl: process.env.WAITING_QUEUE_URL,
      MessageBody: JSON.stringify(detail)
    }));

    // 2. Alerta SNS (Operaciones)
    await sns.send(new PublishCommand({
      TopicArn: process.env.OPERATIONS_TOPIC_ARN,
      Message: `ALERTA CRÍTICA: La cocina ${kitchenId} ha alcanzado su capacidad máxima (${currentUsed}). El pedido ${orderId} está en cola de espera.`,
      Subject: "Kitchen Capacity Alert"
    }));
  }
};