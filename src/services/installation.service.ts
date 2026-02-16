import AppDataSource, { initializeDataSource } from '../database/data-source';
import { InstallationRequest } from '../entities/InstallationRequest';
import { Technician } from '../entities/Technician';
import { FileService } from './file.service';
import { DeepPartial } from 'typeorm';
import fs from 'fs';
import FormData from 'form-data';
import axios, { AxiosInstance } from 'axios';
import { wrapper } from 'axios-cookiejar-support';
import { Cookie, CookieJar } from 'tough-cookie';
import * as cheerio from 'cheerio';
import logger from '../utils/logger';
import { wisphubConfig } from '../config';

type InstallationRequestInput = DeepPartial<InstallationRequest> & {
  idFront?: Buffer | string | null;
  idBack?: Buffer | string | null;
  addressProof?: Buffer | string | null;
  coupon?: Buffer | string | null;
};

type GeonetTicketInput = {
  ticketCategoryId: number;
  fechaInicio: string;
  fechaFinal: string;
  tecnicoId?: string;
  tecnicoName?: string;
  asunto?: string;
  descripcion?: string;
  emailTecnico?: string;
  origenReporte?: string;
  estado?: string | number;
  prioridad?: string | number;
  asuntosDefault?: string;
  departamentosDefault?: string;
  departamento?: string;
  archivoTicket?: Buffer | string | null;
};

type WisphubTicketUpdateInput = {
  asuntosDefault?: string;
  asuntos_default?: string;
  asunto?: string;
  tecnico?: string;
  tecnicoId?: string;
  tecnicoName?: string;
  descripcion?: string;
  estado?: string | number;
  prioridad?: string | number;
  servicio?: string | number;
  fechaInicio?: string;
  fecha_inicio?: string;
  fechaFinal?: string;
  fecha_final?: string;
  origenReporte?: string;
  origen_reporte?: string;
  departamento?: string;
  emailTecnico?: string;
  email_tecnico?: string;
  archivoTicket?: Buffer | null;
};

export class InstallationService {
  private fileService = new FileService();
  private geonetClient: AxiosInstance | null = null;
  private geonetClientPromise: Promise<AxiosInstance> | null = null;
  private geonetClientCreatedAtMs = 0;

  private getWisphubOrigin(): string {
    const ticketsUrl = this.getWisphubTicketsUrl();
    try {
      return new URL(ticketsUrl).origin;
    } catch {
      return 'https://api.wisphub.app';
    }
  }

  private getWisphubTicketsUrl(): string {
    const { apiUrl } = wisphubConfig;
    try {
      const u = new URL(apiUrl);
      return `${u.origin}/api/tickets/`;
    } catch {
      return 'https://api.wisphub.app/api/tickets/';
    }
  }

  private getWisphubTicketDetailUrl(ticketId: string | number): string {
    const base = this.getWisphubTicketsUrl();
    const id = String(ticketId).trim();
    if (!id) return base;
    return base.endsWith('/') ? `${base}${encodeURIComponent(id)}/` : `${base}/${encodeURIComponent(id)}/`;
  }

  private async resolveWisphubStaffByName(params: {
    staffName: string;
    apiKey: string;
    maxPages?: number;
    limit?: number;
  }): Promise<{ id: string; nombre: string; email?: string } | null> {
    const { staffName, apiKey, maxPages = 20, limit = 50 } = params;
    const target = this.normalizeText(String(staffName || ''));
    if (!target) return null;

    const origin = this.getWisphubOrigin();
    let nextUrl: string | null = `${origin}/api/staff/?limit=${encodeURIComponent(String(limit))}&offset=0`;
    let pages = 0;

    let best: { id: string; nombre: string; email?: string; score: number } | null = null;

    while (nextUrl && pages < maxPages) {
      pages += 1;
      const resp = await axios.get(nextUrl, {
        headers: { Authorization: `Api-Key ${apiKey}` },
        validateStatus: () => true,
      });

      if (resp.status === 404) return null;
      if (resp.status < 200 || resp.status >= 300) return null;

      const data: any = resp.data;
      const results: any[] = Array.isArray(data?.results) ? data.results : Array.isArray(data) ? data : [];

      for (const item of results) {
        const id = item?.id !== undefined && item?.id !== null ? String(item.id).trim() : '';
        const nombre = item?.nombre ? String(item.nombre).trim() : '';
        const email = item?.email ? String(item.email).trim() : undefined;
        if (!id || !nombre) continue;

        const normalized = this.normalizeText(nombre);
        const score = this.calculateSimilarityScore(target, normalized);
        if (normalized === target) {
          return { id, nombre, email };
        }
        if (!best || score > best.score) {
          best = { id, nombre, email, score };
        }
      }

      nextUrl = typeof data?.next === 'string' && data.next ? data.next : null;
    }

    if (best && best.score >= 0.6) {
      return { id: best.id, nombre: best.nombre, email: best.email };
    }
    return null;
  }

  private async resolveWisphubTechnicianIdByName(params: {
    technicianName: string;
    apiKey: string;
    maxPages?: number;
  }): Promise<string> {
    const staff = await this.resolveWisphubStaffByName({
      staffName: params.technicianName,
      apiKey: params.apiKey,
      maxPages: params.maxPages,
    });
    return staff?.id ?? '';
  }

  public async listWisphubStaff(params: {
    limit?: number;
    offset?: number;
  }): Promise<{ status: number; data: any; url: string }> {
    const { apiKey } = wisphubConfig;
    if (!apiKey) {
      const err: any = new Error('Wisphub API config missing (WISPHUB_API_KEY)');
      err.statusCode = 500;
      throw err;
    }

    const origin = this.getWisphubOrigin();
    const u = new URL(`${origin}/api/staff/`);
    if (params.limit !== undefined && Number.isFinite(Number(params.limit))) {
      u.searchParams.set('limit', String(Number(params.limit)));
    }
    if (params.offset !== undefined && Number.isFinite(Number(params.offset))) {
      u.searchParams.set('offset', String(Number(params.offset)));
    }

    const url = u.toString();
    const response = await this.withRetry(
      () =>
        axios.get(url, {
          headers: { Authorization: `Api-Key ${apiKey}` },
          validateStatus: () => true,
        }),
      'GET Wisphub staff'
    );
    this.throwIfRetryableStatus(response, 'GET Wisphub staff');

    if (response.status < 200 || response.status >= 300) {
      const bodyPreview =
        typeof response.data === 'string'
          ? response.data.slice(0, 800)
          : JSON.stringify(response.data).slice(0, 800);
      const err: any = new Error(`Wisphub staff error status=${response.status}`);
      err.statusCode = 502;
      err.data = { status: response.status, bodyPreview };
      throw err;
    }

    return { status: response.status, data: response.data, url };
  }

  private async ensureDataSource(): Promise<void> {
    if (!AppDataSource.isInitialized) {
      await initializeDataSource();
    }
  }

  private invalidateGeonetClient(): void {
    this.geonetClient = null;
    this.geonetClientPromise = null;
    this.geonetClientCreatedAtMs = 0;
  }

  private async getGeonetClient(forceNew = false): Promise<AxiosInstance> {
    // Keep a cached logged-in client to reduce 429s from repeated logins.
    // If auth expires, we invalidate + re-login.
    const maxAgeMs = 25 * 60 * 1000;
    const isFresh = this.geonetClient && Date.now() - this.geonetClientCreatedAtMs < maxAgeMs;

    if (forceNew) {
      this.invalidateGeonetClient();
    }

    if (!forceNew && isFresh && this.geonetClient) {
      return this.geonetClient;
    }

    if (!forceNew && this.geonetClientPromise) {
      return this.geonetClientPromise;
    }

    this.geonetClientPromise = this.createGeonetClient();
    try {
      const client = await this.geonetClientPromise;
      this.geonetClient = client;
      this.geonetClientCreatedAtMs = Date.now();
      return client;
    } finally {
      this.geonetClientPromise = null;
    }
  }

  private isGeonetLoginResponse(response: any): boolean {
    const status = response?.status;
    const location = String(response?.headers?.location || '');
    if (status === 301 || status === 302 || status === 303 || status === 307 || status === 308) {
      if (location.includes('/accounts/login')) return true;
    }

    const data = response?.data;
    if (typeof data !== 'string') return false;

    const html = data.toLowerCase();
    // Heuristics: login form + login url
    if (html.includes('/accounts/login') && (html.includes('name="login"') || html.includes('name="password"'))) {
      return true;
    }
    if (html.includes('id="login"') && html.includes('csrfmiddlewaretoken') && html.includes('password')) {
      return true;
    }
    return false;
  }

  private throwIfGeonetAuthRequired(response: any, label: string): void {
    if (!response) return;
    if (!this.isGeonetLoginResponse(response)) return;

    const err: any = new Error(`${label}: sesión Geonet expirada / requiere login`);
    err.isGeonetAuthError = true;
    err.statusCode = 401;
    err.response = response;
    throw err;
  }

  private async withGeonetRelogin<T>(label: string, fn: (client: AxiosInstance) => Promise<T>): Promise<T> {
    const attempts = 2;
    let lastErr: any;

    for (let attempt = 1; attempt <= attempts; attempt++) {
      const forceNew = attempt > 1;
      const client = await this.getGeonetClient(forceNew);

      try {
        return await fn(client);
      } catch (err: any) {
        lastErr = err;
        if (err?.isGeonetAuthError && attempt < attempts) {
          logger.warn(`${label}: auth error, re-login y reintento (attempt ${attempt + 1}/${attempts})`);
          this.invalidateGeonetClient();
          continue;
        }
        throw err;
      }
    }

    throw lastErr;
  }

