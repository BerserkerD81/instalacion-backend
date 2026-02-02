import express from 'express';
import multer from 'multer';
import { InstallationController } from './controllers/installation.controller';

const app = express();
const upload = multer({ storage: multer.memoryStorage() });

app.use(express.json());

const installationController = new InstallationController();

app.post(
  '/installations',
  upload.fields([
    { name: 'idFront', maxCount: 1 },
    { name: 'idBack', maxCount: 1 },
    { name: 'addressProof', maxCount: 1 },
    { name: 'coupon', maxCount: 1 }
  ]),
  (req, res) => installationController.createInstallationRequest(req, res)
);

app.get('/installations', (req, res) => installationController.getInstallationRequests(req, res));

export default app;