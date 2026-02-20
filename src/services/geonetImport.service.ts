import AppDataSource, { initializeDataSource } from '../database/data-source';
import { SectorialNode } from '../entities/SectorialNode';
import * as cheerio from 'cheerio';
import logger from '../utils/logger';
import { In, Not } from 'typeorm';
import puppeteer, { Browser, Page } from 'puppeteer-core';

// --- CONFIGURACIÓN PUPPETEER ---
const BROWSER_WS = process.env.BROWSER_WS_ENDPOINT || 'ws://browser:3000';
const GEONET_BASE_URL = 'https://admin.geonet.cl';

let cachedCookies: any[] | null = null;
let cookiesTimestamp: number = 0;

type GeonetImportOptions = {
  loginUrl: string;
  dataPageUrl: string;
  onuPageUrl?: string;
  username: string;
  password: string;
};

const clean = (val: any) => (val ? String(val).trim() : null);
const cleanNum = (val: any) => {
  if (!val) return 0;
  const num = parseInt(String(val).replace(/\D/g, ''), 10);
  return isNaN(num) ? 0 : num;
};

export class GeonetImportService {
  constructor() {}

  private async ensureDataSource(): Promise<void> {
    if (!AppDataSource.isInitialized) await initializeDataSource();
  }

  // --- INFRAESTRUCTURA PUPPETEER (Copiada del servicio funcional) ---