  public async createRequest(data: InstallationRequestInput): Promise<InstallationRequest> {
    await this.ensureDataSource();
    const installationRepository = AppDataSource.getRepository(InstallationRequest);

    if (data.plan !== undefined) {
      logger.info(`createRequest: received plan=${String(data.plan)}`);
    } else {
      logger.warn('createRequest: plan missing in request payload');
    }

    // Procesar archivos: guardar temporalmente para adjuntar a Wisphub
    const savedFiles: string[] = [];
    try {
      // Normalizar RUT/CI: quitar puntos y, si termina en "-k", convertir la k a mayúscula
      if (data.ci !== undefined && data.ci !== null) {
        try {
          data.ci = this.normalizeCedula(String(data.ci));
        } catch {}
      }
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
      const request = installationRepository.create({
        ...(data as any),
        plan: data.plan !== undefined && data.plan !== null ? String(data.plan) : null,
      });
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

  public async lookupPreinstallationActivation(params: {
    clientName: string;
    technicianName: string;
    planName?: string;
    installationRequestId?: number;
    zonaName?: string;
    routerName?: string;
    apName?: string;
  }): Promise<{
    activationLink: string;
    technicianId: string;
    planId: string;
    firstAvailableIp: string | null;
    activationPostStatus?: number;
  }> {
    const { clientName, technicianName, planName, installationRequestId } = params;
    let effectivePlanName = planName;
    let resolvedRequestId: number | undefined = installationRequestId;
    let resolvedRequest: InstallationRequest | null = null;

    if (resolvedRequestId === undefined) {
      resolvedRequestId = await this.findInstallationRequestIdByClientName(clientName);
    }

    if (resolvedRequestId !== undefined) {
      resolvedRequest = await this.findInstallationRequestById(resolvedRequestId);
      if (resolvedRequest?.plan) {
        effectivePlanName = resolvedRequest.plan;
      }
    }

    if (resolvedRequestId === undefined || !resolvedRequest) {
      const err: any = new Error('No se encontró la InstallationRequest en la base de datos');
      err.statusCode = 404;
      throw err;
    }

    if (!effectivePlanName) {
      const err: any = new Error('planName no encontrado. Debe existir en la columna plan del cliente');
      err.statusCode = 400;
      throw err;
    }
    return this.withGeonetRelogin('lookupPreinstallationActivation', async (client) => {
      const preinstUrl = 'https://admin.geonet.cl/preinstalaciones/';
      const listResp = await this.withRetry(
        () =>
          client.get(preinstUrl, {
            headers: { 'User-Agent': 'Mozilla/5.0 (Node.js Scraper)' },
            validateStatus: () => true,
          }),
        'GET preinstalaciones'
      );
      this.throwIfRetryableStatus(listResp, 'GET preinstalaciones');
      this.throwIfGeonetAuthRequired(listResp, 'GET preinstalaciones');
      if (listResp.status < 200 || listResp.status >= 300) {
        const err: any = new Error(`GET preinstalaciones status=${listResp.status}`);
        err.statusCode = 502;
        throw err;
      }

      const listHtml = listResp.data;
      const list$ = cheerio.load(listHtml);
      const targetClient = this.normalizeText(clientName);
      const targetTokens = targetClient.split(' ').filter(Boolean);
      logger.info(
        `lookupPreinstallationActivation: targetClient="${targetClient}" tokens=${JSON.stringify(targetTokens)}`
      );

      let activationLink = '';
      list$('a[href*="/preinstalacion/activar/"]').each((_, el) => {
        const href = list$(el).attr('href') || '';
        const rowText = list$(el).closest('tr').text();
        const normalizedRow = this.normalizeText(rowText);
        const tokensMatch = targetTokens.length === 0 || targetTokens.every((t) => normalizedRow.includes(t));
        if (tokensMatch) {
          activationLink = href.startsWith('http') ? href : `https://admin.geonet.cl${href}`;
          return false;
        }
        return undefined;
      });

      if (!activationLink) {
        const err: any = new Error('No se encontró el enlace de activación para el cliente indicado');
        err.statusCode = 404;
        throw err;
      }

      const activationResp = await this.withRetry(
        () =>
          client.get(activationLink, {
            headers: { 'User-Agent': 'Mozilla/5.0 (Node.js Scraper)' },
            validateStatus: () => true,
          }),
        'GET activacion'
      );
      this.throwIfRetryableStatus(activationResp, 'GET activacion');
      this.throwIfGeonetAuthRequired(activationResp, 'GET activacion');
      if (activationResp.status < 200 || activationResp.status >= 300) {
        const err: any = new Error(`GET activacion status=${activationResp.status}`);
        err.statusCode = 502;
        throw err;
      }

      const $ = cheerio.load(activationResp.data);
      const techSelect = this.findSelect($, 'tecnico');
      logger.info(
        `lookupPreinstallationActivation: available technicians=${JSON.stringify(this.extractOptionTexts(techSelect))}`
      );
      logger.info(`lookupPreinstallationActivation: tecnico select HTML=${techSelect.html() || ''}`);
      const planSelect = this.findSelect($, 'plan');

      const technicianId = this.findOptionId(techSelect, technicianName);
      logger.info(`lookupPreinstallationActivation: plan from request record="${effectivePlanName}"`);
      logger.info(
        `lookupPreinstallationActivation: available plans=${JSON.stringify(this.extractOptionTexts(planSelect))}`
      );
      const planId = this.findOptionId(planSelect, effectivePlanName);
      const firstAvailableIp = this.findFirstAvailableIp($);

      if (!technicianId) {
        const err: any = new Error('No se encontró el técnico indicado en la preinstalación');
        err.statusCode = 404;
        throw err;
      }

      if (!planId) {
        const err: any = new Error('No se encontró el plan indicado en la preinstalación');
        err.statusCode = 404;
        throw err;
      }

      const activationPostStatus = await this.submitGeonetActivation({
        client,
        activationLink,
        technicianId,
        planId,
        firstAvailableIp,
        installationRequestId: resolvedRequestId,
        zonaName: params.zonaName,
        routerName: params.routerName,
        apName: params.apName,
      });

      return { activationLink, technicianId, planId, firstAvailableIp, activationPostStatus };
    });
  }

  public async crearTicket(params: GeonetTicketInput): Promise<{
    status: number;
    location?: string;
    responsePreview?: string;
    resolvedTecnicoId?: string;
    resolvedEmailTecnico?: string;
    formErrors?: string[];
    missingRequiredFields?: string[];
  }> {
    const {
      ticketCategoryId,
      fechaInicio,
      fechaFinal,
      tecnicoId,
      tecnicoName,
      asunto = 'Reinstalación de servicio',
      descripcion = '',
      emailTecnico = '',
      origenReporte = 'oficina',
      estado = 1,
      prioridad = 1,
      asuntosDefault = 'Otro Asunto',
      departamentosDefault = 'Otro',
      departamento = 'Otro',
      archivoTicket = null,
    } = params;

    const ticketUrl = `https://admin.geonet.cl/tickets/agregar/${ticketCategoryId}/`;

    return this.withGeonetRelogin('crearTicket', async (client) => {
      let tempSavedFileName: string | null = null;
      try {
        const ticketFormPage = await this.withRetry(
          () =>
            client.get(ticketUrl, {
              headers: { 'User-Agent': 'Mozilla/5.0 (Node.js Scraper)' },
              validateStatus: () => true,
            }),
          'GET ticket (csrf)'
        );
        this.throwIfRetryableStatus(ticketFormPage, 'GET ticket (csrf)');
        this.throwIfGeonetAuthRequired(ticketFormPage, 'GET ticket (csrf)');
        if (ticketFormPage.status < 200 || ticketFormPage.status >= 300) {
          const err: any = new Error(`GET ticket status=${ticketFormPage.status}`);
          err.statusCode = 502;
          throw err;
        }

      const $ = cheerio.load(ticketFormPage.data);
      const csrfToken = $('input[name="csrfmiddlewaretoken"]').attr('value') || '';
      logger.info(
        `crearTicket: asuntos available=${JSON.stringify(this.extractOptionTexts(this.findSelect($, 'asuntos_default')))}`
      );
      logger.info(
        `crearTicket: departamentos available=${JSON.stringify(this.extractOptionTexts(this.findSelect($, 'departamento')))}`
      );
      if (!csrfToken) {
        const err: any = new Error('No se encontró csrfmiddlewaretoken en el formulario de ticket');
        err.statusCode = 502;
        throw err;
      }

      // Resolve technician id from provided id, name or email (values are numeric ids in the <select>)
      let resolvedTecnicoId = (tecnicoId ?? '').trim();
      const techSelect = this.findSelect($, 'tecnico');
      if (!resolvedTecnicoId) {
        // Try by name first if provided
        if (tecnicoName && String(tecnicoName).trim()) {
          resolvedTecnicoId = this.findOptionId(techSelect, String(tecnicoName));
        }

        // If still not found, try resolving by email (loose matching supported)
        if (!resolvedTecnicoId && emailTecnico && String(emailTecnico).trim()) {
          resolvedTecnicoId = this.findOptionId(techSelect, String(emailTecnico));
          if (resolvedTecnicoId) {
            logger.info(
              `crearTicket: resolved tecnicoId=${resolvedTecnicoId} by email=${String(emailTecnico)}`
            );
          }
        }

        if (!resolvedTecnicoId) {
          const err: any = new Error('Debe enviar tecnicoId (tecnico), tecnicoName o emailTecnico; no se encontró técnico');
          err.statusCode = 400;
          throw err;
        }
      }

      // Resolve email from DB when not provided (best effort)
      let resolvedEmailTecnico = (emailTecnico ?? '').trim();
      if (!resolvedEmailTecnico) {
        const nameFromSelect = this.findOptionTextByValue(techSelect, resolvedTecnicoId);
        const emailFromOption = this.extractEmailFromText(nameFromSelect);
        if (emailFromOption) {
          resolvedEmailTecnico = emailFromOption;
        }
        const emailFromDb = await this.findTechnicianEmailByName(
          String(tecnicoName || nameFromSelect || '').trim()
        );
        if (emailFromDb) resolvedEmailTecnico = emailFromDb;
      }

      // Build base form from HTML to include hidden/default/required fields that the server expects
      const ticketFormEl = this.findFormWithCsrf($);
      const baseFields = this.extractFormFields($, ticketFormEl);

      const descripcionTrimmed = String(descripcion ?? '').trim();
      const descripcionToSend = descripcionTrimmed || baseFields.descripcion || 'Ticket generado automáticamente.';
      const emailToSend =
        resolvedEmailTecnico || baseFields.email_tecnico || baseFields.emailTecnico || baseFields.email || '';

      const form = new FormData();
      // Start with all fields found in the HTML
      Object.entries(baseFields).forEach(([key, value]) => {
        if (value === undefined || value === null) return;
        form.append(key, String(value));
      });
      // Override with our intended values
      form.append('csrfmiddlewaretoken', csrfToken);
      form.append('asuntos_default', asuntosDefault);
      form.append('asunto', asunto);
      form.append('tecnico', resolvedTecnicoId);
      form.append('departamentos_default', departamentosDefault);
      form.append('departamento', departamento);
      form.append('origen_reporte', origenReporte);
      // Only override email if we actually have one; otherwise keep whatever the form had
      if (emailToSend) {
        form.append('email_tecnico', emailToSend);
      }
      form.append('descripcion', descripcionToSend);

      const toGeonetDate = (val: any): string | any => {
        if (val === undefined || val === null) return val;
        const raw = String(val).trim();
        if (!raw) return raw;
        // If ISO-like `YYYY-MM-DDTHH:MM[:SS]`, convert to `DD/MM/YYYY HH:MM` using the same numeric components
        const iso = raw.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
        if (iso) {
          const [, yyyy, mm, dd, hh, min] = iso;
          return `${dd}/${mm}/${yyyy} ${hh}:${min}`;
        }
        // If already in D/M/YYYY H:MM or DD/MM/YYYY HH:MM, normalize padding
        const dm = raw.match(/^([0-3]?\d)\/([0-1]?\d)\/(\d{4})\s+(\d{1,2}):(\d{2})$/);
        if (dm) {
          const [, d, m, y, h, mi] = dm;
          return `${String(d).padStart(2, '0')}/${String(m).padStart(2, '0')}/${y} ${String(h).padStart(2, '0')}:${mi}`;
        }
        return raw;
      };

      const fechaInicioToSend = toGeonetDate(fechaInicio);
      const fechaFinalToSend = toGeonetDate(fechaFinal);
      if (fechaInicioToSend !== fechaInicio) {
        logger.info(`crearTicket: converted fecha_inicio "${fechaInicio}" -> "${fechaInicioToSend}"`);
      }
      if (fechaFinalToSend !== fechaFinal) {
        logger.info(`crearTicket: converted fecha_final "${fechaFinal}" -> "${fechaFinalToSend}"`);
      }

      form.append('fecha_inicio', fechaInicioToSend);
      form.append('fecha_final', fechaFinalToSend);
      form.append('estado', String(estado));
      form.append('prioridad', String(prioridad));

      if (archivoTicket) {
        let savedFileName: string | null = null;
        if (Buffer.isBuffer(archivoTicket)) {
          tempSavedFileName = this.fileService.saveFile(archivoTicket, 'archivo_ticket.bin');
          savedFileName = tempSavedFileName;
        } else {
          savedFileName = archivoTicket;
        }

        if (savedFileName) {
          const filePath = this.fileService.getFilePath(savedFileName);
          if (fs.existsSync(filePath)) {
            form.append('archivo_ticket', fs.createReadStream(filePath) as any, savedFileName);
          } else {
            logger.warn(`crearTicket: archivo_ticket no existe en ${filePath}`);
          }
        }
      }

      const response = await this.withRetry(
        () =>
          client.post(ticketUrl, form, {
            headers: {
              ...form.getHeaders(),
              Origin: 'https://admin.geonet.cl',
              Referer: ticketUrl,
              'User-Agent': 'Mozilla/5.0 (Node.js Scraper)',
              'X-CSRFToken': csrfToken,
            },
            maxBodyLength: Infinity,
            maxRedirects: 0,
            validateStatus: () => true,
          }),
        'POST crear ticket'
      );

      // Force retry on rate limits / transient gateway issues even when validateStatus always returns true
      this.throwIfRetryableStatus(response, 'POST crear ticket');
      this.throwIfGeonetAuthRequired(response, 'POST crear ticket');

      const responsePreview =
        typeof response.data === 'string'
          ? response.data.slice(0, 800)
          : JSON.stringify(response.data).slice(0, 800);

      const locationHeader = response.headers?.location;
      logger.info(
        `crearTicket: POST status=${response.status} location=${locationHeader || 'n/a'} body=${responsePreview}`
      );

      let formErrors: string[] | undefined;
      let missingRequiredFields: string[] | undefined;
      if (typeof response.data === 'string' && response.data.includes('<form')) {
        try {
          const $formDoc = cheerio.load(response.data);
          const parsed = this.parseDjangoFormErrors($formDoc, 'form');
          formErrors = parsed.errorTexts;
          missingRequiredFields = parsed.missingRequired;
          if (formErrors.length > 0) {
            logger.warn(`crearTicket: errores formulario=${JSON.stringify(formErrors.slice(0, 30))}`);
          }
          if (missingRequiredFields.length > 0) {
            logger.warn(`crearTicket: faltan requeridos=${JSON.stringify(missingRequiredFields)}`);
          }
        } catch (parseErr) {
          logger.warn(`crearTicket: parse de HTML falló: ${String(parseErr)}`);
        }
      }

        return {
          status: response.status,
          location: locationHeader,
          responsePreview,
          resolvedTecnicoId,
          resolvedEmailTecnico,
          formErrors,
          missingRequiredFields,
        };
      } finally {
        if (tempSavedFileName) {
          try {
            this.fileService.deleteFile(tempSavedFileName);
          } catch {}
        }
      }
    });
  }

  public async eliminarTicketGeonet(params: {
    ticketId: string | number;
  }): Promise<{
    status: number;
    location?: string;
    responsePreview?: string;
    formErrors?: string[];
  }> {
    const ticketId = String(params.ticketId ?? '').trim();
    if (!ticketId) {
      const err: any = new Error('ticketId es requerido');
      err.statusCode = 400;
      throw err;
    }

    return this.withGeonetRelogin('eliminarTicketGeonet', async (client) => {
      const deleteUrl = `https://admin.geonet.cl/tickets/eliminar/${ticketId}/`;

      const deletePage = await this.withRetry(
        () =>
          client.get(deleteUrl, {
            headers: { 'User-Agent': 'Mozilla/5.0 (Node.js Scraper)' },
            validateStatus: () => true,
          }),
        'GET eliminar ticket (csrf)'
      );

      this.throwIfRetryableStatus(deletePage, 'GET eliminar ticket (csrf)');
      this.throwIfGeonetAuthRequired(deletePage, 'GET eliminar ticket (csrf)');

      if (deletePage.status < 200 || deletePage.status >= 300) {
        const bodyPreview =
          typeof deletePage.data === 'string'
            ? deletePage.data.slice(0, 800)
            : JSON.stringify(deletePage.data).slice(0, 800);
        const err: any = new Error(`No se pudo cargar página de eliminar ticket status=${deletePage.status}`);
        err.statusCode = 502;
        err.data = { status: deletePage.status, bodyPreview };
        throw err;
      }

      const $ = cheerio.load(deletePage.data);
      const csrfToken = $('input[name="csrfmiddlewaretoken"]').attr('value') || '';
      if (!csrfToken) {
        const err: any = new Error('No se encontró csrfmiddlewaretoken en el formulario de eliminar ticket');
        err.statusCode = 502;
        throw err;
      }

      const formEl = this.findFormWithCsrf($);
      const baseFields = this.extractFormFields($, formEl);

      const form = new URLSearchParams();
      Object.entries(baseFields).forEach(([key, value]) => {
        if (value === undefined || value === null) return;
        form.append(key, String(value));
      });
      form.set('csrfmiddlewaretoken', csrfToken);

      const response = await this.withRetry(
        () =>
          client.post(deleteUrl, form.toString(), {
            headers: {
              'Content-Type': 'application/x-www-form-urlencoded',
              Origin: 'https://admin.geonet.cl',
              Referer: deleteUrl,
              'User-Agent': 'Mozilla/5.0 (Node.js Scraper)',
              'X-CSRFToken': csrfToken,
            },
            maxRedirects: 0,
            validateStatus: () => true,
          }),
        'POST eliminar ticket'
      );

      this.throwIfRetryableStatus(response, 'POST eliminar ticket');
      this.throwIfGeonetAuthRequired(response, 'POST eliminar ticket');

    const responsePreview =
      typeof response.data === 'string'
        ? response.data.slice(0, 800)
        : JSON.stringify(response.data).slice(0, 800);

    const locationHeader = response.headers?.location;
    logger.info(
      `eliminarTicketGeonet: POST status=${response.status} location=${locationHeader || 'n/a'} body=${responsePreview}`
    );

    let formErrors: string[] | undefined;
    if (typeof response.data === 'string' && response.data.includes('<form')) {
      try {
        const $formDoc = cheerio.load(response.data);
        const parsed = this.parseDjangoFormErrors($formDoc, 'form');
        formErrors = parsed.errorTexts;
        if (formErrors.length > 0) {
          logger.warn(`eliminarTicketGeonet: errores formulario=${JSON.stringify(formErrors.slice(0, 30))}`);
        }
      } catch (parseErr) {
        logger.warn(`eliminarTicketGeonet: parse de HTML falló: ${String(parseErr)}`);
      }
    }

      return {
        status: response.status,
        location: locationHeader,
        responsePreview,
        formErrors,
      };
    });
  }

  public async editarInstalacionGeonet(params: {
    externalIdOrUser: string;
    installationId: string | number;
    updates: Record<string, any>;
  }): Promise<{
    status: number;
    location?: string;
    responsePreview?: string;
    url: string;
    appliedFields: string[];
    formErrors?: string[];
    missingRequiredFields?: string[];
  }> {
    const externalIdOrUser = String(params.externalIdOrUser ?? '').trim();
    const installationId = String(params.installationId ?? '').trim();
    if (!externalIdOrUser || !installationId) {
      const err: any = new Error('externalIdOrUser e installationId son requeridos');
      err.statusCode = 400;
      throw err;
    }

    const safeUpdates: Record<string, any> =
      params.updates && typeof params.updates === 'object' ? (params.updates as any) : {};

    // Nunca permitimos que el caller inyecte csrf desde afuera.
    delete (safeUpdates as any).csrfmiddlewaretoken;

    const url = `https://admin.geonet.cl/Instalaciones/editar/${encodeURIComponent(externalIdOrUser)}/${encodeURIComponent(
      installationId
    )}/`;

    return this.withGeonetRelogin('editarInstalacionGeonet', async (client) => {
      const editPage = await this.withRetry(
        () =>
          client.get(url, {
            headers: { 'User-Agent': 'Mozilla/5.0 (Node.js Scraper)' },
            validateStatus: () => true,
          }),
        'GET editar instalacion (csrf)'
      );

      this.throwIfRetryableStatus(editPage, 'GET editar instalacion (csrf)');
      this.throwIfGeonetAuthRequired(editPage, 'GET editar instalacion (csrf)');

      if (editPage.status < 200 || editPage.status >= 300) {
        const bodyPreview =
          typeof editPage.data === 'string'
            ? editPage.data.slice(0, 800)
            : JSON.stringify(editPage.data).slice(0, 800);
        const err: any = new Error(`No se pudo cargar formulario de edición status=${editPage.status}`);
        err.statusCode = 502;
        err.data = { status: editPage.status, bodyPreview };
        throw err;
      }

      const $ = cheerio.load(editPage.data);
      const csrfToken = $('input[name="csrfmiddlewaretoken"]').attr('value') || '';
      if (!csrfToken) {
        const err: any = new Error('No se encontró csrfmiddlewaretoken en el formulario de edición');
        err.statusCode = 502;
        throw err;
      }

      const formEl = this.findFormWithCsrf($);

      // Para editar de forma “parcial”, construimos el POST con todos los campos actuales del formulario
      // y sobre-escribimos solo los campos indicados en `updates`.
      const baseFields: Record<string, string> = {};
      const scope = formEl && formEl.length > 0 ? formEl : $('form').first();

      // inputs (incluye vacíos; excluye file/submit/button; checkbox/radio solo si checked)
      scope.find('input').each((_i, el) => {
        const $el = $(el);
        const name = $el.attr('name');
        if (!name) return undefined;
        const type = String($el.attr('type') || '').toLowerCase();
        if (type === 'submit' || type === 'button' || type === 'file') return undefined;
        if (type === 'checkbox' || type === 'radio') {
          if (!$el.is(':checked')) return undefined;
        }
        baseFields[name] = String($el.attr('value') ?? '');
        return undefined;
      });

      // textareas (incluye vacíos)
      scope.find('textarea').each((_i, el) => {
        const $el = $(el);
        const name = $el.attr('name');
        if (!name) return undefined;
        baseFields[name] = ($el.text() ?? '').toString();
        return undefined;
      });

      // selects (usa opción selected o primer valor válido)
      scope.find('select').each((_i, el) => {
        const $el = $(el);
        const name = $el.attr('name');
        if (!name) return undefined;
        const selected = $el.find('option[selected]').first();
        let value = selected.attr('value');
        if (!value) {
          const firstValid = $el
            .find('option')
            .filter((_j, opt) => {
              const v = String($(opt).attr('value') || '').trim();
              const t = String($(opt).text() || '').trim();
              if (!v) return false;
              if (!t) return true;
              return !t.includes('---------');
            })
            .first();
          value = firstValid.attr('value');
        }
        baseFields[name] = value ? String(value) : '';
        return undefined;
      });

      // Si el caller envió un nombre de técnico en lugar del id, intentar resolverlo
      // primero usando la API Wisphub (más fiable), luego fallback al <select> del formulario.
      try {
        const techNameCandidate =
          safeUpdates && (safeUpdates.tecnicoName || safeUpdates.tecnicoNombre)
            ? String(safeUpdates.tecnicoName || safeUpdates.tecnicoNombre).trim()
            : '';
        if (techNameCandidate) {
          try {
            const { apiKey } = wisphubConfig;
            if (apiKey) {
              const resolvedFromWisphub = await this.resolveWisphubTechnicianIdByName({
                technicianName: techNameCandidate,
                apiKey,
              });
              if (resolvedFromWisphub) {
                safeUpdates.tecnico = resolvedFromWisphub;
              }
            }
          } catch (wisErr) {
            logger.warn(`editarInstalacionGeonet: Wisphub lookup failed: ${String(wisErr)}`);
          }

          // Fallback: try matching against the select in the page we already fetched
          if (!safeUpdates.tecnico) {
            const techSelect = this.findSelect($, 'tecnico');
            const resolved = this.findOptionId(techSelect, techNameCandidate);
            if (resolved) safeUpdates.tecnico = resolved;
          }
        }
      } catch (err) {
        logger.warn(`editarInstalacionGeonet: fallo resolviendo tecnico por nombre: ${String(err)}`);
      }

      // Antes de postear, recargar la página para obtener los valores/CSRF más recientes
      try {
        const freshPage = await this.withRetry(
          () =>
            client.get(url, {
              headers: { 'User-Agent': 'Mozilla/5.0 (Node.js Scraper)' },
              validateStatus: () => true,
            }),
          'GET editar instalacion (confirmación antes de POST)'
        );
        if (freshPage && freshPage.status >= 200 && freshPage.status < 300 && typeof freshPage.data === 'string') {
          const $fresh = cheerio.load(freshPage.data);
          const freshCsrf = $fresh('input[name="csrfmiddlewaretoken"]').attr('value') || csrfToken;
          const freshFormEl = this.findFormWithCsrf($fresh);
          const freshBaseFields = this.extractFormFields($fresh, freshFormEl);
          // Replace baseFields with fresh values and update csrfToken
          Object.keys(baseFields).forEach((k) => delete baseFields[k]);
          Object.entries(freshBaseFields).forEach(([k, v]) => {
            baseFields[k] = v as string;
          });
          baseFields['csrfmiddlewaretoken'] = freshCsrf;
        }
      } catch (err) {
        logger.warn(`editarInstalacionGeonet: no se pudo recargar página antes de POST: ${String(err)}`);
      }

      // Normalizar fechas al formato esperado por Geonet: `DD/MM/YYYY HH:MM`.
      const toGeonetDate = (val: any): string | any => {
        if (val === undefined || val === null) return val;
        const raw = String(val).trim();
        if (!raw) return raw;
        // If ISO-like `YYYY-MM-DDTHH:MM[:SS]`, convert to `DD/MM/YYYY HH:MM`
        const iso = raw.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
        if (iso) {
          const [, yyyy, mm, dd, hh, min] = iso;
          return `${dd}/${mm}/${yyyy} ${hh}:${min}`;
        }
        // If already in D/M/YYYY H:MM or DD/MM/YYYY HH:MM, normalize padding
        const dm = raw.match(/^([0-3]?\d)\/([0-1]?\d)\/(\d{4})\s+(\d{1,2}):(\d{2})$/);
        if (dm) {
          const [, d, m, y, h, mi] = dm;
          return `${String(d).padStart(2, '0')}/${String(m).padStart(2, '0')}/${y} ${String(h).padStart(2, '0')}:${mi}`;
        }
        // If two-digit year like DD/MM/YY H:MM or DD/MM/YY HH:MM, expand to 20YY
        const dm2 = raw.match(/^([0-3]?\d)\/([0-1]?\d)\/(\d{2})\s+(\d{1,2}):(\d{2})$/);
        if (dm2) {
          const [, d, m, y2, h, mi] = dm2;
          const y = `20${y2}`;
          return `${String(d).padStart(2, '0')}/${String(m).padStart(2, '0')}/${y} ${String(h).padStart(2, '0')}:${mi}`;
        }
        return raw;
      };

      // Convertir si el caller envió fechas en formatos ISO o con año corto
      if (safeUpdates && safeUpdates.fecha_inicio !== undefined && safeUpdates.fecha_inicio !== null) {
        const converted = toGeonetDate(safeUpdates.fecha_inicio);
        if (converted !== safeUpdates.fecha_inicio) {
          logger.info(`editarInstalacionGeonet: converted fecha_inicio "${safeUpdates.fecha_inicio}" -> "${converted}"`);
          safeUpdates.fecha_inicio = converted;
        }
      }
      if (safeUpdates && safeUpdates.fecha_final !== undefined && safeUpdates.fecha_final !== null) {
        const converted = toGeonetDate(safeUpdates.fecha_final);
        if (converted !== safeUpdates.fecha_final) {
          logger.info(`editarInstalacionGeonet: converted fecha_final "${safeUpdates.fecha_final}" -> "${converted}"`);
          safeUpdates.fecha_final = converted;
        }
      }

      // Override con updates. `null` significa “vaciar”.
      const appliedFields: string[] = [];

      // Map updates keys to actual form field names when possible (e.g. 'tecnico' -> 'cliente-tecnico')
      const baseKeys = Object.keys(baseFields);
      const normalizeKey = (k: string) => this.normalizeText(String(k || ''));

      const mapUpdateToField = (updKey: string): string | null => {
        // direct match
        if (baseFields.hasOwnProperty(updKey)) return updKey;
        const updNorm = normalizeKey(updKey).replace(/[-_\s]+/g, '');

        // prefer keys containing 'tecnico' if update key suggests technician
        if (updNorm.includes('tecnico') || updNorm.includes('technician') || updNorm.includes('technicianname')) {
          const candidate = baseKeys.find((k) => normalizeKey(k).includes('tecnico'));
          if (candidate) return candidate;
        }

        // prefer keys related to installation date.
        // If the update key suggests 'inicio' or 'instal', prefer fields explicitly mentioning installation
        if (updNorm.includes('inicio') || updNorm.includes('instal') || updNorm.includes('instalacion')) {
          const candidateInstal = baseKeys.find((k) => {
            const nk = normalizeKey(k).replace(/[-_\s]+/g, '');
            return nk.includes('instal') || nk.includes('instalacion') || nk.includes('instalaci');
          });
          if (candidateInstal) return candidateInstal;
        }

        // If the update key mentions 'fecha' or 'date', prefer installation-specific fecha fields first,
        // then fallback to any 'fecha' or 'date' field.
        if (updNorm.includes('fecha') || updNorm.includes('date')) {
          const candidateFechaInstal = baseKeys.find((k) => {
            const nk = normalizeKey(k).replace(/[-_\s]+/g, '');
            return nk.includes('fecha') && (nk.includes('instal') || nk.includes('instalaci'));
          });
          if (candidateFechaInstal) return candidateFechaInstal;

          const candidateFecha = baseKeys.find((k) => {
            const nk = normalizeKey(k);
            return nk.includes('fecha') || nk.includes('date');
          });
          if (candidateFecha) return candidateFecha;
        }

        // fuzzy match by normalized tokens / similarity score
        let best: { key: string; score: number } | null = null;
        for (const k of baseKeys) {
          const score = this.calculateSimilarityScore(updNorm, normalizeKey(k).replace(/[-_\s]+/g, ''));
          if (!best || score > best.score) best = { key: k, score };
        }
        if (best && best.score >= 0.5) return best.key;

        // no good match
        return null;
      };

      const finalSentPairs: Record<string, string> = {};
      for (const [key, value] of Object.entries(safeUpdates)) {
        if (!key) continue;
        if (value === undefined) continue;
        appliedFields.push(key);

        const mapped = mapUpdateToField(key);
        const fieldName = mapped || key;
        baseFields[fieldName] = value === null ? '' : String(value);
        finalSentPairs[fieldName] = baseFields[fieldName];
        if (!mapped) {
          logger.warn(`editarInstalacionGeonet: no se encontró campo mapeado para update '${key}', usando '${fieldName}' tal cual`);
        } else {
          logger.info(`editarInstalacionGeonet: mapped update '${key}' -> field '${fieldName}'`);
        }
      }

      baseFields['csrfmiddlewaretoken'] = csrfToken;

      logger.info(`editarInstalacionGeonet: will POST form fields=${JSON.stringify(finalSentPairs)}`);

      baseFields['csrfmiddlewaretoken'] = csrfToken;

      const form = new URLSearchParams();
      Object.entries(baseFields).forEach(([k, v]) => {
        if (!k) return;
        form.append(k, v === undefined || v === null ? '' : String(v));
      });

      const response = await this.withRetry(
        () =>
          client.post(url, form.toString(), {
            headers: {
              'Content-Type': 'application/x-www-form-urlencoded',
              Origin: 'https://admin.geonet.cl',
              Referer: url,
              'User-Agent': 'Mozilla/5.0 (Node.js Scraper)',
              'X-CSRFToken': csrfToken,
            },
            maxRedirects: 0,
            validateStatus: () => true,
          }),
        'POST editar instalacion'
      );

      this.throwIfRetryableStatus(response, 'POST editar instalacion');
      this.throwIfGeonetAuthRequired(response, 'POST editar instalacion');

      const responsePreview =
        typeof response.data === 'string'
          ? response.data.slice(0, 800)
          : JSON.stringify(response.data).slice(0, 800);

      const locationHeader = response.headers?.location;
      const setCookieHeader = response.headers?.['set-cookie'] || response.headers?.['Set-Cookie'] || response.headers?.cookie;

      // Consider Geonet redirect to /Instalaciones/ as a successful edit (server redirects to list page)
      let effectiveStatus = response.status;
      if (response.status === 302 && locationHeader && String(locationHeader).startsWith('/Instalaciones')) {
        effectiveStatus = 200;
      }

      let successMessage: string | undefined;
      try {
        const sc = Array.isArray(setCookieHeader) ? setCookieHeader.join(';') : String(setCookieHeader || '');
        const m = sc.match(/messages="([^"]+)"/);
        if (m && m[1]) {
          // messages cookie contains JSON-like content; attempt basic decode of escaped unicode
          successMessage = decodeURIComponent(m[1]);
        }
      } catch {}

      let formErrors: string[] | undefined;
      let missingRequiredFields: string[] | undefined;
      if (typeof response.data === 'string' && response.data.includes('<form')) {
        try {
          const $formDoc = cheerio.load(response.data);
          const parsed = this.parseDjangoFormErrors($formDoc, 'form');
          formErrors = parsed.errorTexts;
          missingRequiredFields = parsed.missingRequired;
        } catch (parseErr) {
          logger.warn(`editarInstalacionGeonet: parse de HTML falló: ${String(parseErr)}`);
        }
      }

      const result: any = {
        status: effectiveStatus,
        location: locationHeader,
        responsePreview,
        url,
        appliedFields,
        formErrors,
        missingRequiredFields,
      };
      if (successMessage) result.successMessage = successMessage;

      // Si la edición fue reportada como exitosa, re-cargar la página de edición
      // para verificar los valores actuales y ofrecerlos al caller para depuración.
      if (effectiveStatus >= 200 && effectiveStatus < 400) {
        try {
          const confirmPage = await this.withRetry(
            () =>
              client.get(url, {
                headers: { 'User-Agent': 'Mozilla/5.0 (Node.js Scraper)' },
                validateStatus: () => true,
              }),
            'GET confirmar editar instalacion (csrf)'
          );
          if (confirmPage && confirmPage.status >= 200 && confirmPage.status < 300 && typeof confirmPage.data === 'string') {
            const $confirm = cheerio.load(confirmPage.data);
            const confirmFormEl = this.findFormWithCsrf($confirm);
            const currentFields = this.extractFormFields($confirm, confirmFormEl);
            result.currentFields = currentFields;
          }
        } catch (err) {
          logger.warn(`editarInstalacionGeonet: no se pudo recuperar página de confirmación: ${String(err)}`);
        }
      }

      return result;
    });
  }

    public async eliminarInstalacionGeonet(params: {
      externalId: string;
    }): Promise<{
      status: number;
      location?: string;
      responsePreview?: string;
      formErrors?: string[];
    }> {
      const externalId = String(params.externalId ?? '').trim();
      if (!externalId) {
        const err: any = new Error('externalId es requerido');
        err.statusCode = 400;
        throw err;
      }

      const url = `https://admin.geonet.cl/Instalaciones/eliminar/${encodeURIComponent(externalId)}/`;

      return this.withGeonetRelogin('eliminarInstalacionGeonet', async (client) => {
        const deletePage = await this.withRetry(
          () =>
            client.get(url, {
              headers: { 'User-Agent': 'Mozilla/5.0 (Node.js Scraper)' },
              validateStatus: () => true,
            }),
          'GET eliminar instalacion (csrf)'
        );

        this.throwIfRetryableStatus(deletePage, 'GET eliminar instalacion (csrf)');
        this.throwIfGeonetAuthRequired(deletePage, 'GET eliminar instalacion (csrf)');

        if (deletePage.status < 200 || deletePage.status >= 300) {
          const bodyPreview =
            typeof deletePage.data === 'string'
              ? deletePage.data.slice(0, 800)
              : JSON.stringify(deletePage.data).slice(0, 800);
          const err: any = new Error(`No se pudo cargar página de eliminar instalación status=${deletePage.status}`);
          err.statusCode = 502;
          err.data = { status: deletePage.status, bodyPreview };
          throw err;
        }

        const $ = cheerio.load(deletePage.data);
        const csrfToken = $('input[name="csrfmiddlewaretoken"]').attr('value') || '';
        if (!csrfToken) {
          const err: any = new Error('No se encontró csrfmiddlewaretoken en el formulario de eliminar instalación');
          err.statusCode = 502;
          throw err;
        }

        const formEl = this.findFormWithCsrf($);
        const baseFields = this.extractFormFields($, formEl);

        const form = new URLSearchParams();
        Object.entries(baseFields).forEach(([key, value]) => {
          if (value === undefined || value === null) return;
          form.append(key, String(value));
        });
        form.set('csrfmiddlewaretoken', csrfToken);

        const response = await this.withRetry(
          () =>
            client.post(url, form.toString(), {
              headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                Origin: 'https://admin.geonet.cl',
                Referer: url,
                'User-Agent': 'Mozilla/5.0 (Node.js Scraper)',
                'X-CSRFToken': csrfToken,
              },
              maxRedirects: 0,
              validateStatus: () => true,
            }),
          'POST eliminar instalacion'
        );

        this.throwIfRetryableStatus(response, 'POST eliminar instalacion');
        this.throwIfGeonetAuthRequired(response, 'POST eliminar instalacion');

        const responsePreview =
          typeof response.data === 'string' ? response.data.slice(0, 800) : JSON.stringify(response.data).slice(0, 800);

        const locationHeader = response.headers?.location;
        logger.info(
          `eliminarInstalacionGeonet: POST status=${response.status} location=${locationHeader || 'n/a'} body=${responsePreview}`
        );

        let formErrors: string[] | undefined;
        if (typeof response.data === 'string' && response.data.includes('<form')) {
          try {
            const $formDoc = cheerio.load(response.data);
            const parsed = this.parseDjangoFormErrors($formDoc, 'form');
            formErrors = parsed.errorTexts;
            if (formErrors.length > 0) {
              logger.warn(`eliminarInstalacionGeonet: errores formulario=${JSON.stringify(formErrors.slice(0, 30))}`);
            }
          } catch (parseErr) {
            logger.warn(`eliminarInstalacionGeonet: parse de HTML falló: ${String(parseErr)}`);
          }
        }

        return {
          status: response.status,
          location: locationHeader,
          responsePreview,
          formErrors,
        };
      });
    }

