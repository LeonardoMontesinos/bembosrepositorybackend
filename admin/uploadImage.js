const { S3Client, PutObjectCommand } = require("@aws-sdk/client-s3");

const s3 = new S3Client({});
const BUCKET = process.env.MENU_BUCKET || "my-image-bucket";

exports.handler = async (event) => {
    try {
        const body = JSON.parse(event.body || "{}");
        const { base64, fileName, contentType } = body;

        // ================================
        // 1. Obtener role + tenantId del authorizer
        // ================================
        let role = null;
        let tenantId = null;

        if (event?.requestContext?.authorizer) {
        const auth = event.requestContext.authorizer;
        const claims = auth.claims || auth;
        role = auth.role || claims.role || null;
        tenantId = auth.tenantId || claims.tenantId || null;
        }

        // fallback opcional
        if (!role && body.role) role = body.role;
        if (!tenantId && body.tenantId) tenantId = body.tenantId;

        // Validar auth
        if (!tenantId) {
        return {
            statusCode: 400,
            body: JSON.stringify({ message: "Missing tenantId from authorizer" }),
        };
        }

        if (!role || String(role).toLowerCase() !== "admin") {
        return {
            statusCode: 403,
            body: JSON.stringify({ message: "Forbidden: admin role required" }),
        };
        }

        // ================================
        // 2. Validar campos
        // ================================
        if (!base64 || !fileName || !contentType) {
        return {
            statusCode: 400,
            body: JSON.stringify({
            message: "Missing fields: base64, fileName, contentType",
            }),
        };
        }

        const buffer = Buffer.from(base64, "base64");

        // Ruta del archivo dentro del bucket
        const key = `tenants/${tenantId}/menu/${fileName}`;

        // ================================
        // 3. Subir a S3
        // ================================
        await s3.send(
        new PutObjectCommand({
            Bucket: BUCKET,
            Key: key,
            Body: buffer,
            ContentType: contentType,
        })
        );

        const imageUrl = `https://${BUCKET}.s3.amazonaws.com/${key}`;

        return {
        statusCode: 200,
        body: JSON.stringify({
            message: "Image uploaded",
            imageUrl,
        }),
        };
    } catch (err) {
        console.error("UPLOAD ERROR:", err);
        return {
        statusCode: 500,
        body: JSON.stringify({
            message: "Server error",
            error: err.message,
        }),
        };
    }
};
