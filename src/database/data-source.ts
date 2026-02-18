import { DataSource } from 'typeorm';
import { InstallationRequest } from '../entities/InstallationRequest';
import { Technician } from '../entities/Technician';
import { Agenda } from '../entities/Agenda';
import { SectorialNode } from '../entities/SectorialNode';
import logger from '../utils/logger';

const AppDataSource = new DataSource({
  type: 'mysql',
  host: process.env.DB_HOST,
  port: parseInt(process.env.DB_PORT || '3306'),
  username: process.env.DB_USERNAME,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  synchronize: true,
  logging: false,
  entities: [InstallationRequest, Technician, Agenda, SectorialNode],
  migrations: [],
  subscribers: [],
});

const DEFAULT_RETRY_ATTEMPTS = parseInt(process.env.DB_CONNECT_RETRIES || '10');
const DEFAULT_RETRY_DELAY_MS = parseInt(process.env.DB_CONNECT_RETRY_DELAY_MS || '2000');

export async function initializeDataSource(): Promise<void> {
  if (AppDataSource.isInitialized) return;

  let attempt = 0;
  while (true) {
    try {
      attempt += 1;
      await AppDataSource.initialize();
      logger.info(`Database connected after ${attempt} attempt(s)`);
      return;
    } catch (err) {
      const isLastAttempt = attempt >= DEFAULT_RETRY_ATTEMPTS;
      logger.error(`Database connection failed (attempt ${attempt}/${DEFAULT_RETRY_ATTEMPTS}): ${String(err)}`);

      if (isLastAttempt) {
        throw err;
      }

      await new Promise((resolve) => setTimeout(resolve, DEFAULT_RETRY_DELAY_MS));
    }
  }
}

export default AppDataSource;