    public async findWisphubTicketIdByClientFullName(params: {
    clientFullName: string;
    maxPages?: number;
  }): Promise<{
    idTicket: string | null;
    matches: Array<{ idTicket: string; servicioNombre: string }>;
    scanned: number;
    pages: number;
  }> {
    const { clientFullName, maxPages = 10 } = params;
    const { apiKey } = wisphubConfig;

    const target = this.normalizeText(String(clientFullName || ''));
    if (!target) {
      const err: any = new Error('clientFullName es requerido');
      err.statusCode = 400;
      throw err;
    }

    if (!apiKey) {
      const err: any = new Error('Wisphub API config missing (WISPHUB_API_KEY)');
      err.statusCode = 500;
      throw err;
    }

    const ticketsUrl = this.getWisphubTicketsUrl();

    let nextUrl: string | null = ticketsUrl;
    let pages = 0;
    let scanned = 0;
    const matches: Array<{ idTicket: string; servicioNombre: string }> = [];

    while (nextUrl && pages < maxPages) {
      pages += 1;

      const response = await this.withRetry(
        () =>
          axios.get(nextUrl as string, {
            headers: {
              Authorization: `Api-Key ${apiKey}`,
            },
            validateStatus: () => true,
          }),
        `GET Wisphub tickets page ${pages}`
      );

      this.throwIfRetryableStatus(response, `GET Wisphub tickets page ${pages}`);

      if (response.status < 200 || response.status >= 300) {
        const bodyPreview =
          typeof response.data === 'string'
            ? response.data.slice(0, 800)
            : JSON.stringify(response.data).slice(0, 800);
        const err: any = new Error(`Wisphub tickets error status=${response.status}`);
        err.statusCode = 502;
        err.data = { status: response.status, bodyPreview };
        throw err;
      }

      const data: any = response.data;
      const results: any[] = Array.isArray(data?.results) ? data.results : Array.isArray(data) ? data : [];
      scanned += results.length;

      for (const item of results) {
        const servicioNombreRaw = item?.servicio?.nombre;
        if (!servicioNombreRaw) continue;
        const servicioNombre = String(servicioNombreRaw);
        const normalizedServicioNombre = this.normalizeText(servicioNombre);

        const isMatch =
          normalizedServicioNombre === target ||
          normalizedServicioNombre.includes(target) ||
          target.includes(normalizedServicioNombre);

        if (!isMatch) continue;

        const idCandidate = item?.id_ticket ?? item?.idTicket ?? item?.id ?? null;
        if (idCandidate === null || idCandidate === undefined) continue;

        matches.push({
          idTicket: String(idCandidate),
          servicioNombre,
        });
      }

      // DRF pagination commonly uses a full URL in `next`
      nextUrl = typeof data?.next === 'string' && data.next ? data.next : null;
    }

    return {
      idTicket: matches[0]?.idTicket ?? null,
      matches,
      scanned,
      pages,
    };
  }

