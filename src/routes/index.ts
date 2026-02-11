import { Router } from 'express';
import installationRoutes from './installation.routes';
import technicianRoutes from './technician.routes';

const router = Router();

router.use('/installations', installationRoutes);
router.use('/technicians', technicianRoutes);

export default router;