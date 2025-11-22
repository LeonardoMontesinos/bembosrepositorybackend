# Backend Bembos (Serverless API)

API multi-tenant para gestión de usuarios, cocinas (kitchens), menú y flujo de órdenes con asignación automática de cocina y repartidor (delivery) usando AWS Lambda + API Gateway + DynamoDB + S3.

## 🧱 Arquitectura resumida

- Autenticación nativa con JWT (HS256) generado en el endpoint `/auth/login`.
- Tablas DynamoDB:
	- `UserTable` (PK: `userId`, SK: `tenantId`) + GSIs `EmailIndex`, `UsernameIndex`, `TenantRoleIndex`.
	- `OrdersTable` (PK: `TENANT#<tenantId>`, SK: `ORDER#<orderId>`).
	- `MenuTable` (PK: `tenantId`, SK: `dishId`).
	- `KitchenTable` (PK: `tenantId`, SK: `kitchenId`).
- Buckets S3:
	- `ORDERS_BUCKET` para snapshots y logs de eventos de órdenes (`logs/orderId#tenantId#userId#timestamp.json`).
	- `MENU_BUCKET` para imágenes de platos (upload base64 o URL externa).
- Asignación automática:
	- Al crear una orden se intenta asignar una cocina con capacidad (máx 5 órdenes COOKING por cocina) y se cambia el estado a `COOKING`.
	- Al liberar capacidad (orden pasa de COOKING a SENDED / CANCELLED / DELIVERED) se intenta tomar una orden en CREATED y asignarla.
	- Al pasar a `SENDED` se asigna un usuario con rol `delivery` (cualquiera del tenant) y luego podrá marcar `DELIVERED`.

## 🔐 Autenticación y autorización

1. Registro público de usuarios (rol fijo `user`): `/auth/register`.
2. Login con email o username: `/auth/login` retorna `token` JWT.
3. Endpoints protegidos requieren header: `Authorization: Bearer <token>`.
4. Endpoints administrativos (`/admin/*`, `/kitchens` POST) requieren usuario con rol `admin` (creado vía `/admin/workers`).

Roles soportados: `user`, `admin`, `kitchen`, `delivery`.

## 📦 Modelos de datos (atributos principales)

### UserTable
```
userId (PK) | tenantId (SK) | email | username | password (salt:hash) | role
GSIs:
	EmailIndex:    email HASH, tenantId RANGE
	UsernameIndex: username HASH, tenantId RANGE
	TenantRoleIndex: tenantId HASH, role RANGE
```

### OrdersTable (por tenant)
```
PK = TENANT#<tenantId>
SK = ORDER#<orderId>
status: CREATED | COOKING | SENDED | DELIVERED | CANCELLED
items: JSON string array
total: number
createdBy: userId (sub claim)
kitchenId?: string
deliveryUserId?: string
createdAt / updatedAt: ISO timestamp
```

Estados y transiciones:
- CREATION: creado como `CREATED`. Si hay cocina con capacidad (<5 COOKING) se cambia a `COOKING` inmediatamente.
- COOKING → SENDED (marcado por OWNER/admin según reglas; asigna deliveryUserId).
- SENDED → DELIVERED (por OWNER o DELIVERY).
- CREATED → CANCELLED (por creador o OWNER, sólo si aún CREATED).

### MenuTable
```
tenantId (PK) | dishId (SK)
name | description | price | available (bool) | imageUrl | createdAt | updatedAt
```
A un plato se le hace upsert: crear sin `dishId`, actualizar con `dishId`.

### KitchenTable
```
tenantId (PK) | kitchenId (SK)
name | maxCooking (N) | currentCooking (N) | active (BOOL) | createdAt | updatedAt
```
(currentCooking no se actualiza todavía de forma transaccional; la capacidad se calcula contando órdenes COOKING.)

## 🧪 Endpoints

### 1. POST /auth/register
Registro de usuario final (rol `user`).
Request JSON:
```json
{ "tenantId": "t1", "email": "user@mail.com", "username": "user1", "password": "Secret123" }
```
Response 201:
```json
{ "message": "User created", "userId": "USR-xxxx" }
```

### 2. POST /auth/login
Login con email o username.
Request JSON (email):
```json
{ "tenantId": "t1", "email": "user@mail.com", "password": "Secret123" }
```
o (username):
```json
{ "tenantId": "t1", "username": "user1", "password": "Secret123" }
```
Response 200:
```json
{ "token": "<JWT>" }
```