  public async editarTicketWisphub(params: {
    ticketId: string | number;
    updates: WisphubTicketUpdateInput;
  }): Promise<{
    status: number;
    data: any;
    sentFields: string[];
    method: 'PATCH' | 'PUT' | 'POST';
    url: string;
    warnings?: string[];
    resolvedStaff?: { id: string; nombre: string; email?: string };
  }> {
    const { ticketId, updates } = params;
    const { apiKey } = wisphubConfig;
    if (!apiKey) {
      const err: any = new Error('Wisphub API config missing (WISPHUB_API_KEY)');
      err.statusCode = 500;
      throw err;
    }

    const detailUrl = this.getWisphubTicketDetailUrl(ticketId);

    const warnings: string[] = [];
    const wantsTechnicianChange =
      String(updates.tecnico ?? '').trim() !== '' ||
      String(updates.tecnicoId ?? '').trim() !== '' ||
      String(updates.tecnicoName ?? '').trim() !== '';

    let tecnicoBefore: any = undefined;
    if (wantsTechnicianChange) {
      try {
        const currentResp = await axios.get(detailUrl, {
          headers: { Authorization: `Api-Key ${apiKey}` },
          validateStatus: () => true,
        });
        if (currentResp.status >= 200 && currentResp.status < 300) {
          tecnicoBefore = (currentResp.data as any)?.tecnico;
        }
      } catch {
        // ignore
      }
    }

    // Wisphub: el campo `tecnico` en tickets suele ser read-only (solo lectura).
    // De todas formas, si el caller manda tecnicoName intentamos resolver staff para completar email_tecnico.
    const tecnicoName = String(updates.tecnicoName ?? '').trim();
    let resolvedStaff: { id: string; nombre: string; email?: string } | undefined;
    if (tecnicoName) {
      const staff = await this.resolveWisphubStaffByName({ staffName: tecnicoName, apiKey });
      if (staff) {
        resolvedStaff = staff;
        if (!String(updates.email_tecnico ?? updates.emailTecnico ?? '').trim() && staff.email) {
          (updates as any).email_tecnico = staff.email;
        }
      } else {
        warnings.push('No se encontró staff en Wisphub para tecnicoName; no se pudo inferir email_tecnico.');
      }
    }

    const normalizedUpdates: Record<string, any> = {};

    const normalizeWisphubDateTime = (value: any): any => {
      if (value === undefined || value === null) return value;
      const raw = String(value).trim();
      if (!raw) return value;

      // Accept common human formats and convert to ISO 8601 without timezone.
      // DRF typically expects: YYYY-MM-DDThh:mm[:ss[.uuuuuu]][+HH:MM|-HH:MM|Z]
      // We emit: YYYY-MM-DDThh:mm:ss
      const dmY = raw.match(/^([0-3]\d)\/([0-1]\d)\/(\d{4})\s+([0-2]\d):([0-5]\d)(?::([0-5]\d))?$/);
      if (dmY) {
        const [, dd, mm, yyyy, hh, min, ss] = dmY;
        return `${yyyy}-${mm}-${dd} ${hh}:${min}:${ss ?? '00'}`;
      }

      const yMdSpace = raw.match(/^(\d{4})-([0-1]\d)-([0-3]\d)\s+([0-2]\d):([0-5]\d)(?::([0-5]\d))?$/);
      if (yMdSpace) {
        const [, yyyy, mm, dd, hh, min, ss] = yMdSpace;
        return `${yyyy}-${mm}-${dd} ${hh}:${min}:${ss ?? '00'}`;
      }

      if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(raw)) {
        return raw.replace('T', ' ');
      }

      return value;
    };