  private async getBrowser(): Promise<Browser> {
    if ((global as any).__sharedBrowser) {
      try { return (global as any).__sharedBrowser as Browser; } catch {}
    }
    const MAX_ATTEMPTS = 3;
    let lastErr: any = null;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        const browser = await puppeteer.connect({
          browserWSEndpoint: BROWSER_WS,
          defaultViewport: { width: 1920, height: 1080 }
        });
        (browser as any).__realDisconnect = browser.disconnect.bind(browser);
        browser.disconnect = async () => {}; // Reutilizar conexión
        (global as any).__sharedBrowser = browser;
        return browser;
      } catch (err) {
        lastErr = err;
        await new Promise((res) => setTimeout(res, 1000 * attempt));
      }
    }
    throw new Error(`No se pudo conectar a Browserless: ${lastErr?.message}`);
  }

  private async openPage(): Promise<{ browser: Browser; page: Page }> {
    let browser = await this.getBrowser();
    try {
      const page = await browser.newPage();
      page.setDefaultNavigationTimeout(45000);

      // Bloquear recursos innecesarios (modo invisible)
      try {
        await page.setRequestInterception(true);
        const blockedResourceTypes = new Set(['image', 'stylesheet', 'font']);
        const blockedUrlPatterns = [
          'google-analytics', 'googletagmanager', 'doubleclick', 'analytics.js',
          'gtag/js', 'adsystem.com', 'ads.google', 'facebook.net',
          'connect.facebook.net', 'hotjar', 'mixpanel', 'matomo'
        ];

        page.on('request', (req) => {
          try {
            const url = req.url().toLowerCase();
            const rType = req.resourceType();
            if (blockedResourceTypes.has(rType)) return req.abort();
            for (const p of blockedUrlPatterns) if (url.includes(p)) return req.abort();
            return req.continue();
          } catch (e) {
            try { req.continue(); } catch (_) {}
          }
        });
      } catch (e) {
        // Ignorar si falla la intercepción
      }

      await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36');
      
      return { browser, page };
    } catch (err) {
      if ((global as any).__sharedBrowser) {
        try { await ((global as any).__sharedBrowser as any).__realDisconnect(); } catch {}
        (global as any).__sharedBrowser = null;
      }
      browser = await this.getBrowser();
      const page = await browser.newPage();
      return { browser, page };
    }
  }

  private async ensureSession(page: Page, user: string, pass: string, opts?: { force?: boolean }): Promise<boolean> {
    try {
      const isCookieFresh = (Date.now() - cookiesTimestamp) < 1000 * 60 * 45; // 45 min
      if (!opts?.force && cachedCookies && cachedCookies.length > 0 && isCookieFresh) {
        await page.setCookie(...cachedCookies);
        return true;
      }

      logger.info('Iniciando login vía Puppeteer...');
      await page.goto(`${GEONET_BASE_URL}/accounts/login/`, { waitUntil: 'domcontentloaded', timeout: 15000 });
      await page.waitForSelector('input[name="login"]', { timeout: 10000 });

      await page.click('input[name="login"]', { clickCount: 3 });
      await page.type('input[name="login"]', user);
      await page.click('input[name="password"]', { clickCount: 3 });
      await page.type('input[name="password"]', pass);

      await Promise.all([
        page.waitForNavigation({ waitUntil: 'domcontentloaded' }).catch(() => null),
        page.click('button[type="submit"]')
      ]);

if (!page.url().includes('/accounts/login/')) {
        cachedCookies = await page.cookies();
        cookiesTimestamp = Date.now();
        logger.info('Login Puppeteer exitoso.');
        return true;
      }

      // --- INICIO DE ZONA DE DEBUGGING ---
      // 1. Extraemos los primeros 500 caracteres de texto de la página para ver si dice "Contraseña incorrecta" o "Cloudflare"
      const textoVisible = await page.evaluate(() => {
        return document.body.innerText.substring(0, 500).replace(/\n/g, ' ');
      });
      
      logger.error(`Fallo el login, la URL sigue siendo: ${page.url()}`);
      logger.error(`Texto visible en la pantalla del bot: ${textoVisible}`);

      // 2. Opcional: Toma una captura de pantalla y la guarda dentro del contenedor Docker
      const errorPath = `/tmp/geonet_login_failed_${Date.now()}.png`;
      await page.screenshot({ path: errorPath, fullPage: true });
      logger.info(`Captura de pantalla guardada en el contenedor en: ${errorPath}`);
      // --- FIN DE ZONA DE DEBUGGING ---

      return false;
      logger.error('Fallo el login, URL no cambió.');
      return false;
    } catch (error) {
      logger.error(`[Puppeteer] Fallo ensureSession: ${error}`);
      return false;
    }
  }

  private async safeGoto(page: Page, url: string, user: string, pass: string): Promise<string> {
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    if (page.url().includes('/accounts/login/')) {
      await this.ensureSession(page, user, pass, { force: true });
      await page.goto(url, { waitUntil: 'domcontentloaded' });
    }
    // Devolvemos el HTML completo de la página
    return await page.content();
  }

  // --- FLUJO PRINCIPAL ---

  public async importFromGeonet(opts: GeonetImportOptions): Promise<void> {
    await this.ensureDataSource();
    const { browser, page } = await this.openPage();

    try {
      // Garantizar la sesión antes de navegar
      const loggedIn = await this.ensureSession(page, opts.username, opts.password);
      if (!loggedIn) throw new Error('No se pudo iniciar sesión en Geonet');

      if (opts.dataPageUrl) {
        const html = await this.safeGoto(page, opts.dataPageUrl, opts.username, opts.password);
        await this.importSectorials(html, opts.dataPageUrl);
      }
      
      if (opts.onuPageUrl) {
        const html = await this.safeGoto(page, opts.onuPageUrl, opts.username, opts.password);
        await this.importOnus(html, opts.onuPageUrl);
      }

    } catch (error: any) {
      logger.error(`Error crítico en importación: ${error.message}`);
    } finally {
      await page.close();
      await browser.disconnect();
    }
  }

  /**
   * SECTORIALES: Sincronización Completa
   * Nota: Ahora recibe el HTML directamente en lugar de hacer un GET con Axios
   */
  private async importSectorials(html: string, url: string) {
    logger.info(`Analizando HTML de Sectoriales desde: ${url}`);
    const records = this.parseHtmlTable(html);
    
    if (records.length === 0) {
        logger.warn('Tabla vacía o no detectada en el DOM. No se realizaron cambios en la BD.');
        return;
    }

    logger.info(`Procesando ${records.length} sectoriales...`);
    const repo = AppDataSource.getRepository(SectorialNode);
    const processedNames: string[] = [];
    let count = 0;

    for (const row of records) {
        const entity = new SectorialNode();

        const getVal = (keyPart: string) => {
            const realKey = Object.keys(row).find(k => k.toLowerCase().includes(keyPart.toLowerCase()));
            return realKey ? row[realKey] : null;
        };

        entity.nombre = clean(getVal('Nombre')) ?? ''; 
        entity.tipo = clean(getVal('Tipo'));
        entity.ip = clean(getVal('Ip'));
        entity.usuario = clean(getVal('Usuario'));
        entity.password = clean(getVal('Password'));
        entity.zona = clean(getVal('Zona')); 
        entity.coordenadas = clean(getVal('Coordenadas')); 
        entity.totalClientes = cleanNum(getVal('Total de Clientes'));
        entity.ssid = clean(getVal('SSID'));
        entity.frecuencias = clean(getVal('Frecuencia'));
        entity.nodoTorre = clean(getVal('Nodo/Torre'));
        entity.comentarios = clean(getVal('Comentarios'));
        entity.accion = clean(getVal('Acción'));
        entity.fallaGeneral = (getVal('Falla General') === 'Si' || getVal('Falla') === 'Si') ? 'Si' : 'No';

        if (entity.nombre) {
            processedNames.push(entity.nombre); 

            const existing = await repo.findOne({ where: { nombre: entity.nombre } });
            if (existing) {
                repo.merge(existing, entity);
                await repo.save(existing);
            } else {
                await repo.save(entity);
            }
            count++;
        }
    }

    if (processedNames.length > 0) {
        const deleteResult = await repo.delete({
            nombre: Not(In(processedNames))
        });
        if (deleteResult.affected && deleteResult.affected > 0) {
            logger.info(`Limpieza: Se eliminaron ${deleteResult.affected} sectoriales antiguos.`);
        }
    }

    logger.info(`Sectoriales: ${count} sincronizados correctamente.`);
  }

  /**
   * ONUS: Simulación (Actualizar con tu entidad real)
   */
  private async importOnus(html: string, url: string) {
    logger.info(`Analizando HTML de ONUs desde: ${url}`);
    try {
        const records = this.parseHtmlTable(html);

        if (records.length === 0) return;

        let count = 0;
        for (const row of records) {
            const serial = row['Serial'] || row['MAC'] || row['Mac Address'];
            if (serial) {
               // logica de guardado...
               count++;
            }
        }
        logger.info(`ONUs: ${count} detectadas (Simulación).`);
    } catch (err: any) {
        logger.error(`Error importando ONUs: ${err.message}`);
    }
  }

  /**
   * PARSER HTML MEJORADO
   */
  private parseHtmlTable(html: string): any[] {
    const $ = cheerio.load(html);
    const records: any[] = [];
    const headers: string[] = [];
    
    $('table thead tr th').each((i, el) => {
      let text = $(el).text().replace(/\s+/g, ' ').trim();
      if (!text) text = `col_${i}`;
      headers.push(text);
    });

    $('table tbody tr').each((i, row) => {
      const record: any = {};
      $(row).find('td').each((j, cell) => {
        const header = headers[j];
        if (header && !header.startsWith('col_')) {
            record[header] = $(cell).text().replace(/\n/g, '').trim();
        }
      });
      if (Object.keys(record).length > 0) records.push(record);
    });

    return records;
  }
}