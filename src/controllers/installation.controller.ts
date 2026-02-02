import { Request, Response } from 'express';
import { InstallationService } from '../services/installation.service';
import logger from '../utils/logger';

export class InstallationController {
  private installationService: InstallationService;

  constructor() {
    this.installationService = new InstallationService();
  }

  public async createInstallationRequest(req: Request, res: Response): Promise<Response> {
    try {
      const data = req.body;

      // Normalizar arrays que llegan como string en form-data
      if (typeof data.installationDates === 'string') {
        try {
          // soporta JSON stringified array o CSV
          const trimmed = data.installationDates.trim();
          data.installationDates = trimmed.startsWith('[')
            ? JSON.parse(trimmed)
            : trimmed.split(',').map((s: string) => s.trim()).filter(Boolean);
        } catch {
          data.installationDates = data.installationDates
            .split(',')
            .map((s: string) => s.trim())
            .filter(Boolean);
        }
      }

      // Procesar archivos si existen
      if (req.files) {
        const files = req.files as any;
        if (files.idFront) data.idFront = files.idFront[0].buffer;
        if (files.idBack) data.idBack = files.idBack[0].buffer;
        if (files.addressProof) data.addressProof = files.addressProof[0].buffer;
        if (files.coupon) data.coupon = files.coupon[0].buffer;
      }

      const installationRequest = await this.installationService.createRequest(data);
      return res.status(201).json(installationRequest);
    } catch (error: any) {
      logger.error(`Error creating installation request: ${String(error)}`);
      if (error.isWisphubError) {
        const status = error.status || 400;
        // forward Wisphub response body to client
        return res.status(status).json(error.data);
      }
      return res.status(500).json({ message: 'Error creating installation request' });
    }
  }

  public async getInstallationRequests(req: Request, res: Response): Promise<Response> {
    try {
      const requests = await this.installationService.getAllRequests();
      return res.status(200).json(requests);
    } catch (error) {
      logger.error(`Error retrieving installation requests: ${String(error)}`);
      return res.status(500).json({ message: 'Error retrieving installation requests' });
    }
  }

}