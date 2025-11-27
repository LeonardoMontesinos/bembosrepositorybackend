# Backend Bembos

Este repositorio contiene el backend utilizado por la plataforma de pedidos. Está pensado para ejecutarse sobre AWS (Lambda + API Gateway) y utiliza DynamoDB como almacenamiento principal. La documentación OpenAPI/Swagger se genera automáticamente con el plugin `serverless-openapi-documentation`.

## Resumen rápido
- **Almacenamiento:** DynamoDB (tablas declaradas en `serverless.yml`).
- **Documentación OpenAPI:** Generada por `serverless-openapi-documentation` y salida en `openapi.json` (incluida en el paquete y servida por la función `docs`).
- **Despliegue:** Se usa Serverless Framework (`serverless.yml`).

## Flujo general
- El cliente se autentica contra los endpoints en `auth/` (`register.js`, `login.js`).
- Se consultan cocinas y menús con los endpoints en `kitchen/` (`listKitchens`, `getMenu`).
- Los pedidos se crean/consultan/actualizan vía los endpoints en `orders/` (`create`, `list`, `get`, `updateStatus`).
- Las operaciones administrativas (crear menú, trabajador, etc.) están en `admin/` y requieren autorización.

## DynamoDB — Tablas y esquema (definido en `serverless.yml`)
Los recursos DynamoDB están definidos en `serverless.yml`. A continuación el resumen de las tablas y sus claves principales:

- **UserTable** (env `USER_TABLE`, declarada como `UserTable-${sls:stage}` en `serverless.yml`):
	- BillingMode: PAY_PER_REQUEST
	- KeySchema: `userId` (HASH) + `tenantId` (RANGE)
	- AttributeDefinitions: `tenantId` (S), `userId` (S), `email` (S), `username` (S), `role` (S)
	- Global Secondary Indexes: `EmailIndex` (email + tenantId), `UsernameIndex` (username + tenantId), `TenantRoleIndex` (tenantId + role)
	- Uso: almacenamiento de usuarios por tenant, búsquedas por email/username, filtrado por rol.

- **OrdersTable** (env `ORDERS_TABLE`):
	- BillingMode: PAY_PER_REQUEST
	- KeySchema: `PK` (HASH) + `SK` (RANGE)
	- Uso: modelo genérico PK/SK para representar órdenes y/o índices compuestos (patrón single-table posible).

- **MenuTable** (env `MENU_TABLE`):
	- KeySchema: `tenantId` (HASH) + `dishId` (RANGE)
	- Uso: lista de platos por tenant (dishId identifica el plato dentro del tenant).

- **KitchenTable** (nombre `KitchenTable-${sls:stage}`):
	- KeySchema: `tenantId` (HASH) + `kitchenId` (RANGE)
	- Uso: información de cocinas por tenant.

Notas:
- Las tablas usan `PAY_PER_REQUEST` (on-demand).
- Orders utiliza un esquema `PK`/`SK` — revisa el código en `orders/` para entender cómo se construyen esas claves (partition/sort).
- Si necesitas un diagrama detallado de cómo se relacionan las entidades en DynamoDB (ej. patrones single-table), puedo generarlo a partir del código.

## Generar y servir la documentación OpenAPI (Swagger)
La generación de la especificación OpenAPI se maneja con `serverless-openapi-documentation` y la configuración que aparece en `serverless.yml`.

- Para generar la spec localmente:

	```bash
	npm install
	npm run generate-openapi
	```

	- `npm run generate-openapi` ejecuta `serverless openapi generate` (ver `package.json`).
	- El output está configurado como `openapi.json` en la sección `custom.openapi.output` de `serverless.yml`.

- El proyecto incluye una función `docs` que sirve `openapi.json` y la ruta `/docs` (revisa `serverless.yml` → función `docs`). Tras desplegar (o simular con un emulador) tendrás las rutas:
	- `GET /openapi.json` → devuelve la especificación OpenAPI generada.
	- `GET /docs` → punto de entrada para documentación estática (según tu implementación en `docs/index.js`).

### Automatización de respuestas de error (sin tocar cada función)
La generación automática de `openapi.json` la hace `serverless-openapi-documentation`. Además hay un pequeño paso de post-procesado que añade respuestas de error por defecto (`400`, `401`, `500`) referenciando un `ErrorResponse` común en `components.responses`.

Importante: no se inyecta ningún `securityScheme` en la spec — la documentación se mantiene tal como la genera el plugin a partir de `serverless.yml`. Si quieres añadir seguridad (ej. `bearerAuth`) lo podemos hacer de forma explícita, pero por ahora la spec queda sin esa configuración automática.

Esto se ejecuta automáticamente antes del deploy gracias a la configuración en `serverless.yml` (hook `before:deploy:deploy`) y al script `scripts/postprocess-openapi.js`.

Comando típico (para generar y desplegar):

```bash
npx serverless deploy --stage dev
```

Nota: también puedes generar solo la spec localmente con `npx serverless openapi generate` o usando `npm run generate-openapi`.

## Comandos útiles
- Instalar dependencias:

	```bash
	npm install
	```

- Generar OpenAPI (local):

	```bash
	npm run generate-openapi
	```

- Desplegar a AWS (Serverless):

	```bash
	npm run deploy
	```

	(requiere configurar credenciales AWS y revisar `serverless.yml`)

## Variables de entorno relevantes
Las siguientes variables aparecen en `serverless.yml` y controlan nombres de tablas y buckets:

