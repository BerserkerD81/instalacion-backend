import { Router } from 'express';
import installationRoutes from './installation.routes';
import technicianRoutes from './technician.routes';
import odbRoutes from './odb';

const router = Router();

router.use('/installations', installationRoutes);
router.use('/technicians', technicianRoutes);
router.use('/odb', odbRoutes); 


export default router;