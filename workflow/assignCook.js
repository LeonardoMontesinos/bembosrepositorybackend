exports.handler = async (event) => {
    const cooks = ["Luffy", "Sanji", "Zeff"];
    const assigned = cooks[Math.floor(Math.random() * cooks.length)];
    console.log(`[Step 2] Order ${event.orderId} assigned to ${assigned}`);
    return { ...event, cook: assigned, step: "ASSIGNED" };
};