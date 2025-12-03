const { SQSClient, ReceiveMessageCommand, DeleteMessageCommand } = require("@aws-sdk/client-sqs");
const { DynamoDBClient, UpdateItemCommand } = require("@aws-sdk/client-dynamodb");
const { SFNClient, StartExecutionCommand } = require("@aws-sdk/client-sfn");

const sqs = new SQSClient({});
const dynamo = new DynamoDBClient({});
const sfn = new SFNClient({});

exports.handler = async (event) => {
    const { kitchenId } = event; // Viene del manager

    // 1. Buscar si hay alguien esperando
    const sqsRes = await sqs.send(new ReceiveMessageCommand({
        QueueUrl: process.env.WAITING_QUEUE_URL,
        MaxNumberOfMessages: 1,
        WaitTimeSeconds: 2
    }));

    if (!sqsRes.Messages || !sqsRes.Messages.length) {
        console.log("Queue empty.");
        return;
    }

    const message = sqsRes.Messages[0];
    const orderDetail = JSON.parse(message.Body);

    // 2. Ocupar el espacio liberado
    await dynamo.send(new UpdateItemCommand({
        TableName: process.env.KITCHEN_STATE_TABLE,
        Key: { kitchenId: { S: kitchenId } },
        UpdateExpression: "SET used = used + :inc",
        ExpressionAttributeValues: { ":inc": { N: "1" } }
    }));

    // 3. Iniciar Step Function para el pedido desencolado
    await sfn.send(new StartExecutionCommand({
        stateMachineArn: process.env.STATE_MACHINE_ARN,
        input: JSON.stringify(orderDetail),
        name: `FromQueue-${orderDetail.orderId}-${Date.now()}`
    }));

    // 4. Borrar de SQS
    await sqs.send(new DeleteMessageCommand({
        QueueUrl: process.env.WAITING_QUEUE_URL,
        ReceiptHandle: message.ReceiptHandle
    }));
};  