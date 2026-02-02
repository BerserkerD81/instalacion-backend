import { Router } from 'express';
import { InstallationController } from '../controllers/installation.controller';

const router = Router();
const installationController = new InstallationController();

// Route to create a new installation request
router.post('/installations', installationController.createInstallationRequest);

// Route to get all installation requests
router.get('/installations', installationController.getInstallationRequests);

export default router;