import AppDataSource from '../database/data-source';
import { InstallationRequest } from '../entities/InstallationRequest';
import { FileService } from './file.service';
import { DeepPartial } from 'typeorm';
import fs from 'fs';
import logger from '../utils/logger';
import { wisphubConfig } from '../config';

type InstallationRequestInput = DeepPartial<InstallationRequest> & {
  idFront?: Buffer | string | null;
  idBack?: Buffer | string | null;
  addressProof?: Buffer | string | null;
  coupon?: Buffer | string | null;
};

export class InstallationService {
  private installationRepository = AppDataSource.getRepository(InstallationRequest);
  private fileService = new FileService();

  public async createRequest(data: InstallationRequestInput): Promise<InstallationRequest> {
    // Procesar archivos si existen
    if (data.idFront && Buffer.isBuffer(data.idFront)) {
      data.idFront = this.fileService.saveFile(data.idFront, 'idFront.jpg');
    }
    if (data.idBack && Buffer.isBuffer(data.idBack)) {
      data.idBack = this.fileService.saveFile(data.idBack, 'idBack.jpg');
    }
    if (data.addressProof && Buffer.isBuffer(data.addressProof)) {
      data.addressProof = this.fileService.saveFile(data.addressProof, 'addressProof.jpg');
    }
    if (data.coupon && Buffer.isBuffer(data.coupon)) {
      data.coupon = this.fileService.saveFile(data.coupon, 'coupon.jpg');
    }

    const request = this.installationRepository.create(data);
    const savedRequest = await this.installationRepository.save(request);
    await this.notifyWisphub(savedRequest);
    return savedRequest; // Return the saved request
  }

  public async getAllRequests(): Promise<InstallationRequest[]> {
    const requests = await this.installationRepository.find();
    return requests;
  }

  private async notifyWisphub(request: InstallationRequest): Promise<void> {
    const { apiUrl, apiKey } = wisphubConfig;
    if (!apiUrl || !apiKey) {
      logger.warn('Wisphub API config missing. Skipping external installation request.');
      return;
    }

    const FormDataCtor = (global as any).FormData as { new (): { append: (name: string, value: any, fileName?: string) => void } } | undefined;
    const fetchFn = (global as any).fetch as
      | ((input: string, init?: { method?: string; headers?: Record<string, string>; body?: any }) => Promise<{ ok: boolean; status: number; text: () => Promise<string> }>)
      | undefined;

    if (!FormDataCtor || !fetchFn) {
      logger.warn('Fetch/FormData not available in this runtime. Skipping Wisphub request.');
      return;
    }

    const form = new FormDataCtor();
    form.append('firstname', request.firstName || '');
    form.append('lastname', request.lastName || '');
    form.append('dni', request.ci || '');
    form.append('address', request.address || '');
    form.append('phone_number', request.phone || '');
    form.append('email', request.email || '');
    form.append('location', request.neighborhood || '');
    form.append('city', request.city || '');
    form.append('postal_code', request.postalCode || '');
    form.append('aditional_phone_number', request.additionalPhone || '');
    form.append('commentaries', request.comments || '');
    form.append('coordenadas', request.coordinates || '');

    this.appendFile(form, 'front_dni_proof', request.idFront);
    this.appendFile(form, 'back_dni_proof', request.idBack);
    this.appendFile(form, 'proof_of_address', request.addressProof);
    this.appendFile(form, 'discount_coupon', request.coupon);

    try {
      const response = await fetchFn(apiUrl, {
        method: 'POST',
        headers: {
          Authorization: `Api-Key ${apiKey}`,
        },
        body: form,
      });

      if (!response.ok) {
        const bodyText = await response.text();
        logger.error(`Wisphub API request failed: ${response.status} - ${bodyText}`);
      }
    } catch (error) {
      logger.error(`Wisphub API request failed: ${String(error)}`);
    }
  }

  private appendFile(
    form: { append: (name: string, value: any, fileName?: string) => void },
    field: string,
    fileName: string | null
  ): void {
    if (!fileName) return;
    const filePath = this.fileService.getFilePath(fileName);
    if (!fs.existsSync(filePath)) {
      logger.warn(`File not found for Wisphub upload: ${filePath}`);
      return;
    }
    const buffer = fs.readFileSync(filePath);
    form.append(field, buffer, fileName);
  }
}