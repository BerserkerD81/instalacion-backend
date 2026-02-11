import { Router } from 'express';
import multer from 'multer';
import { InstallationController } from '../controllers/installation.controller';

const router = Router();
const installationController = new InstallationController();
// Allow larger file uploads (e.g. up to 20MB per file)
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

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

// Route to lookup preinstallation activation link and ids
router.post('/preinstallations/lookup', (req, res) => installationController.lookupPreinstallation(req, res));

// Route to create a Geonet ticket
router.post(
	'/tickets/:ticketCategoryId',
	upload.single('archivo_ticket'),
	(req, res) => installationController.crearTicket(req, res)
);

// Route to delete a Geonet ticket by id
router.delete('/tickets/:ticketId', (req, res) => installationController.eliminarTicketGeonet(req, res));

// Alternate route: ticketCategoryId in body
router.post(
	'/tickets',
	upload.single('archivo_ticket'),
	(req, res) => installationController.crearTicket(req, res)
);

// Geonet: edit installation (partial update via merge of scraped form)
router.patch(
	'/geonet/installations/:externalIdOrUser/:installationId',
	(req, res) => installationController.editarInstalacionGeonet(req, res)
);

// Geonet: delete installation by externalId (scrape form + POST)
router.delete('/geonet/installations/:externalId', (req, res) => installationController.eliminarInstalacionGeonet(req, res));

// Wisphub: search ticket id by client full name (matches servicio.nombre)
router.get('/wisphub/tickets/search', (req, res) => installationController.buscarTicketWisphubPorCliente(req, res));

// Wisphub: list staff users (supports limit & offset)
router.get('/wisphub/staff', (req, res) => installationController.listarStaffWisphub(req, res));

// Wisphub: edit ticket (partial update). Supports optional file field `archivo_ticket`.
router.patch(
	'/wisphub/tickets/:ticketId',
	upload.single('archivo_ticket'),
	(req, res) => installationController.editarTicketWisphub(req, res)
);

export default router;