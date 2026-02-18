# Instalación Backend

Este proyecto es un backend para la aplicación de instalación de servicios de internet, construido con Node.js, Express, TypeORM y MySQL. A continuación se detallan las instrucciones para configurar y ejecutar el proyecto.

## Requisitos Previos

- Node.js (versión 14 o superior)
- MySQL (versión 5.7 o superior)
- Docker y Docker Compose (opcional, para ejecutar en contenedor)

## Instalación

1. **Clonar el repositorio:**

   ```bash
   git clone <URL_DEL_REPOSITORIO>
   cd instalacion-backend
   ```

2. **Instalar dependencias:**

   ```bash
   npm install
   ```

3. **Configurar el archivo de entorno:**

   Copia el archivo `.env.example` a `.env` y ajusta las variables de entorno según tu configuración local.
   Para Docker, asegúrate de definir también `MYSQL_ROOT_PASSWORD` y `MYSQL_DATABASE`.

4. **Ejecutar las migraciones:**

   Asegúrate de que tu base de datos MySQL esté en funcionamiento y ejecuta las migraciones para crear las tablas necesarias:

   ```bash
   npm run typeorm migration:run
   ```

## Ejecución

### Opción 1: Ejecutar localmente

Para iniciar el servidor en modo desarrollo, utiliza Nodemon:

```bash
npm run dev
```

### Opción 2: Ejecutar con Docker

Si prefieres usar Docker, puedes construir y ejecutar el contenedor con el siguiente comando:

```bash
docker-compose up --build
```

## Rutas

Las rutas principales de la API están definidas en `src/routes/installation.routes.ts`. Puedes realizar solicitudes a las siguientes rutas:

- `POST /installations`: Crear una nueva solicitud de instalación.
- `GET /installations`: Obtener todas las solicitudes de instalación.
- `GET /installations/:id`: Obtener una solicitud de instalación específica.
- `PUT /installations/:id`: Actualizar una solicitud de instalación específica.
- `DELETE /installations/:id`: Eliminar una solicitud de instalación específica.

## Contribuciones

Las contribuciones son bienvenidas. Si deseas contribuir, por favor abre un issue o envía un pull request.

## Licencia

Este proyecto está bajo la Licencia MIT. Consulta el archivo LICENSE para más detalles.

## Geonet CSV import (production notes)

 - Required environment variables: see `.env.example` for `GEONET_LOGIN_URL`, `GEONET_CSV_URL`, `GEONET_USER`, `GEONET_PASS`, and `GEONET_IMPORT_CRON`.
 - The import scheduler runs once at startup and then on the `GEONET_IMPORT_CRON` schedule when those env vars are set.
 - For production, set `NODE_ENV=production` and ensure migrations are run before starting the app.

Recommended production steps:

1. Create a `.env` from `.env.example` and fill in credentials.

2. Run migrations (do not rely on `synchronize: true` in production):

```bash
npx typeorm-ts-node-esm migration:run
```

3. Build and start the app:

```bash
npm run build
NODE_ENV=production npm run start
```

4. Monitor logs and ensure the cron job successfully downloads and imports the CSV. If you prefer manual control, you can set `GEONET_*` env vars only on the servers where you want the scheduler to run.

Note: developer tooling vulnerabilities (previously from ESLint/ajv) are dev-only and do not affect runtime. This repository now uses Rome instead of ESLint for linting/formatting.

Quick linting commands with Rome:

```bash
npx rome check
npx rome format
```

If you still want to run ESLint locally, you may install it separately, but do not install devDependencies on production servers (see below).