    const pick = (key: string, value: any) => {
      if (value === undefined || value === null) return;
      const v = typeof value === 'string' ? value.trim() : value;
      if (typeof v === 'string' && v === '') return;
      normalizedUpdates[key] = v;
    };

    pick('asuntos_default', updates.asuntos_default ?? updates.asuntosDefault);
    pick('asunto', updates.asunto);
    pick('descripcion', updates.descripcion);
    pick('estado', updates.estado);
    pick('prioridad', updates.prioridad);
    pick('servicio', updates.servicio);
    pick('fecha_inicio', normalizeWisphubDateTime(updates.fecha_inicio ?? updates.fechaInicio));
    pick('fecha_final', normalizeWisphubDateTime(updates.fecha_final ?? updates.fechaFinal));
    pick('origen_reporte', updates.origen_reporte ?? updates.origenReporte);
    pick('departamento', updates.departamento);
    pick('email_tecnico', updates.email_tecnico ?? updates.emailTecnico);

    const sentFields: string[] = [];
    const buildMultipart = (payload: Record<string, any>) => {
      const form = new FormData();
      for (const [k, v] of Object.entries(payload)) {
        if (v === undefined || v === null) continue;
        const asString = typeof v === 'string' ? v.trim() : String(v);
        if (asString === '' || asString.toLowerCase() === 'undefined' || asString.toLowerCase() === 'null') {
          continue;
        }
        form.append(k, asString);
        sentFields.push(k);
      }
      if (updates.archivoTicket && Buffer.isBuffer(updates.archivoTicket)) {
        form.append('archivo_ticket', updates.archivoTicket as any, {
          filename: 'archivo_ticket.bin',
        } as any);
        sentFields.push('archivo_ticket');
      }
      return form;
    };

    // 1) Try PATCH with only provided fields.
    const hasFile = Boolean(updates.archivoTicket && Buffer.isBuffer(updates.archivoTicket));
    sentFields.length = 0;
    let response = await (async () => {
      if (!hasFile) {
        // Use multipart/form-data for PATCH even when no file is present.
        // Some Wisphub endpoints expect form-data rather than urlencoded or JSON.
        const patchForm = buildMultipart(normalizedUpdates);
        return axios.request({
          method: 'patch',
          url: detailUrl,
          data: patchForm,
          headers: {
            ...patchForm.getHeaders(),
            Authorization: `Api-Key ${apiKey}`,
          },
          maxBodyLength: Infinity,
          validateStatus: () => true,
        });
      }

      const patchForm = buildMultipart(normalizedUpdates);
      return axios.request({
        method: 'patch',
        url: detailUrl,
        data: patchForm,
        headers: {
          ...patchForm.getHeaders(),
          Authorization: `Api-Key ${apiKey}`,
        },
        maxBodyLength: Infinity,
        validateStatus: () => true,
      });
    })();

