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

  // =========================================================================
  // INFRAESTRUCTURA PUPPETEER (Optimizado y Tolerante a Fallos)
  // =========================================================================

  private async getBrowser(): Promise<Browser> {
    // Reutilizar conexión activa
    if ((global as any).__sharedBrowser) {
      try { return (global as any).__sharedBrowser as Browser; } catch {}
    }

    const MAX_ATTEMPTS = 3;
    let lastErr: any = null;
    
    // Inyectamos stealth=true y timeout=120000 para evitar que Browserless corte la conexión prematuramente
    const timeout = 120000;
    const wsUrl = `${BROWSER_WS}${BROWSER_WS.includes('?') ? '&' : '?'}stealth=true&timeout=${timeout}`;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        logger.info(`[Puppeteer Import] Conectando a ${wsUrl} (intento ${attempt})...`);
        const browser = await puppeteer.connect({
          browserWSEndpoint: wsUrl,
          defaultViewport: { width: 1920, height: 1080 }
        });

        // Guardar el disconnect real y reemplazar por noop para reutilización
        (browser as any).__realDisconnect = (browser as any).disconnect?.bind(browser) || null;
        (browser as any).disconnect = async () => { /* noop: conexión compartida */ };

        (global as any).__sharedBrowser = browser;
        return browser;
      } catch (err: any) {
        lastErr = err;
        logger.warn(`[Puppeteer Import] Error conectando a browserless: ${err.message || err}. Reintentando...`);
        await new Promise((res) => setTimeout(res, 1000 * attempt));
      }
    }
    throw new Error(`No se pudo conectar a Browserless: ${lastErr?.message || lastErr}`);
  }

  public async shutdownBrowser(): Promise<void> {
    const shared = (global as any).__sharedBrowser as Browser | undefined;
    if (!shared) return;
    const real = (shared as any).__realDisconnect;
    try {
      if (real) await real();
    } catch (e: any) {
      logger.warn('[Puppeteer Import] Error cerrando browser:', e?.message || e);
    }
    (global as any).__sharedBrowser = null;
  }

private async openPage(): Promise<{ browser: Browser; page: Page }> {
    let browser = await this.getBrowser();
    try {
      const page = await browser.newPage();
      
      page.setDefaultNavigationTimeout(60000); 

      // IMPORTANTE: Hemos eliminado page.setRequestInterception. 
      // Cloudflare detecta si no descargas el CSS o las imágenes.

      // Falsificamos un agente de usuario normal y cabeceras humanas
      await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36');
      await page.setExtraHTTPHeaders({
        'Accept-Language': 'es-CL,es-419;q=0.9,es;q=0.8,en;q=0.7',
        'sec-ch-ua': '"Chromium";v="122", "Not(A:Brand";v="24", "Google Chrome";v="122"',
        'sec-ch-ua-mobile': '?0',
        'sec-ch-ua-platform': '"Windows"',
        'Upgrade-Insecure-Requests': '1'
      });

      return { browser, page };
    } catch (err: any) {
      logger.warn('[Puppeteer Import] newPage falló, intentando reconectar...', err?.message || err);
      try { await this.shutdownBrowser(); } catch (e) {}
      browser = await this.getBrowser();
      const page = await browser.newPage();
      return { browser, page };
    }
  }

