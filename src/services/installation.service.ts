import AppDataSource from '../database/data-source';
import { InstallationRequest } from '../entities/InstallationRequest';
import { FileService } from './file.service';
import { DeepPartial } from 'typeorm';
import fs from 'fs';
import FormData from 'form-data';
import axios from 'axios';
import logger from '../utils/logger';
import { wisphubConfig } from '../config';

type InstallationRequestInput = DeepPartial<InstallationRequest> & {
  idFront?: Buffer | string | null;
  idBack?: Buffer | string | null;
  addressProof?: Buffer | string | null;
  coupon?: Buffer | string | null;
};

export class InstallationService {
  private fileService = new FileService();

  private async ensureDataSource(): Promise<void> {
    if (!AppDataSource.isInitialized) {
      await AppDataSource.initialize();
    }
  }

  public async createRequest(data: InstallationRequestInput): Promise<InstallationRequest> {
    await this.ensureDataSource();
    const installationRepository = AppDataSource.getRepository(InstallationRequest);

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

    const request = installationRepository.create(data);
    const savedRequest = await installationRepository.save(request);
    await this.notifyWisphub(savedRequest);
    return savedRequest; // Return the saved request
  }

  public async getAllRequests(): Promise<InstallationRequest[]> {
    await this.ensureDataSource();
    const installationRepository = AppDataSource.getRepository(InstallationRequest);
    const requests = await installationRepository.find();
    return requests;
  }

  private async notifyWisphub(request: InstallationRequest): Promise<void> {
    const { apiUrl, apiKey } = wisphubConfig;
    if (!apiUrl || !apiKey) {
      logger.warn('Wisphub API config missing. Skipping external installation request.');
      return;
    }

    const form = new FormData();

    const payload = {
      firstname: request.firstName || '',
      lastname: request.lastName || '',
      dni: request.ci || '',
      address: request.address || '',
      phone_number: request.phone || '',
      email: request.email || '',
      location: request.neighborhood || '',
      city: request.city || '',
      postal_code: request.postalCode || '',
      aditional_phone_number: request.additionalPhone || '',
      commentaries: request.comments || '',
      coordenadas: request.coordinates || '',
    };

    Object.entries(payload).forEach(([key, value]) => form.append(key, value));

    this.appendFile(form, 'front_dni_proof', request.idFront);
    this.appendFile(form, 'back_dni_proof', request.idBack);
    this.appendFile(form, 'proof_of_address', request.addressProof);
    this.appendFile(form, 'discount_coupon', request.coupon);

    const safeKey = apiKey.length > 12 ? `${apiKey.slice(0, 6)}...${apiKey.slice(-6)}` : '***';
    logger.info(
      `Wisphub POST ${apiUrl} apiKey=${safeKey} payload=${JSON.stringify({
        firstname: payload.firstname,
        lastname: payload.lastname,
        dni: payload.dni,
        email: payload.email,
        phone_number: payload.phone_number,
        city: payload.city,
        postal_code: payload.postal_code,
        has_front_dni_proof: Boolean(request.idFront),
        has_back_dni_proof: Boolean(request.idBack),
        has_proof_of_address: Boolean(request.addressProof),
        has_discount_coupon: Boolean(request.coupon),
      })}`
    );

    try {
      const response = await axios.post(apiUrl, form, {
        headers: {
          ...form.getHeaders(),
          Authorization: `Api-Key ${apiKey}`,
        },
        maxBodyLength: Infinity,
        validateStatus: () => true,
      });

      const bodyPreview =
        typeof response.data === 'string'
          ? response.data.slice(0, 800)
          : JSON.stringify(response.data).slice(0, 800);

      logger.info(`Wisphub response status=${response.status} body=${bodyPreview}`);

      if (response.status >= 400) {
        logger.error(`Wisphub API error status=${response.status}`);
      }
    } catch (err) {
      const error = err as any;
      const status = error?.response?.status;
      const data = error?.response?.data;
      const dataPreview = data ? (typeof data === 'string' ? data.slice(0, 800) : JSON.stringify(data).slice(0, 800)) : '';
      logger.error(`Wisphub API request failed status=${status ?? 'n/a'} data=${dataPreview} err=${String(error)}`);
    }
  }

  private appendFile(form: FormData, field: string, fileName: string | null): void {
    if (!fileName) return;
    const filePath = this.fileService.getFilePath(fileName);
    if (!fs.existsSync(filePath)) {
      logger.warn(`File not found for Wisphub upload: ${filePath}`);
      return;
    }
    form.append(field, fs.createReadStream(filePath) as any, fileName);
  }
}