    // 2) If PATCH not allowed or fails due to required fields, try PUT by merging with current ticket.
    let patchNotAllowed = response.status === 405;
    // Some fields (estado, fecha_inicio, fecha_final) are known to be ignored by partial PATCH
    // even when the response is 200. If caller attempts to update them, force the PUT fallback
    // so we send a merged full representation.
    if (!patchNotAllowed && response.status >= 200 && response.status < 300) {
      const forcePutKeys = ['estado', 'fecha_inicio', 'fecha_final'];
      for (const k of forcePutKeys) {
        if (Object.prototype.hasOwnProperty.call(normalizedUpdates, k)) {
          patchNotAllowed = true;
          warnings.push('PATCH may not update some fields; forcing PUT fallback for certain fields.');
          break;
        }
      }
    }
    // IMPORTANT: Do NOT fall back to PUT on a generic 400.
    // Wisphub might support PATCH but reject our payload; PUT requires full valid choice values and can break partial updates.
    if (patchNotAllowed) {
      // Fetch current ticket to preserve unspecified fields.
      const currentResp = await axios.get(detailUrl, {
        headers: { Authorization: `Api-Key ${apiKey}` },
        validateStatus: () => true,
      });

      const currentOk = currentResp.status >= 200 && currentResp.status < 300;
      if (currentOk && currentResp.data && typeof currentResp.data === 'object') {
        const current: any = currentResp.data;

        // Attempt to use DRF OPTIONS to map display labels back to valid choice values (e.g. "Baja" -> 1)
        let optionChoices: Record<string, Array<{ value: any; label: string }>> = {};
        try {
          const optResp = await axios.request({
            method: 'options',
            url: detailUrl,
            headers: { Authorization: `Api-Key ${apiKey}` },
            validateStatus: () => true,
          });
          if (optResp.status >= 200 && optResp.status < 300 && optResp.data && typeof optResp.data === 'object') {
            const actions = (optResp.data as any)?.actions;
            const putMeta = actions?.PUT ?? actions?.put ?? actions?.Patch ?? actions?.PATCH;
            const meta = putMeta && typeof putMeta === 'object' ? putMeta : actions?.PUT;
            if (meta && typeof meta === 'object') {
              for (const [field, def] of Object.entries<any>(meta)) {
                const choicesRaw = def?.choices;
                if (!Array.isArray(choicesRaw)) continue;
                optionChoices[field] = choicesRaw
                  .map((c: any) => {
                    const value = c?.value ?? c?.id ?? c?.key;
                    const label = String(c?.display_name ?? c?.display ?? c?.label ?? c?.name ?? value ?? '').trim();
                    if (value === undefined) return null;
                    return { value, label };
                  })
                  .filter(Boolean) as Array<{ value: any; label: string }>;
              }
            }
          }
        } catch {
          // ignore
        }

        // If OPTIONS on detail didn't yield choices, try OPTIONS on base tickets URL as fallback
        try {
          if (!optionChoices || Object.keys(optionChoices).length === 0) {
            const baseUrl = this.getWisphubTicketsUrl();
            const optBaseResp = await axios.request({
              method: 'options',
              url: baseUrl,
              headers: { Authorization: `Api-Key ${apiKey}` },
              validateStatus: () => true,
            });
            if (optBaseResp.status >= 200 && optBaseResp.status < 300 && optBaseResp.data && typeof optBaseResp.data === 'object') {
              const actions = (optBaseResp.data as any)?.actions;
              const putMeta = actions?.PUT ?? actions?.put ?? actions?.Patch ?? actions?.PATCH ?? actions;
              const meta = putMeta && typeof putMeta === 'object' ? putMeta : actions?.PUT;
              if (meta && typeof meta === 'object') {
                for (const [field, def] of Object.entries<any>(meta)) {
                  const choicesRaw = def?.choices;
                  if (!Array.isArray(choicesRaw)) continue;
                  optionChoices[field] = choicesRaw
                    .map((c: any) => {
                      const value = c?.value ?? c?.id ?? c?.key;
                      const label = String(c?.display_name ?? c?.display ?? c?.label ?? c?.name ?? value ?? '').trim();
                      if (value === undefined) return null;
                      return { value, label };
                    })
                    .filter(Boolean) as Array<{ value: any; label: string }>;
                }
              }
            }
          }
        } catch {
          // ignore
        }

        const extractScalar = (value: any): any => {
          if (value === undefined || value === null) return undefined;
          if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;
          if (typeof value === 'object') {
            const idCandidate =
              (value as any)?.id ??
              (value as any)?.pk ??
              (value as any)?.value ??
              (value as any)?.tecnico_id ??
              (value as any)?.id_tecnico ??
              (value as any)?.servicio_id ??
              (value as any)?.id_servicio;
            if (idCandidate !== undefined && idCandidate !== null) return idCandidate;
          }
          return undefined;
        };

        const mapChoiceIfNeeded = (field: string, value: any): any => {
          const scalar = extractScalar(value);
          if (scalar === undefined || scalar === null) return undefined;
          const choices = optionChoices[field];
          if (!choices || choices.length === 0) return scalar;
          // Already valid value
          if (choices.some((c) => String(c.value) === String(scalar))) return scalar;
          const asText = String(scalar).trim();
          const byLabel = choices.find((c) => c.label && this.normalizeText(c.label) === this.normalizeText(asText));
          return byLabel ? byLabel.value : scalar;
        };

        const merged: Record<string, any> = {
          asuntos_default: mapChoiceIfNeeded('asuntos_default', current.asuntos_default ?? current.asuntosDefault),
          asunto: extractScalar(current.asunto) ?? current.asunto,
          tecnico: extractScalar(current.tecnico),
          descripcion: current.descripcion,
          estado: mapChoiceIfNeeded('estado', current.estado),
          prioridad: mapChoiceIfNeeded('prioridad', current.prioridad),
          servicio: extractScalar(current.servicio),
          fecha_inicio: current.fecha_inicio ?? current.fechaInicio,
          fecha_final: current.fecha_final ?? current.fechaFinal,
          origen_reporte: mapChoiceIfNeeded('origen_reporte', current.origen_reporte ?? current.origenReporte),
          departamento: mapChoiceIfNeeded('departamento', current.departamento),
          email_tecnico: current.email_tecnico ?? current.emailTecnico,
        };

        // override only provided
        Object.assign(merged, normalizedUpdates);

        try {
          // Normalize date/time fields in merged to ISO expected by Wisphub
          if (merged.fecha_inicio) merged.fecha_inicio = normalizeWisphubDateTime(merged.fecha_inicio) ?? merged.fecha_inicio;
          if (merged.fecha_final) merged.fecha_final = normalizeWisphubDateTime(merged.fecha_final) ?? merged.fecha_final;

          // If tecnico is a textual name, try resolving to staff id via Wisphub API
          if (merged.tecnico && typeof merged.tecnico === 'string' && !/^[0-9]+$/.test(String(merged.tecnico).trim())) {
            try {
              const resolvedTech = await this.resolveWisphubTechnicianIdByName({ technicianName: String(merged.tecnico), apiKey });
              if (resolvedTech) merged.tecnico = resolvedTech;
            } catch {}
          }

          for (const [field, val] of Object.entries(merged)) {
            if (val === undefined || val === null) continue;
            if (optionChoices && optionChoices[field] && Array.isArray(optionChoices[field]) && optionChoices[field].length > 0) {
              merged[field] = mapChoiceIfNeeded(field, val);
            }
          }
        } catch (mapErr) {
          // Non-fatal: proceed with original merged values if mapping fails
          logger.warn(`editarTicketWisphub: option mapping failed: ${String(mapErr)}`);
        }

        sentFields.length = 0;
        response = await (async () => {
          if (!hasFile) {
            const cleaned: Record<string, any> = {};
            for (const [k, v] of Object.entries(merged)) {
              if (v === undefined || v === null) continue;
              const s = typeof v === 'string' ? v.trim() : String(v);
              if (s === '' || s.toLowerCase() === 'undefined' || s.toLowerCase() === 'null') continue;
              cleaned[k] = v;
            }
            const putForm = buildMultipart(cleaned);
            return axios.request({
              method: 'put',
              url: detailUrl,
              data: putForm,
              headers: {
                ...putForm.getHeaders(),
                Authorization: `Api-Key ${apiKey}`,
              },
              maxBodyLength: Infinity,
              validateStatus: () => true,
            });
          }

          const putForm = buildMultipart(merged);
          return axios.request({
            method: 'put',
            url: detailUrl,
            data: putForm,
            headers: {
              ...putForm.getHeaders(),
              Authorization: `Api-Key ${apiKey}`,
            },
            maxBodyLength: Infinity,
            validateStatus: () => true,
          });
        })();

        if (wantsTechnicianChange) {
          warnings.push(
            'PATCH no permitido; se usó PUT. Nota: Wisphub igual puede no permitir reasignar técnico (campo `tecnico` suele ser read_only).'
          );
        }

        return {
          status: response.status,
          data: response.data,
          sentFields,
          method: 'PUT',
          url: detailUrl,
          warnings: warnings.length ? warnings : undefined,
          resolvedStaff,
        };
      }
    }

    if (wantsTechnicianChange) {
      let tecnicoReadOnly: boolean | undefined;
      try {
        const optResp = await axios.request({
          method: 'options',
          url: detailUrl,
          headers: { Authorization: `Api-Key ${apiKey}` },
          validateStatus: () => true,
        });
        const fieldMeta = (optResp.data as any)?.actions?.PATCH?.tecnico ?? (optResp.data as any)?.actions?.PUT?.tecnico;
        if (fieldMeta && typeof fieldMeta === 'object') {
          tecnicoReadOnly = Boolean((fieldMeta as any).read_only);
        }
      } catch {
        // ignore
      }

      const tecnicoAfter = (response.data as any)?.tecnico;
      if (tecnicoReadOnly === true) {
        warnings.push(
          'Wisphub no permite cambiar el técnico por API (campo `tecnico` es read_only). Solo se puede actualizar `email_tecnico` y otros campos editables.'
        );
      } else if (tecnicoBefore !== undefined && tecnicoAfter !== undefined && String(tecnicoAfter) === String(tecnicoBefore)) {
        warnings.push('Se intentó cambiar técnico, pero Wisphub no reflejó cambios en `tecnico` (posible campo no editable).');
      }
    }

    return {
      status: response.status,
      data: response.data,
      sentFields,
      method: 'PATCH',
      url: detailUrl,
      warnings: warnings.length ? warnings : undefined,
      resolvedStaff,
    };
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

