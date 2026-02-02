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

    // Procesar archivos: guardar temporalmente para adjuntar a Wisphub
    const savedFiles: string[] = [];
    try {
      if (data.idFront && Buffer.isBuffer(data.idFront)) {
        data.idFront = this.fileService.saveFile(data.idFront, 'idFront.jpg');
        savedFiles.push(String(data.idFront));
      }
      if (data.idBack && Buffer.isBuffer(data.idBack)) {
        data.idBack = this.fileService.saveFile(data.idBack, 'idBack.jpg');
        savedFiles.push(String(data.idBack));
      }
      if (data.addressProof && Buffer.isBuffer(data.addressProof)) {
        data.addressProof = this.fileService.saveFile(data.addressProof, 'addressProof.jpg');
        savedFiles.push(String(data.addressProof));
      }
      if (data.coupon && Buffer.isBuffer(data.coupon)) {
        data.coupon = this.fileService.saveFile(data.coupon, 'coupon.jpg');
        savedFiles.push(String(data.coupon));
      }

      // Llamar a Wisphub antes de persistir en la base de datos
      const wisphubResult = await this.notifyWisphub(data as any);
      if (!wisphubResult || (wisphubResult.status !== null && wisphubResult.status >= 400)) {
        // limpiar archivos guardados
        savedFiles.forEach((f) => this.fileService.deleteFile(f));
        const err: any = new Error('Wisphub error');
        err.isWisphubError = true;
        err.status = wisphubResult?.status ?? 502;
        err.data = wisphubResult?.data ?? { message: 'Wisphub request failed' };
        throw err;
      }

      // Persistir solo si Wisphub respondió OK
      const request = installationRepository.create(data as any);
      const savedRequest = await installationRepository.save(request as any);
      return savedRequest;
    } catch (e) {
      // Si ocurre cualquier error y hay archivos guardados, limpiarlos
      savedFiles.forEach((f) => {
        try {
          this.fileService.deleteFile(f);
        } catch {}
      });
      throw e;
    }
  }

  public async getAllRequests(): Promise<InstallationRequest[]> {
    await this.ensureDataSource();
    const installationRepository = AppDataSource.getRepository(InstallationRequest);
    const requests = await installationRepository.find();
    return requests;
  }

  private async notifyWisphub(request: InstallationRequest): Promise<{ status: number | null; data: any; skipped?: boolean }> {
    const { apiUrl, apiKey } = wisphubConfig;
    logger.info(`notifyWisphub: starting for request id=${request.id}`);
    logger.info(`notifyWisphub: apiUrl=${apiUrl || 'n/a'} apiKeyPresent=${Boolean(apiKey)}`);

    if (!apiUrl || !apiKey) {
      logger.warn('Wisphub API config missing. Skipping external installation request.');
      return { status: null, data: null, skipped: true };
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

    // Attach files and log which ones are being attached
    this.appendFile(form, 'front_dni_proof', request.idFront);
    this.appendFile(form, 'back_dni_proof', request.idBack);
    this.appendFile(form, 'proof_of_address', request.addressProof);
    this.appendFile(form, 'discount_coupon', request.coupon);

    logger.info(`notifyWisphub: payload summary=${JSON.stringify({
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
    })}`);

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
        logger.error(`Wisphub API error status=${response.status} body=${bodyPreview}`);
      }

      return { status: response.status, data: response.data };
    } catch (err) {
      const error = err as any;
      const status = error?.response?.status;
      const data = error?.response?.data;
      const dataPreview = data ? (typeof data === 'string' ? data.slice(0, 800) : JSON.stringify(data).slice(0, 800)) : '';
      logger.error(`Wisphub API request failed status=${status ?? 'n/a'} data=${dataPreview} err=${String(error)}`);
      return { status: status ?? null, data: data ?? { error: String(error) } };
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