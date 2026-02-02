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