  private normalizeText(value: string): string {
    return value
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  private normalizeCedula(value: string): string {
    const raw = String(value || '');
    // Remove dots
    let s = raw.replace(/\./g, '').trim();
    // If ends with -k or -K, ensure uppercase K
    if (/-k$/i.test(s)) {
      s = s.replace(/-k$/i, '-K');
    }
    return s;
  }

  private findSelect($: cheerio.CheerioAPI, token: string): cheerio.Cheerio<any> {
    const selector = `select[name*="${token}" i], select[id*="${token}" i]`;
    const matches = $(selector);
    if (matches.length > 0) return matches.first();
    return $('select').first();
  }

  private findOptionId(selectEl: cheerio.Cheerio<any>, optionName: string): string {
    const target = this.normalizeText(optionName);
    const targetNumbers = this.extractNumericTokens(target);
    let bestValue = '';
    let bestText = '';
    let bestScore = 0;

    const targetIsEmail = String(optionName || '').includes('@');

    // Prepare email variants for looser matching (e.g. input 'gerson@geonet.cl' should match 'gerson@geonet')
    let targetEmailVariants: string[] = [];
    const looseEmailRegex = /[A-Z0-9._%+-]+@[A-Z0-9.-]+/i;
    if (targetIsEmail) {
      const raw = String(optionName || '').trim();
      const m = raw.match(looseEmailRegex);
      const lower = m ? this.normalizeText(m[0]) : this.normalizeText(raw);
      targetEmailVariants.push(lower);
      // If there's a dot in domain, also add variant without last dot segment (strip TLD)
      const parts = lower.split('@');
      if (parts.length === 2) {
        const local = parts[0];
        const domain = parts[1];
        const domainPrefix = domain.split('.').filter(Boolean)[0];
        if (domainPrefix && domainPrefix !== domain) {
          targetEmailVariants.push(`${local}@${domainPrefix}`);
        }
      }
      // Deduplicate
      targetEmailVariants = Array.from(new Set(targetEmailVariants));
    }

    selectEl.find('option').each((_index: number, opt: any) => {
      const value = selectEl.find(opt).attr('value') || '';
      const text = selectEl.find(opt).text();
      if (!value) return undefined;

      const normalizedText = this.normalizeText(text);

      // If caller provided an email, prefer exact (or looser) email match inside the option text
      if (targetIsEmail) {
        const optEmailLoose = (text.match(looseEmailRegex) || [])[0] ||
          (String((selectEl.find(opt).attr('title') || '')).match(looseEmailRegex) || [])[0] ||
          (String((selectEl.find(opt).attr('data-email') || '')).match(looseEmailRegex) || [])[0] ||
          (String(value).match(looseEmailRegex) || [])[0] || '';
        if (optEmailLoose) {
          const normOpt = this.normalizeText(optEmailLoose);
          if (targetEmailVariants.includes(normOpt)) {
            bestValue = value;
            bestText = normalizedText;
            bestScore = 1;
            return undefined;
          }
        }
      }

      let score = this.calculateSimilarityScore(target, normalizedText);

      if (targetNumbers.length > 0) {
        const candidateNumbers = this.extractNumericTokens(normalizedText);
        const numericOverlap = targetNumbers.filter((n) => candidateNumbers.includes(n)).length;
        if (numericOverlap > 0) {
          score += 0.4;
        }
      }

      if (score > bestScore) {
        bestScore = score;
        bestValue = value;
        bestText = normalizedText;
      }
      return undefined;
    });

    // Fallback: when caller provided an email and no match found yet, try scanning
    // common attributes (title, data-email, value) for the email string.
    if (targetIsEmail && !bestValue) {
      selectEl.find('option').each((_i: number, opt: any) => {
        const $opt = selectEl.find(opt);
        const value = String($opt.attr('value') || '');
        if (!value) return undefined;
        const text = String($opt.text() || '');
        const title = String($opt.attr('title') || '');
        const dataEmail = String(
          $opt.attr('data-email') || $opt.attr('data_email') || $opt.attr('data-tecnico-email') || $opt.attr('data_tecnico_email') || ''
        );
        const combined = `${text} ${title} ${dataEmail} ${value}`;
        const optEmail = this.extractEmailFromText(combined);
        if (optEmail && this.normalizeText(optEmail) === target) {
          logger.info(`findOptionId: matched technician email via attribute for target="${target}" optionText="${text}"`);
          bestValue = value;
          bestText = this.normalizeText(text);
          bestScore = 1;
          return undefined;
        }
        return undefined;
      });
    }

    if (!bestValue) return '';
    if (bestScore < 0.2) {
      logger.warn(`findOptionId: low match score=${bestScore.toFixed(2)} target="${target}" best="${bestText}"`);
    }
    return bestValue;
  }

  private calculateSimilarityScore(target: string, candidate: string): number {
    if (!target || !candidate) return 0;
    if (candidate.includes(target)) return 1;

    const targetTokens = new Set(target.split(' ').filter(Boolean));
    const candidateTokens = new Set(candidate.split(' ').filter(Boolean));
    if (targetTokens.size === 0 || candidateTokens.size === 0) return 0;

    let overlap = 0;
    for (const token of targetTokens) {
      if (candidateTokens.has(token)) overlap += 1;
    }

    const unionSize = new Set([...targetTokens, ...candidateTokens]).size;
    return unionSize === 0 ? 0 : overlap / unionSize;
  }

  private extractOptionTexts(selectEl: cheerio.Cheerio<any>): string[] {
    const options: string[] = [];
    selectEl.find('option').each((_index: number, opt: any) => {
      const text = selectEl.find(opt).text();
      if (text) options.push(text.trim());
      return undefined;
    });
    return options.filter(Boolean);
  }

  private getSelectedOptionValue(selectEl: cheerio.Cheerio<any>): string {
    let value = '';
    const selected = selectEl.find('option[selected]');
    if (selected.length > 0) {
      value = String(selected.first().attr('value') || '');
    }

    if (!value) {
      const firstValid = selectEl
        .find('option')
        .filter((_i: number, opt: any) => {
          const optValue = selectEl.find(opt).attr('value');
          const text = selectEl.find(opt).text();
          if (!optValue) return false;
          if (!text) return true;
          return !text.includes('---------');
        })
        .first();
      value = String(firstValid.attr('value') || '');
    }

    return value;
  }

  private throwIfRetryableStatus(response: any, label: string): void {
    const status = response?.status;
    if (status === 429 || status === 502 || status === 503 || status === 504) {
      const err: any = new Error(`${label} retryable status=${status}`);
      err.response = response;
      throw err;
    }
  }

  private extractEmailFromText(value: string): string {
    const text = String(value || '');
    const match = text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
    return match?.[0] ?? '';
  }

  private findFormWithCsrf($: cheerio.CheerioAPI): cheerio.Cheerio<any> {
    const formWithCsrf = $('form').filter((_i, el) => $(el).find('input[name="csrfmiddlewaretoken"]').length > 0);
    if (formWithCsrf.length > 0) return formWithCsrf.first();
    return $('form').first();
  }

  private extractFormFields($: cheerio.CheerioAPI, formEl: cheerio.Cheerio<any>): Record<string, string> {
    const fields: Record<string, string> = {};
    const scope = formEl && formEl.length > 0 ? formEl : $('form').first();
    if (!scope || scope.length === 0) return fields;

    // inputs
    scope.find('input').each((_i, el) => {
      const $el = $(el);
      const name = $el.attr('name');
      if (!name) return undefined;
      const type = String($el.attr('type') || '').toLowerCase();
      if (type === 'submit' || type === 'button' || type === 'file') return undefined;
      if (type === 'checkbox' || type === 'radio') {
        if (!$el.is(':checked')) return undefined;
      }
      const value = String($el.attr('value') ?? '').trim();
      if (value !== '') fields[name] = value;
      return undefined;
    });

    // textareas
    scope.find('textarea').each((_i, el) => {
      const $el = $(el);
      const name = $el.attr('name');
      if (!name) return undefined;
      const value = ($el.text() || '').trim();
      if (value !== '') fields[name] = value;
      return undefined;
    });

    // selects
    scope.find('select').each((_i, el) => {
      const $el = $(el);
      const name = $el.attr('name');
      if (!name) return undefined;
      const selected = $el.find('option[selected]').first();
      let value = selected.attr('value');
      if (!value) {
        const firstValid = $el
          .find('option')
          .filter((_j, opt) => {
            const v = String($(opt).attr('value') || '').trim();
            const t = String($(opt).text() || '').trim();
            if (!v) return false;
            if (!t) return true;
            return !t.includes('---------');
          })
          .first();
        value = firstValid.attr('value');
      }
      if (value) fields[name] = String(value);
      return undefined;
    });

    return fields;
  }

  private parseDjangoFormErrors(
    $doc: cheerio.CheerioAPI,
    formSelector: string
  ): { errorTexts: string[]; missingRequired: string[] } {
    const errorTexts: string[] = [];
    $doc('ul.errorlist li, .errorlist li, .errorlist').each((_i, el) => {
      const text = $doc(el).text().trim();
      if (text) errorTexts.push(text);
      return undefined;
    });

    const missingRequired: string[] = [];
    const $form = $doc(formSelector).first();
    if ($form.length > 0) {
      $form.find(':input').each((_i, el) => {
        const $el = $doc(el);
        const name = $el.attr('name');
        if (!name) return undefined;
        const required =
          $el.is('[required]') ||
          $el.attr('data-rule-required') === 'true' ||
          $el.hasClass('control-label-required');
        if (!required) return undefined;

        let value = '';
        if ($el.is('select')) {
          value = String($el.val() ?? '');
        } else if ($el.is('textarea')) {
          value = ($el.text() || '').trim();
        } else {
          value = String($el.attr('value') ?? '').trim();
        }
        if (!value) missingRequired.push(name);
        return undefined;
      });
    }

    return { errorTexts, missingRequired };
  }

  private findOptionTextByValue(selectEl: cheerio.Cheerio<any>, value: string): string {
    if (!value) return '';
    const opt = selectEl
      .find('option')
      .filter((_i: number, el: any) => String(selectEl.find(el).attr('value') || '') === String(value))
      .first();
    return (opt.text() || '').trim();
  }

  private async findTechnicianEmailByName(technicianName: string): Promise<string> {
    const target = this.normalizeText(String(technicianName || ''));
    if (!target) return '';

    await this.ensureDataSource();
    const repo = AppDataSource.getRepository(Technician);

    // Fetch a small set and do fuzzy match in-memory (names can have accents, ordering etc.)
    const technicians = await repo
      .createQueryBuilder('t')
      .select(['t.firstName', 't.lastName', 't.email'])
      .where('t.isActive = :active', { active: true })
      .orderBy('t.updatedAt', 'DESC')
      .limit(500)
      .getMany();

    let bestEmail = '';
    let bestScore = 0;
    for (const tech of technicians) {
      const fullNameRaw = `${tech.firstName || ''} ${tech.lastName || ''}`.trim();
      const fullName = this.normalizeText(fullNameRaw);
      if (!fullName) continue;

      if (fullName === target || fullName.includes(target) || target.includes(fullName)) {
        if (tech.email) return String(tech.email).trim();
      }

      const score = this.calculateSimilarityScore(target, fullName);
      if (score > bestScore) {
        bestScore = score;
        bestEmail = tech.email ? String(tech.email).trim() : '';
      }
    }

    if (bestScore >= 0.6) return bestEmail;
    return '';
  }

  private extractNumericTokens(value: string): string[] {
    if (!value) return [];
    return value.match(/\d+/g) || [];
  }

  private findFirstAvailableIp($: cheerio.CheerioAPI): string | null {
    const bodyText = $('body').text();
    if (!bodyText) return null;
    const matches = bodyText.match(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g) || [];
    if (matches.length === 0) return null;
    return matches[0] ?? null;
  }

  private formatDateTimeCL(value: Date | null | undefined): string {
    if (!value) return '';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '';

    const pad = (n: number) => String(n).padStart(2, '0');
    const day = pad(date.getDate());
    const month = pad(date.getMonth() + 1);
    const year = date.getFullYear();
    const hours = pad(date.getHours());
    const minutes = pad(date.getMinutes());
    return `${day}/${month}/${year} ${hours}:${minutes}`;
  }

  private async submitGeonetActivation(params: {
    client: AxiosInstance;
    activationLink: string;
    technicianId: string;
    planId: string;
    firstAvailableIp: string | null;
    installationRequestId: number;
    zonaName?: string;
    routerName?: string;
    apName?: string;
  }): Promise<number> {
    const { client, activationLink, technicianId, planId, firstAvailableIp, installationRequestId, zonaName, routerName, apName } = params;

    if (!firstAvailableIp) {
      const err: any = new Error('No se encontró una IP disponible');
      err.statusCode = 404;
      throw err;
    }

    await this.ensureDataSource();
    const repo = AppDataSource.getRepository(InstallationRequest);
    const request = await repo.findOne({ where: { id: installationRequestId } });
    if (!request) {
      const err: any = new Error('InstallationRequest no encontrada');
      err.statusCode = 404;
      throw err;
    }

    if (!request.agreedInstallationDate) {
      const err: any = new Error('agreedInstallationDate es requerido');
      err.statusCode = 400;
      throw err;
    }

    const activationPage = await this.withRetry(
      () =>
        client.get(activationLink, {
          headers: { 'User-Agent': 'Mozilla/5.0 (Node.js Scraper)' },
          validateStatus: () => true,
        }),
      'GET activacion (csrf)'
    );

    this.throwIfRetryableStatus(activationPage, 'GET activacion (csrf)');
    this.throwIfGeonetAuthRequired(activationPage, 'GET activacion (csrf)');
    if (activationPage.status < 200 || activationPage.status >= 300) {
      const err: any = new Error(`GET activacion (csrf) status=${activationPage.status}`);
      err.statusCode = 502;
      throw err;
    }

    const $ = cheerio.load(activationPage.data);
    const csrfToken = $('input[name="csrfmiddlewaretoken"]').attr('value') || '';
    if (!csrfToken) {
      const err: any = new Error('No se encontró csrfmiddlewaretoken');
      err.statusCode = 502;
      throw err;
    }

    const routerSelect = this.findSelect($, 'router_cliente');
    const zonaSelect = this.findSelect($, 'zona_cliente');
    const apSelect = this.findSelect($, 'ap_cliente');

    let routerValue = '';
    let zonaValue = '';
    let apValue = '';

    // resolve router
    if (routerName && routerSelect && routerSelect.length > 0) {
      routerValue = this.findOptionId(routerSelect, String(routerName));
      if (!routerValue) {
        logger.warn(`submitGeonetActivation: routerName provided but no match found="${routerName}"; falling back to selected value`);
        routerValue = this.getSelectedOptionValue(routerSelect);
      }
    } else {
      routerValue = this.getSelectedOptionValue(routerSelect);
    }

    // resolve zona
    if (zonaName && zonaSelect && zonaSelect.length > 0) {
      zonaValue = this.findOptionId(zonaSelect, String(zonaName));
      if (!zonaValue) {
        logger.warn(`submitGeonetActivation: zonaName provided but no match found="${zonaName}"; falling back to selected value`);
        zonaValue = this.getSelectedOptionValue(zonaSelect);
      }
    } else {
      zonaValue = this.getSelectedOptionValue(zonaSelect);
    }

    // resolve ap / NAP / Sectorial
    if (apName && apSelect && apSelect.length > 0) {
      apValue = this.findOptionId(apSelect, String(apName));
      if (!apValue) {
        logger.warn(`submitGeonetActivation: apName provided but no match found="${apName}"; falling back to selected value`);
        apValue = this.getSelectedOptionValue(apSelect);
      }
    } else {
      apValue = this.getSelectedOptionValue(apSelect);
    }

    const fullName = `${request.firstName || ''} ${request.lastName || ''}`.trim();
    const activationId = this.getActivationIdFromUrl(activationLink);
    const rawFirstName = (request.firstName || '').trim();
    const firstNameOnly = rawFirstName.split(/\s+/).filter(Boolean)[0] || '';
    const firstNameSlug = firstNameOnly.toLowerCase().replace(/\s+/g, '_');
    const externalIdBase = activationId ? `${activationId}_${firstNameSlug}` : `${request.id}_${firstNameSlug}`;
    const phoneValue = request.additionalPhone
      ? `${request.phone || ''},${request.additionalPhone}`
      : `${request.phone || ''}`;

    const form = new URLSearchParams();
    form.append('csrfmiddlewaretoken', csrfToken);
    form.append('usr-first_name', request.firstName || '');
    form.append('usr-last_name', request.lastName || '');
    const ciNormalized = this.normalizeCedula(request.ci || '');
    form.append('perfil-cedula', ciNormalized);
    form.append('usr-email', request.email || '');
    form.append('perfil-cc', '');
    form.append('perfil-direccion', request.address || '');
    form.append('perfil-external_id', externalIdBase);
    form.append('cliente-coordenadas', request.coordinates || '');
    form.append('perfil-localidad', request.neighborhood || '');
    form.append('perfil-ciudad', request.city || '');
    form.append('perfil-telefono', phoneValue);
    form.append('cliente-forma_contratacion', '');
    form.append('cliente-fecha_registro', this.formatDateTimeCL(request.createdAt));
    form.append('cliente-fecha_instalacion', this.formatDateTimeCL(request.agreedInstallationDate));
    form.append('cliente-costo_instalacion', '0');
    form.append('cliente-creado_por', '');
    form.append('cliente-comentarios', request.comments || '');
    form.append('cliente-cliente_rb', externalIdBase);
    form.append('cliente-ip', firstAvailableIp);
    form.append('cliente-mac_cpe', '');
    form.append('cliente-router_cliente', routerValue);
    form.append('cliente-zona_cliente', zonaValue);
    form.append('cliente-plan_internet', planId);
    form.append('cliente-tecnico', technicianId);
    form.append('cliente-estado_instalacion', '1');
    form.append('cliente-ap_cliente', apValue);
    form.append('usr-password', '{dni_cliente}');
    form.append('cliente-external_id', externalIdBase);
    form.append('cliente-modelo_cpe2', '');
    form.append('cliente-usuario_cpe', '');
    form.append('cliente-password_cpe', '');
    form.append('cliente-protocolo_conexion_cpe', '');
    form.append('cliente-sn_onu', '');
    form.append('cliente-ip_router_wifi', '');
    form.append('cliente-modelo_router_wifi', '');
    form.append('cliente-usuario_router_wifi', '');
    form.append('cliente-password_router_wifi', '');
    form.append('cliente-ssid_router_wifi', '');
    form.append('cliente-password_ssid_router_wifi', '');
    form.append('GEO_{cliente_rb}', '');
    form.append('cliente-mac_router_wifi', '');
    form.append('perfil-nombre_facturacion', fullName);
    form.append('perfil-tipo_persona', '2');
    form.append('perfil-tipo_identificacion', '0');
    form.append('perfil-rfc', ciNormalized);
    form.append('perfil-cp', request.postalCode || '');
    form.append('perfil-direccion_facturacion', request.address || '');
    form.append('perfil-email_facturacion', request.email || '');
    form.append('perfil-representante_legal', fullName);
    form.append('perfil-giro', '');
    form.append('perfil-cedula_facturacion', ciNormalized);
    form.append('perfil-informacion_adicional', '');
    form.append('perfil-retenciones', '0.00');
    form.append('perfil-retencion_iva', '19.0');

    const response = await this.withRetry(
      () =>
        client.post(activationLink, form.toString(), {
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            Origin: 'https://admin.geonet.cl',
            Referer: activationLink,
            'User-Agent': 'Mozilla/5.0 (Node.js Scraper)',
          },
          maxRedirects: 0,
          validateStatus: () => true,
        }),
      'POST activacion'
    );

    this.throwIfRetryableStatus(response, 'POST activacion');
    this.throwIfGeonetAuthRequired(response, 'POST activacion');

    const responsePreview =
      typeof response.data === 'string'
        ? response.data.slice(0, 800)
        : JSON.stringify(response.data).slice(0, 800);
    const locationHeader = response.headers?.location;
    logger.info(
      `Geonet activation POST status=${response.status} location=${locationHeader || 'n/a'} body=${responsePreview}`
    );

    if (typeof response.data === 'string' && response.data.includes('<form')) {
      try {
        const html = response.data;
        const $form = cheerio.load(html);
        const errorTexts: string[] = [];
        $form('ul.errorlist li, .errorlist li, .errorlist').each((_i, el) => {
          const text = $form(el).text().trim();
          if (text) errorTexts.push(text);
          return undefined;
        });

        const missingRequired: string[] = [];
        $form('form#agregar-cliente :input').each((_i, el) => {
          const $el = $form(el);
          const name = $el.attr('name');
          if (!name) return undefined;

          const required =
            $el.is('[required]') ||
            $el.attr('data-rule-required') === 'true' ||
            $el.hasClass('control-label-required');

          if (!required) return undefined;

          let value = '';
          if ($el.is('select')) {
            value = String($el.val() ?? '');
          } else if ($el.is('textarea')) {
            value = ($el.text() || '').trim();
          } else {
            value = String($el.attr('value') ?? '').trim();
          }

          if (!value) missingRequired.push(name);
          return undefined;
        });

        if (errorTexts.length > 0) {
          logger.warn(`Geonet activation form errors: ${JSON.stringify(errorTexts.slice(0, 20))}`);
        }
        if (missingRequired.length > 0) {
          logger.warn(`Geonet activation missing required fields: ${JSON.stringify(missingRequired)}`);
        }
      } catch (parseErr) {
        logger.warn(`Geonet activation HTML parse failed: ${String(parseErr)}`);
      }
    }
    return response.status;
  }

