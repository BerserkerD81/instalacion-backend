import { Router } from 'express';
import installationRoutes from './installation.routes';

const router = Router();

router.use('/installations', installationRoutes);

export default router;