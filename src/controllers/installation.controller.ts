import { Request, Response } from 'express';
import { InstallationService } from '../services/installation.service';

export class InstallationController {
  private installationService: InstallationService;

  constructor() {
    this.installationService = new InstallationService();
  }

  public async createInstallationRequest(req: Request, res: Response): Promise<Response> {
    try {
      const data = req.body;

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
    } catch (error) {
      return res.status(500).json({ message: 'Error creating installation request', error });
    }
  }

  public async getInstallationRequests(req: Request, res: Response): Promise<Response> {
    try {
      const requests = await this.installationService.getAllRequests();
      return res.status(200).json(requests);
    } catch (error) {
      return res.status(500).json({ message: 'Error retrieving installation requests', error });
    }
  }

}