  private async findInstallationRequestIdByClientName(clientName: string): Promise<number | undefined> {
    await this.ensureDataSource();
    const repo = AppDataSource.getRepository(InstallationRequest);
    const target = this.normalizeText(clientName);
    if (!target) return undefined;

    logger.info(`findInstallationRequestIdByClientName: targetClientName="${clientName}" normalized="${target}"`);

    const targetTokens = target.split(' ').filter(Boolean);
    const qb = repo
      .createQueryBuilder('r')
      .select(['r.id', 'r.firstName', 'r.lastName'])
      .orderBy('r.id', 'DESC')
      .limit(200);

    if (targetTokens.length > 0) {
      targetTokens.forEach((token, idx) => {
        const param = `token${idx}`;
        const like = `%${token}%`;
        const clause = 'LOWER(CONCAT(r.firstName, " ", r.lastName)) LIKE :' + param;
        if (idx === 0) {
          qb.where(clause, { [param]: like });
        } else {
          qb.orWhere(clause, { [param]: like });
        }
      });
    }

    const requests = await qb.getMany();

    let bestId: number | undefined;
    let bestScore = 0;
    let bestName = '';

    for (const req of requests) {
      const rawFullName = `${req.firstName || ''} ${req.lastName || ''}`.trim();
      const fullName = this.normalizeText(rawFullName);
      logger.info(`findInstallationRequestIdByClientName: comparing fullName="${rawFullName}" normalized="${fullName}"`);
      if (!fullName) continue;

      if (fullName === target || fullName.includes(target)) {
        return req.id;
      }

      if (targetTokens.length > 0) {
        const nameTokens = new Set(fullName.split(' ').filter(Boolean));
        const overlap = targetTokens.filter((token) => nameTokens.has(token)).length;
        const score = overlap / targetTokens.length;
        if (score > bestScore) {
          bestScore = score;
          bestId = req.id;
          bestName = fullName;
        }
      }
    }

    if (bestId !== undefined && bestScore >= 0.6) {
      logger.warn(`findInstallationRequestIdByClientName: fuzzy match score=${bestScore.toFixed(2)} target="${target}" best="${bestName}"`);
      return bestId;
    }

    return undefined;
  }

  private async findInstallationRequestById(id: number): Promise<InstallationRequest | null> {
    await this.ensureDataSource();
    const repo = AppDataSource.getRepository(InstallationRequest);
    return repo.findOne({ where: { id } });
  }


  private async withRetry<T>(fn: () => Promise<T>, label: string, attempts = 3, baseDelayMs = 1000): Promise<T> {
    let lastError: any;

    const isRetryableStatus = (status: number | undefined | null): boolean => {
      return status === 429 || status === 502 || status === 503 || status === 504;
    };

    const parseRetryAfterMs = (headers: any): number => {
      if (!headers) return 0;
      const raw = headers['retry-after'] ?? headers['Retry-After'];
      if (raw === undefined || raw === null) return 0;

      // Most servers send seconds. If it isn't numeric, ignore for simplicity.
      const seconds = Number(raw);
      if (!Number.isFinite(seconds) || seconds <= 0) return 0;
      return seconds * 1000;
    };

    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        const result: any = await fn();

        // When callers use validateStatus: () => true, Axios won't throw on 429/5xx.
        // Detect those responses here so we can retry consistently.
        const status = typeof result?.status === 'number' ? (result.status as number) : undefined;
        if (isRetryableStatus(status)) {
          const err: any = new Error(`${label} retryable status=${status}`);
          err.response = result;
          throw err;
        }

        return result as T;
      } catch (err: any) {
        lastError = err;
        const status = err?.response?.status;
        const shouldRetry = isRetryableStatus(status);

        if (!shouldRetry || attempt === attempts) {
          logger.error(`${label} failed after ${attempt} attempt(s): ${String(err)}`);
          throw err;
        }

        const retryAfterMs = parseRetryAfterMs(err?.response?.headers);
        const backoffMs = baseDelayMs * Math.pow(2, attempt - 1);
        const waitMs = status === 429 ? Math.max(15_000, retryAfterMs) : Math.max(backoffMs, retryAfterMs);
        logger.warn(`${label} attempt ${attempt} failed with status=${status}. Retrying in ${waitMs}ms.`);
        await new Promise((resolve) => setTimeout(resolve, waitMs));
      }
    }

    throw lastError;
  }

  private getActivationIdFromUrl(url: string): string | null {
    try {
      const matches = url.match(/\/activar\/[^/]+\/(\d+)\/?$/);
      return matches?.[1] ?? null;
    } catch {
      return null;
    }
  }

  private async createGeonetClient(): Promise<AxiosInstance> {
    const username = process.env.GEONET_USER || process.env.ADMIN_LOGIN;
    const password = process.env.GEONET_PASS || process.env.ADMIN_PASSWORD;
    if (!username || !password) {
      const err: any = new Error('Credenciales GEONET no configuradas en GEONET_USER/GEONET_PASS');
      err.statusCode = 500;
      throw err;
    }

    const jar = new CookieJar();
    const client: AxiosInstance = wrapper(axios.create({ jar, withCredentials: true }));

    const loginUrl = 'https://admin.geonet.cl/accounts/login/';
    await this.withRetry(
      () => client.get(loginUrl, { headers: { 'User-Agent': 'Mozilla/5.0 (Node.js Scraper)' } }),
      'GET login',
      6,
      2000
    );

    const cookiesForHost = await jar.getCookies(loginUrl);
    const csrfCookie = cookiesForHost.find((c: Cookie) => c.key === 'csrftoken');
    const csrfToken = csrfCookie?.value;
    if (!csrfToken) {
      const err: any = new Error('No se pudo obtener csrftoken al cargar login');
      err.statusCode = 502;
      throw err;
    }

    const form = new URLSearchParams();
    form.append('csrfmiddlewaretoken', csrfToken);
    form.append('login', username);
    form.append('password', password);
    form.append('next', '/panel/');

    await this.withRetry(
      () =>
        client.post(loginUrl, form.toString(), {
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            Referer: loginUrl,
            'User-Agent': 'Mozilla/5.0 (Node.js Scraper)',
            Cookie: `csrftoken=${csrfToken}`,
          },
          maxRedirects: 0,
          validateStatus: (status) => status >= 200 && status < 400,
        }),
      'POST login',
      6,
      2000
    );

    const postCookies = await jar.getCookies(loginUrl);
    if (!postCookies.find((c: Cookie) => c.key === 'sessionid')) {
      const err: any = new Error('Login falló: no se obtuvo sessionid');
      err.statusCode = 401;
      throw err;
    }

    return client;
  }
}