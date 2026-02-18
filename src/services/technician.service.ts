import AppDataSource, { initializeDataSource } from '../database/data-source';
import { Technician } from '../entities/Technician';
import { DeepPartial } from 'typeorm';
import axios, { AxiosInstance } from 'axios';
import { wrapper } from 'axios-cookiejar-support';
import { Cookie, CookieJar } from 'tough-cookie';
import * as cheerio from 'cheerio';
import * as fs from 'fs';
import * as path from 'path';
import logger from '../utils/logger';

export class TechnicianService {
  private geonetClient: AxiosInstance | null = null;
  private geonetClientPromise: Promise<AxiosInstance> | null = null;
  private geonetClientCreatedAtMs = 0;

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

  private isGeonetLoginHtml(html: any): boolean {
    if (typeof html !== 'string') return false;
    const lower = html.toLowerCase();
    return lower.includes('/accounts/login') && (lower.includes('name="login"') || lower.includes('name="password"'));
  }

  private async createGeonetClient(): Promise<AxiosInstance> {
    const username = process.env.GEONET_USER || process.env.ADMIN_LOGIN;
    const password = process.env.GEONET_PASS || process.env.ADMIN_PASSWORD;
    if (!username || !password) {
      throw new Error('Credenciales GEONET no configuradas en GEONET_USER/GEONET_PASS');
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
      throw new Error('No se pudo obtener csrftoken al cargar login');
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
      throw new Error('Login falló: no se obtuvo sessionid');
    }

    return client;
  }