private async ensureSession(page: Page, opts?: { force?: boolean }): Promise<boolean> {
    const start = Date.now();
    try {
      if (page.isClosed()) return false;

      const isCookieFresh = (Date.now() - cookiesTimestamp) < 1000 * 60 * 45; 
      if (!opts?.force && cachedCookies && cachedCookies.length > 0 && isCookieFresh) {
        await page.setCookie(...cachedCookies);
        return true;
      }

      logger.info('Iniciando login vía Puppeteer Import (Navegando a Geonet)...');
      
      // 1. Navegación inicial y captura del código de estado HTTP
      const response = await page.goto(`${GEONET_BASE_URL}/accounts/login/`, { 
        waitUntil: 'networkidle2', 
        timeout: 90000 
      });

      if (response) {
        const status = response.status();
        logger.info(`[Puppeteer Import] Status HTTP inicial: ${status}`);
        if (status === 429) {
          logger.error('⚠️ ALERTA CLOUDFLARE: Status 429 (Too Many Requests). La IP está bloqueada temporalmente por Geonet.');
        } else if (status === 403) {
          logger.error('⚠️ ALERTA CLOUDFLARE: Status 403 (Forbidden). Cloudflare bloqueó el acceso directamente.');
        }
      }

      // 2. Lógica de Evasión de Cloudflare
      const isCloudflare = await page.evaluate(() => {
        const text = document.body.innerText.toLowerCase();
        return text.includes('just a moment') || 
               text.includes('verifying') || 
               !!document.querySelector('#cf-challenge') ||
               window.location.href.includes('__cf_chl_rt_tk');
      });

      if (isCloudflare) {
        logger.warn('⚠️ Cloudflare Challenge detectado. Iniciando contramedidas...');
        
        try {
          await page.mouse.move(100, 100);
          await page.mouse.move(200, 200, { steps: 10 });
          await page.mouse.move(150, 300, { steps: 20 });
        } catch (e) {}

        try {
          await page.waitForFunction(() => {
            return !document.body.innerText.toLowerCase().includes('verifying') &&
                   !!document.querySelector('input[name="login"]');
          }, { timeout: 30000 });
          logger.info('✅ Reto de Cloudflare superado (Login visible).');
        } catch (e) {
          // LOG EXPLÍCITO DE LO QUE ESTÁ EN PANTALLA SI FALLA EL RETO
          const htmlDump = await page.evaluate(() => document.body.innerText.substring(0, 400).replace(/\n/g, ' | '));
          logger.error(`❌ Fallo al superar Cloudflare. Texto en pantalla: [${htmlDump}]`);
        }
      }

      // 3. Login Real con Log Explícito
      try {
        await page.waitForSelector('input[name="login"]', { timeout: 15000 });
      } catch (error) {
        // AQUÍ LOGUEAMOS QUÉ PASÓ REALMENTE SI NO APARECE EL LOGIN
        const currentUrl = page.url();
        const pageTitle = await page.title();
        const bodyText = await page.evaluate(() => document.body.innerText.substring(0, 400).replace(/\n/g, ' | '));
        
        logger.error(`[Puppeteer Import] Fallo crítico: No se encontró el formulario de login.`);
        logger.error(`--> 🕵️ URL Final: ${currentUrl}`);
        logger.error(`--> 🕵️ Título de Pestaña: ${pageTitle}`);
        logger.error(`--> 🕵️ Texto Visible: ${bodyText}`);
        
        return false;
      }

      const username = process.env.GEONET_USER || process.env.ADMIN_LOGIN || 'Jorgeprac@geonet';
      const password = process.env.GEONET_PASS || process.env.ADMIN_PASSWORD || 'JorgePrac';

      await page.click('input[name="login"]', { clickCount: 3 });
      await page.type('input[name="login"]', username, { delay: 75 }); 
      
      await page.click('input[name="password"]', { clickCount: 3 });
      await page.type('input[name="password"]', password, { delay: 75 });

      await Promise.all([
        page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 45000 }).catch(() => null),
        page.click('button[type="submit"]')
      ]);

      const finalUrl = page.url();
      if (!finalUrl.includes('/accounts/login/') && !finalUrl.includes('__cf_chl_rt_tk')) {
        cachedCookies = await page.cookies();
        cookiesTimestamp = Date.now();
        logger.info(`✅ Login GeonetImportService exitoso. T: ${Date.now() - start}ms`);
        return true;
      }
      
      logger.error(`Fallo login import. URL atrapada: ${finalUrl}`);
      return false;
    } catch (error: any) {
      logger.error(`[Puppeteer Import] Error fatal en login: ${error.message}`);
      return false;
    }
  }

  private async safeGoto(page: Page, url: string, opts?: { waitForSelector?: string; timeout?: number }): Promise<string> {
    const timeout = opts?.timeout ?? 45000;
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout });
    
    // Si al intentar ir a la URL nos patea al login, renovamos sesión
    if (page.url().includes('/accounts/login/')) {
      const loggedIn = await this.ensureSession(page, { force: true });
      if (!loggedIn) throw new Error('Sesión expirada y no se pudo re-autenticar');
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout });
    }
    
    if (opts?.waitForSelector) {
      await page.waitForSelector(opts.waitForSelector, { timeout: 15000 }).catch(() => null);
    }
    
    return await page.content();
  }

  // --- FLUJO PRINCIPAL ---

  public async importFromGeonet(opts: GeonetImportOptions): Promise<void> {
    await this.ensureDataSource();
    const { browser, page } = await this.openPage();

    try {
      // Llamada corregida: solo pasamos la página (ensureSession usará las env vars)
      const loggedIn = await this.ensureSession(page);
      if (!loggedIn) throw new Error('No se pudo iniciar sesión en Geonet');

      if (opts.dataPageUrl) {
        const html = await this.safeGoto(page, opts.dataPageUrl);
        await this.importSectorials(html, opts.dataPageUrl);
      }
      
      if (opts.onuPageUrl) {
        const html = await this.safeGoto(page, opts.onuPageUrl);
        await this.importOnus(html, opts.onuPageUrl);
      }

    } catch (error: any) {
      logger.error(`Error crítico en importación: ${error.message}`);
    } finally {
      await page.close();
      // NO Hacemos await browser.disconnect() para aprovechar el Singleton.
    }
  }

  /**
   * SECTORIALES: Sincronización Completa
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