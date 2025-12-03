const { SNSClient, PublishCommand } = require("@aws-sdk/client-sns");
const sns = new SNSClient({});

exports.handler = async (event) => {
    const detail = event.detail; // Payload del EventBridge 2
    
    console.log(`Sending email notification for order ${detail.orderId}`);
    
    // Mensaje dinámico dependiendo de lo que mandó la Step Function
    const messageBody = `
      Hola Bembos Lover! 🍔
      
      Actualización de tu pedido #${detail.orderId}:
      Estado: ${detail.status}
      
      Detalle: ${detail.message || 'Tu pedido ha sido procesado.'}
      
      ¡Gracias por tu preferencia!
    `;

    await sns.send(new PublishCommand({
        TopicArn: process.env.CUSTOMER_TOPIC_ARN,
        Message: messageBody,
        Subject: `Bembos: Tu pedido está ${detail.status}`,
        MessageAttributes: {
            "receiver_email": {
                DataType: "String",
                StringValue: detail.customerEmail // La etiqueta con el destino
            }
        }
    }));
};