  private async getGeonetClient(forceNew = false): Promise<AxiosInstance> {
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

  public async getAll(): Promise<Technician[]> {
    await this.ensureDataSource();
    const repo = AppDataSource.getRepository(Technician);
    return repo.find({ order: { id: 'DESC' } });
  }

  public async create(data: DeepPartial<Technician>): Promise<Technician> {
    await this.ensureDataSource();
    const repo = AppDataSource.getRepository(Technician);

    const technician = repo.create({
      firstName: String(data.firstName ?? '').trim(),
      lastName: String(data.lastName ?? '').trim(),
      phone: String(data.phone ?? '').trim(),
      email: data.email ? String(data.email).trim() : null,
      telegramChatId: data.telegramChatId ? String(data.telegramChatId).trim() : null,
      isActive: typeof data.isActive === 'boolean' ? data.isActive : true,
    });

    return repo.save(technician);
  }

  public async update(id: number, data: DeepPartial<Technician>): Promise<Technician | null> {
    await this.ensureDataSource();
    const repo = AppDataSource.getRepository(Technician);

    const technician = await repo.findOne({ where: { id } });
    if (!technician) return null;

    if (data.firstName !== undefined) technician.firstName = String(data.firstName).trim();
    if (data.lastName !== undefined) technician.lastName = String(data.lastName).trim();
    if (data.phone !== undefined) technician.phone = String(data.phone).trim();
    if (data.email !== undefined) technician.email = data.email ? String(data.email).trim() : null;
    if (data.telegramChatId !== undefined)
      technician.telegramChatId = data.telegramChatId ? String(data.telegramChatId).trim() : null;
    if (data.isActive !== undefined) technician.isActive = Boolean(data.isActive);

    return repo.save(technician);
  }

  public async remove(id: number): Promise<boolean> {
    await this.ensureDataSource();
    const repo = AppDataSource.getRepository(Technician);

    const result = await repo.delete({ id });
    return Boolean(result.affected);
  }

  private getCookieHeader(cookieFilePath = 'cookies.txt'): string {
    try {
      const cookiePath = path.resolve(cookieFilePath);
      if (!fs.existsSync(cookiePath)) return '';

      const cookieContent = fs.readFileSync(cookiePath, 'utf-8');
      const cookies: string[] = [];
      cookieContent.split('\n').forEach(line => {
        if (line && !line.startsWith('#')) {
          const parts = line.split('\t');
          if (parts.length >= 7) {
            cookies.push(`${parts[5]}=${parts[6].trim()}`);
          }
        }
      });
      return cookies.join('; ');
    } catch (error) {
      logger.error(`Error reading cookies in service: ${String(error)}`);
      return '';
    }
  }

  private async loginAndGetCookieHeader(): Promise<string> {
    // Backwards-compatible helper: still returns Cookie header string,
    // but internally we now login using the same jar-based flow.
    const client = await this.getGeonetClient(true);
    const jar: any = (client as any).defaults?.jar;
    if (jar && typeof jar.getCookies === 'function') {
      const loginUrl = 'https://admin.geonet.cl/accounts/login/';
      const cookies = await jar.getCookies(loginUrl);
      return cookies.map((c: any) => `${c.key}=${c.value}`).join('; ');
    }
    return '';
  }

  public async syncFromWeb(cookieFilePath = 'cookies.txt') {
    await this.ensureDataSource();
    const repo = AppDataSource.getRepository(Technician);

    // 1) Try cookies.txt if present; if it redirects to login, fallback to jar-login automatically.
    let html = '';
    const cookieHeaderFromFile = this.getCookieHeader(cookieFilePath);
    if (cookieHeaderFromFile) {
      const resp = await this.withRetry(
        () =>
          axios.get('https://admin.geonet.cl/staff/', {
            headers: {
              Cookie: cookieHeaderFromFile,
              'User-Agent': 'Mozilla/5.0 (Node.js Scraper)',
            },
            validateStatus: () => true,
          }),
        'GET staff (cookie file)'
      );
      if (resp.status >= 200 && resp.status < 300 && !this.isGeonetLoginHtml(resp.data)) {
        html = resp.data;
      }
    }

    // 2) Fallback: use authenticated jar client (auto refresh)
    if (!html) {
      for (let attempt = 1; attempt <= 2; attempt++) {
        const client = await this.getGeonetClient(attempt > 1);
        const resp = await this.withRetry(
          () =>
            client.get('https://admin.geonet.cl/staff/', {
              headers: {
                'User-Agent': 'Mozilla/5.0 (Node.js Scraper)',
              },
              validateStatus: () => true,
            }),
          'GET staff'
        );

        if (resp.status >= 200 && resp.status < 300 && !this.isGeonetLoginHtml(resp.data)) {
          html = resp.data;
          break;
        }

        // If we got the login page, invalidate and retry once
        if (this.isGeonetLoginHtml(resp.data) && attempt === 1) {
          logger.warn('syncFromWeb: sesión expirada, re-login y reintento');
          this.invalidateGeonetClient();
          continue;
        }

        const bodyPreview =
          typeof resp.data === 'string' ? resp.data.slice(0, 800) : JSON.stringify(resp.data).slice(0, 800);
        throw new Error(`GET staff falló status=${resp.status} body=${bodyPreview}`);
      }
    }

    const $ = cheerio.load(html);
    const rows = $('table#data-table-generic tbody tr');
    let addedCount = 0;
    const createdTechs: Technician[] = [];

    for (let i = 0; i < rows.length; i++) {
      const el = rows[i];
      const cols = $(el).find('td');

      const fullName = cols.eq(0).text().trim();
      const email = cols.eq(1).text().trim();
      const level = cols.eq(2).text().trim();

      if (level === 'Administrador' || level === 'Tecnico') {
        if (!email) continue;

        const exists = await repo.findOne({ where: { email } });
        if (!exists) {
          const nameParts = fullName.split(' ');
          const firstName = nameParts[0] || 'Staff';
          const lastName = nameParts.slice(1).join(' ') || 'Staff';

          const newTech = repo.create({
            firstName: String(firstName).trim(),
            lastName: String(lastName).trim(),
            email: String(email).trim(),
            phone: null,
            telegramChatId: null,
            isActive: true
          });

          const saved = await repo.save(newTech);
          createdTechs.push(saved);
          addedCount++;
        }
      }
    }

    return {
      message: 'Sincronización finalizada',
      added: addedCount,
      details: createdTechs
    };
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
      const seconds = Number(raw);
      if (!Number.isFinite(seconds) || seconds <= 0) return 0;
      return seconds * 1000;
    };

    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        const result: any = await fn();
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
}
