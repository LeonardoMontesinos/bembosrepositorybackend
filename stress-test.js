const https = require('https');

// --- CONFIGURACIÓN ---
const BASE_URL = 'https://z3s81ifg07.execute-api.us-east-1.amazonaws.com/dev'; 
const USER_CREDENTIALS = {
    username: "UsuarioStressFijo", 
    password: "Password123!",
    email: "stress.fijo@test.com",
    tenantId: "t1" 
};
// ---------------------

const request = (endpoint, method, body, token = null) => {
    return new Promise((resolve, reject) => {
        const url = new URL(`${BASE_URL}${endpoint}`);
        const options = {
            method: method,
            headers: { 'Content-Type': 'application/json' }
        };
        if (token) options.headers['Authorization'] = token;

        const req = https.request(url, options, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    const parsed = JSON.parse(data);
                    resolve({ statusCode: res.statusCode, body: parsed });
                } catch (e) {
                    resolve({ statusCode: res.statusCode, body: data });
                }
            });
        });

        req.on('error', (e) => reject(e));
        if (body) req.write(JSON.stringify(body));
        req.end();
    });
};

const runTest = async () => {
    console.log(`\n🤖 INICIANDO PRUEBA DE ESTRÉS (V4 - Token Fix)`);
    console.log(`   Usuario: ${USER_CREDENTIALS.username}`);
    console.log("---------------------------------------------------");

    try {
        // 1. REGISTRO
        console.log("1️⃣  Intentando registro...");
        const regRes = await request('/auth/register', 'POST', USER_CREDENTIALS);
        
        if (regRes.statusCode === 201) {
            console.log("   ✅ Usuario creado nuevo.");
        } else if (regRes.statusCode === 409) {
            console.log("   ℹ️  El usuario ya existe (Continuamos).");
        } else {
            console.warn("   ⚠️  Nota sobre registro:", regRes.body.message || regRes.body);
        }

        // 2. LOGIN
        console.log("2️⃣  Iniciando sesión...");
        // Pequeña espera por si acabamos de registrar
        await new Promise(r => setTimeout(r, 1000));

        const loginRes = await request('/auth/login', 'POST', {
            username: USER_CREDENTIALS.username,
            password: USER_CREDENTIALS.password,
            tenantId: USER_CREDENTIALS.tenantId
        });

        // --- CORRECCIÓN AQUÍ: Aceptamos 'token' O 'idToken' ---
        const token = loginRes.body.token || loginRes.body.idToken;

        if (!token) {
            console.error("❌ ERROR DE LOGIN. Respuesta:", JSON.stringify(loginRes.body, null, 2));
            return; 
        }
        
        console.log("   ✅ Login exitoso. Token obtenido.");

        // 3. BOMBARDEO DE PEDIDOS
        console.log("\n3️⃣  🚀 LANZANDO 12 PEDIDOS AHORA...");
        
        const promises = [];

        for (let i = 1; i <= 12; i++) {
            await new Promise(r => setTimeout(r, 100)); 

            const isDelivery = i % 2 === 0;
            const orderType = isDelivery ? "DELIVERY" : "STORE";
            const itemName = isDelivery ? `Royal-Grande-${i}` : `Clasica-Jr-${i}`;
            
            const orderBody = {
                items: [{ id: itemName, qty: 1 }],
                total: 10 + i,
                type: orderType, 
                kitchenId: "kitchen_1" 
            };

            console.log(`   ➤ Enviando Pedido #${i} (${orderType})...`);
            
            const p = request('/orders', 'POST', orderBody, token)
                .then(res => {
                    // Aceptamos 200 (OK) o 201 (Created)
                    if(res.statusCode === 201 || res.statusCode === 200) {
                        console.log(`      ✅ Pedido #${i} Aceptado: ${res.body.orderId}`);
                    } else {
                        console.error(`      ❌ Pedido #${i} Rechazado:`, res.body);
                    }
                })
                .catch(err => {
                    console.error(`      ❌ Pedido #${i} Error de Red:`, err);
                });
            
            promises.push(p);
        }

        await Promise.all(promises);
        console.log("\n---------------------------------------------------");
        console.log("🏁 PRUEBA FINALIZADA.");
        console.log("   👉 Corre a ver AWS SQS y Step Functions AHORA MISMO.");

    } catch (error) {
        console.error("\n❌ ERROR NO CONTROLADO:", error);
    }
};

runTest();