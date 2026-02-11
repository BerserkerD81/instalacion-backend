import { Router } from 'express';
import { TechnicianController } from '../controllers/technician.controller';

const router = Router();
const technicianController = new TechnicianController();

router.get('/', (req, res) => technicianController.getTechnicians(req, res));
router.post('/', (req, res) => technicianController.createTechnician(req, res));
router.put('/:id', (req, res) => technicianController.updateTechnician(req, res));
router.delete('/:id', (req, res) => technicianController.deleteTechnician(req, res));
router.post('/sync', (req, res) => technicianController.syncFromWeb(req, res));

export default router;
