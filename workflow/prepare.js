exports.handler = async (event) => {
    console.log(`[Step 1] Preparing ingredients for order ${event.orderId}`);
    // Aquí iría lógica de inventario
    return { ...event, step: "PREPARED" };
};