- `USER_TABLE` → nombre de la tabla de usuarios (ej. `UserTable-${sls:stage}`)
- `ORDERS_TABLE` → tabla de órdenes
- `ORDERS_BUCKET` → bucket S3 para artefactos relacionados con órdenes
- `MENU_TABLE` → tabla de menú
- `MENU_BUCKET` → bucket para menús
- `JWT_SECRET`, `ALLOWED_ORIGINS`, etc.

## Despliegue en una máquina compartida (VM / EC2)

Si vas a usar una máquina virtual compartida para ejecutar los comandos de despliegue (por ejemplo una EC2 que usa varios devs o una máquina de CI privada), sigue estos pasos y recomendaciones.

- Clona el repo en la VM y entra en la carpeta:

```bash
git clone <tu-repo-url> ~/backend-bembos
cd ~/backend-bembos
```

- Crea un archivo `.env` en la raíz del proyecto con las variables necesarias. El plugin `serverless-dotenv-plugin` cargará este archivo cuando ejecutes `serverless`.

Ejemplo mínimo de `.env`:

```env
JWT_SECRET=valor-muy-secreto
ALLOWED_ORIGINS=*
CORS_ALLOW_CREDENTIALS=false
# Opcional: AWS variables si no las configuras con aws cli
# AWS_ACCESS_KEY_ID=...
# AWS_SECRET_ACCESS_KEY=...
```

- Asegura las credenciales AWS en la VM (elige uno de los métodos):

	- Exportar en la sesión (temporal):

		```bash
		export AWS_ACCESS_KEY_ID=...
		export AWS_SECRET_ACCESS_KEY=...
		export AWS_REGION=us-east-1
		```

	- O usar `aws configure` para guardarlas en `~/.aws/credentials` (recomendado para una VM que usa un solo account):

		```bash
		aws configure
		```

	- En entornos compartidos considera usar perfiles (`AWS_PROFILE`) o roles de instancia (EC2 IAM Role) en lugar de dejar las keys en texto.

- Instala dependencias y comprueba variables antes de desplegar:

```bash
npm install
npm run check-env        # valida que JWT_SECRET (y otros requeridos) existan
npm run deploy:checked -- --stage dev
```

`npm run deploy:checked` ejecuta `check-env` y, si todo está ok, hace `serverless deploy`. Si faltan variables, aborta con un mensaje claro.

Nota: `serverless-dotenv-plugin` solo actúa cuando usas Serverless CLI (`sls`/`serverless`). Si ejecutas los ficheros Node directamente para pruebas, debes cargar `.env` en esa ejecución (por ejemplo con `node -r dotenv/config script.js`).

### Ejecutar localmente en la VM (sin desplegar)

Este proyecto está pensado para Serverless (Lambda). Si quieres ejecutar pruebas locales o scripts que usan `process.env`, utiliza `dotenv` en la ejecución:

```bash
# instalar dotenv una vez si te hace falta
npm install dotenv

# ejecutar un script cargando .env antes
node -r dotenv/config path/to/script.js
```

Ejemplo: si ejecutaras una utilidad `scripts/foo.js` que requiere `JWT_SECRET`, haz:

```bash
node -r dotenv/config scripts/foo.js
```

### Seguridad y buenas prácticas para máquinas compartidas

- No comites `.env` (ya está en `.gitignore`).
- Para entornos compartidos preferible usar IAM Roles de instancia (EC2) o variables en el sistema de CI con permisos limitados.
- Limita el acceso al fichero `.env` (`chmod 600 .env`) y evita claves en logs.

## Script de despliegue automatizado (`scripts/deploy.sh`)

He añadido un script `scripts/deploy.sh` que realiza los pasos necesarios para generar la spec OpenAPI, ejecutar el post-procesado y desplegar con Serverless. El script acepta un único parámetro: el `stage`.

Uso:

```bash
chmod +x ./scripts/deploy.sh
./scripts/deploy.sh dev
```

Qué hace el script:
- Comprueba que exista/valide el `.env` usando `npm run check-env`.
- Ejecuta `npx serverless openapi generate` y trata de producir `openapi.json` (si no lo genera intenta otras opciones).
- Ejecuta `node ./scripts/postprocess-openapi.js` si existe.
- Lanza `npx serverless deploy --stage <stage>`.
- Si `serverless.yml` contiene `runtime: nodejs22.x` (que puede no estar soportado por la versión local de Serverless), el script crea una copia temporal cambiando a `nodejs20.x` y usa esa copia para la generación y el deploy (no modifica tu `serverless.yml` original).

Si algo falla (por ejemplo `openapi.json` no se genera), el script abortará y mostrará un mensaje para intervenir manualmente.

Si querés que lo ejecute por vos o que lo haga ejecutable automáticamente, decímelo y lo hago.


## Dónde mirar en el código
- `auth/` → `register.js`, `login.js` (autenticación)
- `orders/` → `create.js`, `get.js`, `list.js`, `updateStatus.js` (lógica de órdenes)
- `kitchen/` → `createKitchen.js`, `getMenu.js`, `listKitchens.js` (cocinas y menú)
- `admin/` → `createMenu.js`, `createWorker.js`, `updateMenu.js` (operaciones administrativas)
- `docs/index.js` → función que sirve `openapi.json` y/o la UI de docs
- `serverless.yml` → configuración de funciones, tablas DynamoDB y generación OpenAPI (fuente principal de verdad)

---

