import 'dotenv/config'; // Asegura que esto esté arriba
import express from 'express';
import cors from 'cors';
import fs from 'fs';
import path from 'path';
import rateLimit from 'express-rate-limit'; // <-- IMPORTACIÓN DEL LIMITADOR
import routes from './routes';
import errorHandler from './middlewares/errorHandler';
import { appConfig } from './config';
import { TechnicianService } from './services/technician.service';
import { startGeonetImportScheduler } from './services/geonetImportScheduler';
import { scheduleSmartoltOnuSnapshots } from './services/smartOlt';

// 👇 AÑADE ESTA IMPORTACIÓN (Ajusta la ruta según dónde esté tu AppDataSource)
import { initializeDataSource } from './database/data-source'; // o './data-source', etc.

const app = express();
const technicianService = new TechnicianService();

// ==========================================
// 1. CONFIAR EN EL PROXY (CRÍTICO PARA DOCKER/NGINX)
// ==========================================
// Permite que Express lea la IP real del usuario (X-Forwarded-For) enviada por Nginx.
// Sin esto, el Rate Limiter bloquearía a todos al mismo tiempo creyendo que Nginx es el atacante.
app.set('trust proxy', 1);

// ==========================================
// 2. CONFIGURACIÓN ESTRICTA DE CORS
// ==========================================
const allowedOrigins = [
  'https://n8n.geonet.cl',
  'https://instalaciones.geonet.cl',
];

app.use(
  cors({
    origin: (origin: string | undefined, callback: (err: Error | null, allow?: boolean) => void) => {
      // Permitir peticiones sin origin (ej. llamadas de servidor a servidor de n8n, Postman, curl)
      if (!origin) return callback(null, true);
      
      // Lista blanca estricta
      if (allowedOrigins.includes(origin)) {
        return callback(null, true);
      }
      
      console.warn(`[Seguridad] Petición bloqueada por CORS desde el origen: ${origin}`);
      return callback(new Error(`CORS bloqueado para el origen: ${origin}`));
    },
    credentials: true,
  })
);

// ==========================================
// 3. RATE LIMITER (ANTI-FUERZA BRUTA / DDOS)
// ==========================================
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // Ventana de 15 minutos
  max: 150, // Límite de 150 peticiones por IP cada 15 minutos
  message: { error: 'Demasiadas peticiones desde esta IP, tu acceso ha sido bloqueado temporalmente.' },
  standardHeaders: true, // Retorna información del límite en los headers `RateLimit-*`
  legacyHeaders: false, // Deshabilita los headers obsoletos `X-RateLimit-*`
});

// Middlewares de parseo (Límites de 50MB)
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Aplicar el Rate Limiter SOLO a las rutas de la API para protegerlas
app.use('/api', apiLimiter, routes);
app.use(routes); // Rutas sin el prefijo /api (si las hay)

// Manejador de Errores Global
app.use(errorHandler);

// ==========================================
// TAREAS PROGRAMADAS (CRON JOBS)
// ==========================================
// Sincronización diaria de técnicos
async function runDailyTechSync() {
  try {
    await technicianService.syncFromWeb();
    console.log('Technician daily sync completed');
  } catch (err) {
    console.error('Error running daily technician sync:', String(err));
  }
}

// ==========================================
// BOOTSTRAP E INICIO DEL SERVIDOR
// ==========================================
const PORT = appConfig.port || 3000;

const startServer = async () => {
  try {
    // 1. INICIAR BASE DE DATOS PRIMERO
    console.log('Conectando a la base de datos...');
    await initializeDataSource();
    console.log('✅ Base de datos inicializada correctamente.');

    // 2. INICIAR SCHEDULERS (Solo cuando la BD ya está lista)
    console.log('Iniciando tareas programadas (Schedulers)...');
    startGeonetImportScheduler();
    scheduleSmartoltOnuSnapshots();

    // 3. LEVANTAR EXPRESS
    app.listen(PORT, () => {
      console.log(`✅ Server is running on http://localhost:${PORT}`);
    });
  } catch (error) {
    // Si la BD falla y agota sus reintentos, detenemos el proceso
    console.error('❌ ERROR CRÍTICO: No se pudo iniciar la aplicación:', error);
    process.exit(1); 
  }
};

startServer();