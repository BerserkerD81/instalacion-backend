import { config } from 'dotenv';

config();

export const SMARTOLT = {
  baseUrl: process.env.SMARTOLT_BASE_URL || '',
  apiKey: process.env.SMARTOLT_API_KEY || ''
};


const environment = process.env.NODE_ENV || 'development';

const dbConfig = {
  host: process.env.DB_HOST,
  port: parseInt(process.env.DB_PORT || '3306', 10),
  username: process.env.DB_USERNAME,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
};

const appConfig = {
  port: parseInt(process.env.APP_PORT || process.env.PORT || '3000', 10),
};

const wisphubConfig = {
  apiUrl: process.env.WISPHUB_API_URL || 'https://api.wisphub.app/api/solicitar-instalacion/',
  apiKey: process.env.WISPHUB_API_KEY || '',
};

export { environment, dbConfig, appConfig, wisphubConfig };