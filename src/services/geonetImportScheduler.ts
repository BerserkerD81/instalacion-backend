import cron from 'node-cron';
import { GeonetImportService } from './geonetImport.service'; // Asegúrate que esta ruta sea correcta
import logger from '../utils/logger';

export function startGeonetImportScheduler() {
  const schedule = process.env.GEONET_IMPORT_CRON || '0 2 * * *'; // default: 02:00 daily
  const loginUrl = process.env.GEONET_LOGIN_URL || '';
  
  // AHORA: Esta URL debe ser la página web donde está la tabla
  const dataPageUrl = process.env.GEONET_DATA_URL || process.env.GEONET_CSV_URL || '';
  
  const username = process.env.GEONET_USER || '';
  const password = process.env.GEONET_PASS || '';

  if (!loginUrl || !dataPageUrl || !username || !password) {
    logger.warn('GeonetImportScheduler: GEONET_* env vars not fully set — scheduler disabled');
    return;
  }

  // Instanciamos el servicio
  const service = new GeonetImportService();

  // Función auxiliar para no repetir código
  const runImportTask = async (origin: string) => {
    try {
      logger.info(`GeonetImportScheduler: running ${origin} import`);
      
      await service.importFromGeonet({ // Asegúrate que tu servicio acepte este objeto
        loginUrl,
        dataPageUrl, 
        username,
        password,
      });

      logger.info(`GeonetImportScheduler: ${origin} import finished`);
    } catch (err) {
      // Convertimos el error a string de forma segura para el logger
      const errorMsg = err instanceof Error ? err.message : String(err);
      logger.error(`GeonetImportScheduler: ${origin} import error: ${errorMsg}`);
    }
  };

  // 1. Programar el CRON (Esto corre a la hora programada, ej: 2 AM)
  const job = cron.schedule(schedule, async () => {
    await runImportTask('scheduled');
  });

  // 2. Ejecutar al inicio con RETRASO DE SEGURIDAD (Fix para error 429)
  // Esperamos 20 segundos antes de lanzar la primera petición al arrancar el contenedor
  const startupDelay = 20000; 
  
  logger.info(`GeonetImportScheduler: Initial import scheduled in ${startupDelay / 1000} seconds to avoid 429 blocks...`);
  
  setTimeout(() => {
    runImportTask('initial');
  }, startupDelay);

  return job;
}