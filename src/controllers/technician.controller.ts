import { Request, Response } from 'express';
import logger from '../utils/logger';
import { TechnicianService } from '../services/technician.service';
// Importaciones nuevas para el scraping
// Scraping moved to service

export class TechnicianController {
  private technicianService: TechnicianService;

  constructor() {
    this.technicianService = new TechnicianService();
  }

  // --- Métodos Existentes (Sin cambios) ---

  public async getTechnicians(req: Request, res: Response): Promise<Response> {
    try {
      const technicians = await this.technicianService.getAll();
      return res.status(200).json(technicians);
    } catch (error) {
      logger.error(`Error retrieving technicians: ${String(error)}`);
      return res.status(500).json({ message: 'Error retrieving technicians' });
    }
  }
  public async findByEmail(email: string): Promise<any | null> {
    const technicians = await this.technicianService.getAll();
    if (!technicians) return null;
    const match = technicians.find((t: any) => t.email === email);
    return match ?? null;
  }

  public async createTechnician(req: Request, res: Response): Promise<Response> {
    try {
      const data = req.body ?? {};
      if (!data.firstName || !data.lastName || !data.phone) {
        return res.status(400).json({ message: 'firstName, lastName and phone are required' });
      }

      const created = await this.technicianService.create(data);
      return res.status(201).json(created);
    } catch (error: any) {
      const msg = String(error);
      logger.error(`Error creating technician: ${msg}`);
      if (msg.includes('Duplicate') || msg.includes('duplicate') || msg.includes('ER_DUP_ENTRY')) {
        return res.status(409).json({ message: 'Technician phone already exists' });
      }
      return res.status(500).json({ message: 'Error creating technician' });
    }
  }

  public async updateTechnician(req: Request, res: Response): Promise<Response> {
    try {
      const id = Number(req.params.id);
      if (!Number.isFinite(id)) return res.status(400).json({ message: 'Invalid technician id' });

      const updated = await this.technicianService.update(id, req.body ?? {});
      if (!updated) return res.status(404).json({ message: 'Technician not found' });
      return res.status(200).json(updated);
    } catch (error: any) {
      const msg = String(error);
      logger.error(`Error updating technician: ${msg}`);
      if (msg.includes('Duplicate') || msg.includes('duplicate') || msg.includes('ER_DUP_ENTRY')) {
        return res.status(409).json({ message: 'Technician phone already exists' });
      }
      return res.status(500).json({ message: 'Error updating technician' });
    }
  }

  public async deleteTechnician(req: Request, res: Response): Promise<Response> {
    try {
      const id = Number(req.params.id);
      if (!Number.isFinite(id)) return res.status(400).json({ message: 'Invalid technician id' });

      const removed = await this.technicianService.remove(id);
      if (!removed) return res.status(404).json({ message: 'Technician not found' });
      return res.status(204).send();
    } catch (error) {
      logger.error(`Error deleting technician: ${String(error)}`);
      return res.status(500).json({ message: 'Error deleting technician' });
    }
  }

  // --- NUEVO MÉTODO DE SINCRONIZACIÓN ---

  public async syncFromWeb(req: Request, res: Response): Promise<Response> {
    try {
      const result = await this.technicianService.syncFromWeb();
      return res.status(200).json(result);
    } catch (error: any) {
      const msg = String(error);
      logger.error(`Error syncing technicians: ${msg}`);
      if (msg.includes('cookies')) {
        return res.status(400).json({ message: msg });
      }
      return res.status(500).json({ message: 'Error durante la sincronización web' });
    }
  }
}