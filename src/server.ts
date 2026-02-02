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
      const allowed = (process.env.CORS_ORIGIN || '*')
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
// Increase request body size limits to allow large form-data uploads (files)
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

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