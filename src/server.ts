import express from 'express';
import routes from './routes';
import errorHandler from './middlewares/errorHandler';
import { appConfig } from './config';

const app = express();

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Routes
app.use('/api', routes);

// Error handling middleware
app.use(errorHandler);

// Start the server
const PORT = appConfig.port || 3000;

const startServer = () => {
  app.listen(PORT, () => {
    console.log(`Server is running on http://localhost:${PORT}`);
  });
};

startServer();