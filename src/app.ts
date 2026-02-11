import express from 'express';
import multer from 'multer';
import { InstallationController } from './controllers/installation.controller';
import { TechnicianService } from './services/technician.service';

const app = express();
const upload = multer({ storage: multer.memoryStorage() });

app.use(express.json());

const installationController = new InstallationController();
const technicianService = new TechnicianService();

async function runDailyTechSync() {
  try {
    await technicianService.syncFromWeb();
  } catch (err) {
    console.error('Error running daily technician sync:', String(err));
  }
}

// Run once at startup, then at least once every 24 hours
runDailyTechSync();
setInterval(runDailyTechSync, 24 * 60 * 60 * 1000);

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