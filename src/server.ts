import express from 'express';
import cors from 'cors';
import routes from './routes';
import errorHandler from './middlewares/errorHandler';
import { appConfig } from './config';

const app = express();

// Middleware
app.use(
  cors({
    origin: (origin: string | undefined, callback: (err: Error | null, allow?: boolean) => void) => {
      const allowed = (process.env.CORS_ORIGIN || 'http://localhost:8080')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);

      // allow non-browser clients (curl, server-to-server)
      if (!origin) return callback(null, true);
      if (allowed.includes('*') || allowed.includes(origin)) return callback(null, true);
      return callback(new Error(`CORS blocked for origin: ${origin}`));
    },
    credentials: true,
  })
);
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Routes
app.use('/api', routes);
app.use(routes);

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