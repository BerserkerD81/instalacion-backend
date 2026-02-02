import { DataSource } from 'typeorm';
import { InstallationRequest } from '../entities/InstallationRequest';

const AppDataSource = new DataSource({
  type: 'mysql',
  host: process.env.DB_HOST,
  port: parseInt(process.env.DB_PORT || '3306'),
  username: process.env.DB_USERNAME,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  synchronize: true,
  logging: false,
  entities: [InstallationRequest],
  migrations: [],
  subscribers: [],
});

export default AppDataSource;