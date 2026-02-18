import AppDataSource, { initializeDataSource } from '../database/data-source';
import { SectorialNode } from '../entities/SectorialNode';
// import { Onu } from '../entities/Onu'; 
import axios, { AxiosInstance } from 'axios';
import { wrapper } from 'axios-cookiejar-support';
import { CookieJar } from 'tough-cookie';
import * as cheerio from 'cheerio';
import logger from '../utils/logger';
import { In, Not } from 'typeorm';

type GeonetImportOptions = {
  loginUrl: string;
  dataPageUrl: string;
  onuPageUrl?: string;
  username: string;
  password: string;
};

// Helper para limpiar strings
const clean = (val: any) => (val ? String(val).trim() : null);
// Helper para limpiar números
const cleanNum = (val: any) => {
  if (!val) return 0;
  const num = parseInt(String(val).replace(/\D/g, ''), 10);
  return isNaN(num) ? 0 : num;
};

export class GeonetImportService {
  private client: AxiosInstance;
  private jar: CookieJar;

  constructor() {
    this.jar = new CookieJar();
    this.client = wrapper(axios.create({
      jar: this.jar,
      withCredentials: true,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8'
      }
    }));
  }

  private async ensureDataSource(): Promise<void> {
    if (!AppDataSource.isInitialized) await initializeDataSource();
  }

  // Autenticación Robustecida
  private async authenticate(loginUrl: string, user: string, pass: string): Promise<void> {
    try {
      logger.info(`Conectando a ${loginUrl} para obtener token CSRF...`);
      const getResponse = await this.client.get(loginUrl);
      
      const $ = cheerio.load(getResponse.data);
      const csrfToken = $('input[name="csrfmiddlewaretoken"]').val() as string;

      if (!csrfToken) throw new Error('No se encontró csrfmiddlewaretoken en el login');

      const params = new URLSearchParams();
      params.append('csrfmiddlewaretoken', csrfToken);
      params.append('login', user);       
      params.append('password', pass);
      params.append('next', '/panel/');   
      params.append('remember', '1');     

      logger.info('Enviando credenciales...');
      const postResponse = await this.client.post(loginUrl, params.toString(), {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Referer': loginUrl
        },
        maxRedirects: 5
      });

      if (postResponse.request.res.responseUrl.includes('login') && !postResponse.request.res.responseUrl.includes('panel')) {
         if (String(postResponse.data).includes('Introzca un nombre de usuario y contraseña correctos')) {
             throw new Error('Credenciales inválidas');
         }
      }
      logger.info('Login autenticado exitosamente.');
    } catch (error: any) {
      logger.error(`Fallo en autenticación: ${error.message}`);
      throw error;
    }
  }

  public async importFromGeonet(opts: GeonetImportOptions): Promise<void> {
    await this.ensureDataSource();

    try {
      await this.authenticate(opts.loginUrl, opts.username, opts.password);

      if (opts.dataPageUrl) {
        await this.importSectorials(opts.dataPageUrl);
      }
      
      if (opts.onuPageUrl) {
        await this.importOnus(opts.onuPageUrl);
      }

    } catch (error: any) {
      logger.error(`Error crítico en importación: ${error.message}`);
    }
  }

  /**
   * SECTORIALES: Sincronización Completa
   */
  private async importSectorials(url: string) {
    logger.info(`Descargando tabla de Sectoriales: ${url}`);
    const response = await this.client.get(url);
    const records = this.parseHtmlTable(response.data);
    
    if (records.length === 0) {
        logger.warn('Tabla vacía. No se realizaron cambios en la BD.');
        return;
    }

    logger.info(`Procesando ${records.length} sectoriales...`);
    const repo = AppDataSource.getRepository(SectorialNode);
    const processedNames: string[] = [];
    let count = 0;

    for (const row of records) {
        const entity = new SectorialNode();

        // --- MAPEO COMPLETO BASADO EN EL CSV ---
        // Usamos una búsqueda flexible por si el HTML tiene espacios extra
        const getVal = (keyPart: string) => {
            const realKey = Object.keys(row).find(k => k.toLowerCase().includes(keyPart.toLowerCase()));
            return realKey ? row[realKey] : null;
        };

        entity.nombre = clean(getVal('Nombre')) ?? ''; 
        entity.tipo = clean(getVal('Tipo'));
        entity.ip = clean(getVal('Ip'));
        entity.usuario = clean(getVal('Usuario'));
        entity.password = clean(getVal('Password'));
        
        // Aquí están los campos que faltaban:
        entity.zona = clean(getVal('Zona')); 
        entity.coordenadas = clean(getVal('Coordenadas')); 
        entity.totalClientes = cleanNum(getVal('Total de Clientes'));
        entity.ssid = clean(getVal('SSID'));
        entity.frecuencias = clean(getVal('Frecuencia'));
        entity.nodoTorre = clean(getVal('Nodo/Torre'));
        entity.comentarios = clean(getVal('Comentarios'));
        entity.accion = clean(getVal('Acción'));
        
        entity.fallaGeneral = (getVal('Falla General') === 'Si' || getVal('Falla') === 'Si') ? 'Si' : 'No';

        // Solo guardamos si tiene nombre válido
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

    // --- LIMPIEZA: Borrar lo que ya no existe ---
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
  private async importOnus(url: string) {
    logger.info(`Descargando tabla de ONUs: ${url}`);
    try {
        const response = await this.client.get(url);
        const records = this.parseHtmlTable(response.data);

        if (records.length === 0) return;

        let count = 0;
        for (const row of records) {
            // Ejemplo de mapeo para ONUs
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
    
    // Extraer headers y limpiar espacios raros (&nbsp;)
    $('table thead tr th').each((i, el) => {
      let text = $(el).text().replace(/\s+/g, ' ').trim(); // Normaliza espacios
      if (!text) text = `col_${i}`;
      headers.push(text);
    });

    $('table tbody tr').each((i, row) => {
      const record: any = {};
      $(row).find('td').each((j, cell) => {
        const header = headers[j];
        if (header && !header.startsWith('col_')) {
            // Limpiar saltos de linea dentro de la celda
            record[header] = $(cell).text().replace(/\n/g, '').trim();
        }
      });
      // Solo agregamos la fila si tiene datos
      if (Object.keys(record).length > 0) records.push(record);
    });

    return records;
  }
}