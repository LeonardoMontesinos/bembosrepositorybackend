**Proyecto**

Breve backend para la lógica de pedidos y gestión de menús (estructura del proyecto).

**Flujo general**
- **Cliente → Autenticación:** El cliente (app/web) se registra o se loguea usando los endpoints en `auth/` (`register.js`, `login.js`). Tras autenticarse obtiene un token/identificador de sesión para llamadas protegidas.
- **Consultar cocinas y menús:** El cliente solicita la lista de cocinas (`kitchen/listKitchens.js`) y el menú de una cocina (`kitchen/getMenu.js`). Los menús y sus ítems se administran por las rutas en `admin/` y `kitchen/`.
- **Crear pedido:** El cliente crea un pedido usando los endpoints en `orders/` (`create.js`). El flujo de pedido incluye creación, consulta (`get.js`, `list.js`) y actualización de estado (`updateStatus.js`).
- **Operaciones internas y administración:** El panel/servicios administrativos (archivos en `admin/`) permiten crear menús y trabajadores (`createMenu.js`, `createWorker.js`).

**Tablas (esquema inferido)**
Nota: los nombres y campos siguientes están inferidos de la organización del código y sirven como guía para entender las entidades principales. Ajusta según tu esquema real de base de datos.
- **`users`**: id (PK), email, password_hash, name, role (admin|worker|client), created_at, updated_at.
- **`kitchens`**: id (PK), name, address, contact, status, created_at.
- **`menus`**: id (PK), kitchen_id (FK → `kitchens`), title, description, active, created_at.
- **`menu_items`**: id (PK), menu_id (FK → `menus`), name, description, price, available, image_url.
- **`workers`**: id (PK), kitchen_id (FK → `kitchens`), user_id (FK → `users`), role, shift_info.
- **`orders`**: id (PK), user_id (FK → `users`), kitchen_id (FK → `kitchens`), items (json/relacional), total_amount, status (new|preparing|ready|delivered|cancelled), created_at, updated_at.

Si usas una base relacional (Postgres/MySQL) considera normalizar `items` en una tabla `order_items` con: order_id, menu_item_id, quantity, unit_price.

**Cómo acceder a la documentación de la API**
- El repositorio incluye un directorio `docs/` (ej. `docs/index.js`) con la lógica/archivo relacionada a la documentación.
- Para generar la documentación OpenAPI (si está configurado):

	```bash
	npm install
	npm run generate-openapi
	```

	- El script `generate-openapi` utiliza `serverless openapi generate` (ver `package.json`). Asegúrate de tener las dependencias de desarrollo instaladas y configuradas.
	- El resultado de la generación suele producir un JSON/YAML de OpenAPI o archivos estáticos dentro de `docs/` o en la ubicación que hayas configurado.

- Para ver la documentación localmente puedes:
	- Abrir el contenido del archivo `docs/index.js` para revisar ejemplos y rutas documentadas.
	- Si tu entorno expone la ruta estática `/docs`, accede a `http://localhost:<PUERTO>/docs` (depende de cómo despliegues/levantes el servidor).

**Levantando / desplegando**
- Instala dependencias: `npm install`.
- Generar OpenAPI: `npm run generate-openapi`.
- Desplegar (Serverless): `npm run deploy` (requiere configuración de `serverless.yml` y credenciales).

**Dónde mirar en el código**
- Autenticación: `auth/` (`register.js`, `login.js`).
- Administración de menús y trabajadores: `admin/`.
- Gestión de cocinas y menú público: `kitchen/`.
- Pedidos y lógica de órdenes: `orders/`.
- Configuración serverless y plugins: `serverless.yml`, `package.json`.

Si quieres, puedo:
- Añadir ejemplos concretos de las respuestas JSON para cada endpoint.
- Extraer automáticamente campos exactos de la base de datos si compartes el archivo de definición del esquema (migrations/ORM).

---
Actualizado: documentación orientativa sobre flujo, tablas y acceso a la API.

