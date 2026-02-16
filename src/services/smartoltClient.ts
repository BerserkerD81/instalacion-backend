import axios from 'axios';
import { SMARTOLT } from '../config';

const baseUrl = SMARTOLT.baseUrl?.replace(/\/$/, '') || '';

type CacheEntry = {
  value: any;
  expires: number;
  pending?: Promise<any>;
};

const smartoltCache = new Map<string, CacheEntry>();

// Session cookie cache for SmartOLT HTML login (fallback when API key returns 403)
const smartoltSessionCache: { cookie?: string; expires?: number } = {};

async function fromCache<T>(key: string, ttlMs: number, loader: () => Promise<T>): Promise<T> {
  const now = Date.now();
  const entry = smartoltCache.get(key);
  if (entry && entry.expires > now) return entry.value as T;
  if (entry?.pending) return entry.pending as Promise<T>;

  const pending = loader()
    .then((val) => {
      smartoltCache.set(key, { value: val, expires: Date.now() + ttlMs });
      return val;
    })
    .catch((err) => {
      smartoltCache.delete(key);
      throw err;
    });

  smartoltCache.set(key, { value: entry?.value, expires: entry?.expires || 0, pending });
  return pending;
}

function getHeaders() {
  if (!SMARTOLT.apiKey) throw new Error('SMARTOLT_API_KEY not configured');
  return {
    'X-Token': SMARTOLT.apiKey
  };
}

// Perform SmartOLT web login to get a session cookie when API key access is forbidden
async function getSmartoltSessionCookie(force?: boolean): Promise<string | null> {
  const identity = process.env.SMARTOLT_IDENTITY || process.env.SMARTOLT_USERNAME || process.env.SMARTOLT_EMAIL;
  const password = process.env.SMARTOLT_PASSWORD;
  if (!identity || !password) return null;
  if (!baseUrl) throw new Error('SMARTOLT_BASE_URL not configured');

  const now = Date.now();
  if (!force && smartoltSessionCache.cookie && smartoltSessionCache.expires && smartoltSessionCache.expires > now) {
    return smartoltSessionCache.cookie;
  }

  const form = new URLSearchParams();
  form.append('identity', identity);
  form.append('password', password);

  const res = await axios.post(`${baseUrl}/auth/login`, form, {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    maxRedirects: 5,
    validateStatus: (s) => s >= 200 && s < 400
  });

  const setCookie = res.headers['set-cookie'];
  if (!setCookie || !Array.isArray(setCookie) || !setCookie.length) return null;
  const cookieHeader = setCookie.map((c) => c.split(';')[0]).filter(Boolean).join('; ');
  if (!cookieHeader) return null;

  smartoltSessionCache.cookie = cookieHeader;
  smartoltSessionCache.expires = now + 10 * 60 * 1000; // 10 minutes TTL
  return cookieHeader;
}

async function get<T = any>(path: string) {
  if (!baseUrl) throw new Error('SMARTOLT_BASE_URL not configured');
  const res = await axios.get<T>(`${baseUrl}${path}`, {
    headers: getHeaders(),
    timeout: 15000
  });
  return res.data;
}





// Algunos endpoints de SmartOLT rechazan GET con "Unknown method" y requieren POST.
// Hacemos fallback automático a POST cuando vemos 405 o mensajes similares.
async function getWithPostFallback<T = any>(path: string) {
  try {
    return await get<T>(path);
  } catch (err: any) {
    const status = err?.response?.status;
    const msg = err?.response?.data?.error || err?.response?.data?.response;
    const methodRejected = status === 405 || (typeof msg === 'string' && /method/i.test(msg));
    if (!methodRejected) throw err;

    const res = await axios.post<T>(`${baseUrl}${path}`, undefined, {
      headers: getHeaders(),
      timeout: 15000
    });
    return res.data;
  }
}

async function fetchOdbs(): Promise<Array<{ id?: string; name?: string; zone_id?: string; zone_name?: string }>> {
  if (!baseUrl || !SMARTOLT.apiKey) throw new Error('Config missing');
  
  const url = `${baseUrl}/api/system/get_odbs`;

  try {
    const { data } = await axios.get(url, {
      headers: {
        'X-Token': SMARTOLT.apiKey,
        'Accept': 'application/json'
      },
      timeout: 30000 // Timeout alto por si la lista es grande
    });

    // La respuesta típica es { status: true, response: [...] }
    if (data && Array.isArray(data.response)) {
      return data.response;
    }

    // Por si la API devuelve el array directo
    if (Array.isArray(data)) {
      return data;
    }

    console.warn('fetchOdbs: Respuesta inesperada de SmartOLT', data);
    return [];

  } catch (err: any) {
    console.error('❌ Error fetching ODBs:', err?.message || err);
    return [];
  }
}

export async function getOdbs(options?: { cacheTtlMs?: number }) {
  const ttl = options?.cacheTtlMs ?? 5 * 60_000;
  return fromCache('odbs', ttl, fetchOdbs);
}
/**
 * Fetch available ports for an ODB by its externalId from SmartOLT API.
 * Returns the raw response (array, object, or wrapped in {response}).
 */
export async function getAvailablePortsForOdb(externalId: string | number): Promise<any> {
  if (!baseUrl) throw new Error('SMARTOLT_BASE_URL not configured');
  if (!SMARTOLT.apiKey) throw new Error('SMARTOLT_API_KEY not configured');
  if (!externalId) throw new Error('externalId required');
  // According to SmartOLT, this endpoint lives under /api/onu/
  const path = `/api/onu/fetch_available_ports_for_odb/${encodeURIComponent(String(externalId))}`;

  const unwrap = (data: any) => {
    if (data && typeof data === 'object' && Array.isArray((data as any).response)) return (data as any).response;
    if (data && typeof data === 'object' && (data as any).response) return (data as any).response;
    return data;
  };

  // First try with session cookie + token (mimic browser flow)
  const tryWithCookie = async (force?: boolean) => {
    const cookie = await getSmartoltSessionCookie(force);
    if (!cookie) return null;
    const res = await axios.get(`${baseUrl}${path}`, {
      headers: {
        Cookie: cookie,
        Accept: 'application/json',
        'X-Requested-With': 'XMLHttpRequest',
        'X-Token': SMARTOLT.apiKey
      },
      timeout: 15000
    });
    return unwrap(res.data);
  };

  try {
    // Cookie-first attempt
    const cookieResult = await tryWithCookie(false);
    if (cookieResult) return cookieResult;

    // API-key request (POST fallback)
    const data = await getWithPostFallback<any>(path);
    return unwrap(data);
  } catch (err: any) {
    const status = err?.response?.status;

    // If API key or cookie failed with forbidden, refresh session and retry once
    if (status === 403) {
      try {
        const refreshed = await tryWithCookie(true);
        if (refreshed) return refreshed;
      } catch (err2) {
        // ignore and continue to GET fallback
      }
    }

    // fallback: plain GET with token
    const data = await get<any>(path);
    return unwrap(data);
  }
}



export default {
  getOdbs,
  getAvailablePortsForOdb,
};