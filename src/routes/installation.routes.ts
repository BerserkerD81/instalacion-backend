import { Router } from 'express';
import multer from 'multer';
import { InstallationController } from '../controllers/installation.controller';

const router = Router();
const installationController = new InstallationController();
const upload = multer({ storage: multer.memoryStorage() });

// Route to create a new installation request
router.post(
	'/',
	upload.fields([
		{ name: 'idFront', maxCount: 1 },
		{ name: 'idBack', maxCount: 1 },
		{ name: 'addressProof', maxCount: 1 },
		{ name: 'coupon', maxCount: 1 },
	]),
	(req, res) => installationController.createInstallationRequest(req, res)
);

// Route to get all installation requests
router.get('/', (req, res) => installationController.getInstallationRequests(req, res));

export default router;