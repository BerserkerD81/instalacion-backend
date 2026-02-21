import 'dotenv/config'; // Asegura que esto esté arriba
import express from 'express';
import cors from 'cors';
import fs from 'fs';
import path from 'path';
import routes from './routes';
import errorHandler from './middlewares/errorHandler';
import { appConfig } from './config';
import { TechnicianService } from './services/technician.service';
import { startGeonetImportScheduler } from './services/geonetImportScheduler';
const app = express();
const technicianService = new TechnicianService();

// Middleware
app.use(
  cors({
    origin: (origin: string | undefined, callback: (err: Error | null, allow?: boolean) => void) => {
      const allowed = (process.env.CORS_ORIGIN || '*')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);

      if (!origin) return callback(null, true);
      if (allowed.includes('*') || allowed.includes(origin)) return callback(null, true);
      return callback(new Error(`CORS blocked for origin: ${origin}`));
    },
    credentials: true,
  })
);

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

app.use('/api', routes);
app.use(routes);

app.use(errorHandler);

// Sincronización diaria de técnicos
async function runDailyTechSync() {
  try {
    await technicianService.syncFromWeb();
    console.log('Technician daily sync completed');
  } catch (err) {
    console.error('Error running daily technician sync:', String(err));
  }
}
runDailyTechSync();
setInterval(runDailyTechSync, 24 * 60 * 60 * 1000);

// --- CORRECCIÓN AQUÍ ---

// 1. Iniciar Scheduler (Este se encargará de la importación remota inicial y las programadas)
startGeonetImportScheduler();


const PORT = appConfig.port || 3000;
const startServer = () => {
  app.listen(PORT, () => {
    console.log(`Server is running on http://localhost:${PORT}`);
  });
};

startServer();