### 3. POST /admin/workers
Crea worker (rol: admin | kitchen | delivery). Requiere rol admin (verificación lógica en body).
Request:
```json
{ "tenantId": "t1", "email": "k@a.com", "username": "k1", "password": "Secret123", "role": "kitchen" }
```
Response 201:
```json
{ "message": "Worker created", "userId": "WRK-xxxx", "role": "kitchen" }
```


### 4. POST /admin/menu
Crear o actualizar plato (soporta imagen por URL o base64).

**Crear (sin dishId):**
```json
{
	"tenantId": "t1",
	"role": "admin",
	"name": "Burger",
	"price": 12.5,
	"description": "Carne y queso",
	"available": true,
	// Opción 1: imagen por URL
	"imageUrl": "https://mi-cdn.com/burger.jpg"
	// Opción 2: imagen en base64 (data URI o solo base64)
	// "imageBase64": "data:image/png;base64,iVBORw0KGgoAAAANS..."
}
```
**Notas:**
- Si envías `imageUrl`, se guarda tal cual.
- Si envías `imageBase64`, la imagen se sube a S3 y se genera una URL pública (`imageUrl`).
- Si envías ambos, se prioriza `imageBase64`.

**Response 201:**
```json
{ "message": "Dish created", "dishId": "DISH-uuid", "imageUrl": "https://..." }
```

**Actualizar (con dishId):**
```json
{
	"tenantId": "t1",
	"role": "admin",
	"dishId": "DISH-uuid",
	"price": 13.0,
	"available": false,
	// Puedes actualizar imagen igual que en creación
	"imageUrl": "https://mi-cdn.com/burger2.jpg"
	// o
	// "imageBase64": "..."
}
```
**Response 200:**
```json
{ "message": "Dish updated", "dishId": "DISH-uuid", "imageUrl": "https://..." }
```


### 5. GET /menu?tenantId=t1[&limit=20][&lastKey=...]
Listado paginado de platos disponibles.

**Parámetros opcionales:**
- `limit`: cantidad máxima de platos por página (default 20, máx 100)
- `lastKey`: token de paginación (devuelto por la respuesta anterior)

**Ejemplo de request:**
```
GET /menu?tenantId=t1&limit=10
```

**Respuesta 200:**
```json
{
	"dishes": [ { "dishId":"DISH-uuid", "name":"Burger", "description":"Carne y queso", "price":12.5, "imageUrl":null } ],
	"nextKey": "eyJ0ZW5hbnRJZCI6InQxIiwiZGlzaElkIjoiRElTSC11dWlkIn0="
}
```
Si hay más resultados, `nextKey` se usa como `lastKey` en la siguiente petición para obtener la próxima página.

### 6. POST /kitchens (protegido)
Crear cocina (rol admin en body).
```json
{ "tenantId":"t1", "name":"Central", "role":"admin", "maxCooking":5 }
```
Response:
```json
{ "message":"Kitchen created", "kitchenId":"KITCHEN-uuid" }
```


### 7. GET /kitchens?tenantId=t1[&limit=20][&lastKey=...]
Listado paginado de cocinas del tenant (protegido).

**Parámetros opcionales:**
- `limit`: cantidad máxima de cocinas por página (default 20, máx 100)
- `lastKey`: token de paginación (devuelto por la respuesta anterior)

**Ejemplo de request:**
```
GET /kitchens?tenantId=t1&limit=5
```

**Respuesta 200:**
```json
{
	"kitchens": [ { "kitchenId":"KITCHEN-uuid", "name":"Central", "maxCooking":5, "currentCooking":0, "active":true } ],
	"nextKey": "eyJ0ZW5hbnRJZCI6InQxIiwia2l0Y2hlbklkIjoiS0lUQ0hFTi11dWlkIn0="
}
```
Si hay más resultados, `nextKey` se usa como `lastKey` en la siguiente petición para obtener la próxima página.

### 8. POST /orders (protegido)
Crea orden. Auto asigna cocina si hay capacidad.
Request ejemplo:
```json
{ "items": [{"dishId":"DISH-uuid","qty":2}], "total":25.0 }
```
Response 201:
```json
{
	"message":"Order created successfully",
	"order": {
		"orderId":"ORD-uuid",
		"tenantId":"t1",
		"status":"COOKING" | "CREATED",
		"kitchenId":"KITCHEN-uuid" | null,
		"items":[{"dishId":"DISH-uuid","qty":2}],
		"total":25.0,
		"createdAt":"ISO",
		"updatedAt":"ISO",
		"createdBy":"user-sub"
	}
}
```


### 9. GET /orders[?limit=20][&lastKey=...]
Lista paginada de órdenes del tenant; usuarios no OWNER ven sólo las suyas.

**Parámetros opcionales:**
- `limit`: cantidad máxima de órdenes por página (default 20, máx 100)
- `lastKey`: token de paginación (devuelto por la respuesta anterior)

**Ejemplo de request:**
```
GET /orders?limit=10
```

**Respuesta 200:**
```json
{
	"orders": [ { "orderId":"ORD-uuid", "status":"COOKING", "total":25.0, "createdAt":"ISO", "updatedAt":"ISO", "createdBy":"user-sub" } ],
	"nextKey": "eyJQSyI6IlRFTkFOVCN0MSIsIlNLIjoiT1JERVIjbGFzdElkIn0="
}
```
Si hay más resultados, `nextKey` se usa como `lastKey` en la siguiente petición para obtener la próxima página.

### 10. GET /orders/{id} (protegido)
Detalle de una orden. Usuarios con rol USER sólo si son creador.
Response:
```json
{ "orderId":"ORD-uuid", "status":"COOKING", "items":[{"dishId":"DISH-uuid","qty":2}], "total":25.0, "createdAt":"ISO", "updatedAt":"ISO", "createdBy":"user-sub" }
```

### 11. PATCH /orders/{id}/status (protegido)
Cambia estado siguiendo reglas.
Request:
```json
{ "status":"SENDED" }
```
Response:
```json
{ "message":"Order ORD-uuid status updated to SENDED", "deliveryUserId":"WRK-xxxx" }
```

Estados permitidos y quién puede:
- CANCELLED: desde CREATED (creador o OWNER).
- COOKING: OWNER desde CREATED.
- SENDED: OWNER desde COOKING (asigna deliveryUserId).
- DELIVERED: OWNER o DELIVERY desde SENDED.

## 📁 Logs de órdenes (S3)
- Creación y cada cambio de estado genera un archivo: `logs/<orderId>#<tenantId>#<userId>#<timestamp>.json`.
- Snapshot inicial adicional: `<orderId>.json`.

## 🖼 Imágenes de platos
- Upload base64 (`imageBase64`) o URL (`imageUrl`).
- Si base64: se almacena en `MENU_BUCKET` con ACL público (ajustar si necesitas privacidad).

## 🚀 Deploy
Pre-requisitos:
- AWS credenciales con permisos para crear DynamoDB tablas y S3 buckets.
- Variables de entorno: `JWT_SECRET`.

Comandos:
```bash
serverless deploy --stage dev
```

## 🧪 Próximos pasos (Testing)
- Añadir pruebas unitarias para: auto-asignación de cocina, reasignación, asignación de delivery, upsert de platos.
- Simular capacidad llena (>5 COOKING) y liberación.

## ⚠️ Consideraciones
- `currentCooking` en `KitchenTable` no se actualiza; el conteo se hace consultando órdenes. Se puede optimizar con un GSI futuro.
- Tamaño máximo de ítems: los platos están distribuidos (no un solo documento grande). Escalable.
- Seguridad: endpoints admin dependen de rol enviado en body; ideal mover esa verificación al token/JWT authorizer.

## ✅ Resumen rápido
# ✅ Resumen rápido
Esta API soporta registro/login multi-tenant, gestión de workers, gestión de platos, creación y ciclo de vida de órdenes con asignación automática de cocina y delivery, y logging auditable en S3.

---

## ℹ️ Guía para el Frontend: Paginación

Todos los endpoints de listado (`/menu`, `/kitchens`, `/orders`) soportan paginación con los parámetros opcionales:

- `limit`: cuántos ítems traer por página (default 20, máximo 100)
- `lastKey`: token de paginación (devuelto como `nextKey` en la respuesta anterior)

**Cómo paginar desde el front:**
1. Haz la primera petición con `limit` (ej: `/menu?tenantId=t1&limit=10`).
2. Si la respuesta trae `nextKey`, guarda ese valor.
3. Para la siguiente página, haz la petición agregando `lastKey=<valor_de_nextKey>`.
4. Repite hasta que la respuesta no traiga `nextKey` (fin de los datos).

**Ejemplo flujo:**
1. `GET /orders?limit=10` → respuesta: `{ orders: [...], nextKey: "abc..." }`
2. `GET /orders?limit=10&lastKey=abc...` → respuesta: `{ orders: [...], nextKey: "def..." }`
3. ...

El campo `nextKey` es un string seguro para URL (base64). No lo modifiques, solo pásalo tal cual en la siguiente petición.

