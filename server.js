require('dotenv').config();
const express = require('express');
const cors    = require('cors');
const path    = require('path');
const axios   = require('axios');
const fs      = require('fs');

// puppeteer-extra y tesseract.js se cargan lazy (son muy pesados — ~300MB+)
let puppeteerExtra = null;
let Tesseract = null;

function getPuppeteer() {
  if (!puppeteerExtra) {
    puppeteerExtra = require('puppeteer-extra');
    const StealthPlugin = require('puppeteer-extra-plugin-stealth');
    puppeteerExtra.use(StealthPlugin());
  }
  return puppeteerExtra;
}

// chrome-cookies-secure solo existe en Windows — ignorar en producción
let chromeCookies = null;
try { if (process.platform === 'win32') chromeCookies = require('chrome-cookies-secure'); } catch (_) {}

async function getCFCookies(url) {
  if (!chromeCookies) return null;
  return new Promise(resolve => {
    try {
      chromeCookies.getCookies(url, 'header', (err, cookies) => {
        if (err || !cookies) { resolve(null); return; }
        const hasCF = /cf_clearance/i.test(cookies);
        console.log('[SUNARP] Cookies de Chrome:', hasCF ? '✅ cf_clearance encontrado' : '⚠️ Sin cf_clearance');
        resolve(cookies || null);
      });
    } catch (e) { resolve(null); }
  });
}

const app  = express();
const PORT = process.env.PORT || 3000;
const IS_WINDOWS = process.platform === 'win32';

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname)));

// Carpeta pública para screenshots
const PUBLIC_DIR = path.join(__dirname, 'public');
if (!fs.existsSync(PUBLIC_DIR)) fs.mkdirSync(PUBLIC_DIR);

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// Buscar Chrome/Chromium — Windows o Linux (Docker)
function buscarChrome() {
  // Variable de entorno tiene prioridad (Railway/Docker la setea)
  if (process.env.PUPPETEER_EXECUTABLE_PATH) return process.env.PUPPETEER_EXECUTABLE_PATH;
  const rutas = [
    // Windows
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    (process.env.LOCALAPPDATA || '') + '\\Google\\Chrome\\Application\\chrome.exe',
    // Linux/Docker
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
  ];
  for (const r of rutas) {
    try { if (fs.existsSync(r)) return r; } catch (_) {}
  }
  return null;
}
const CHROME_PATH = buscarChrome();
console.log('[INFO] Chrome:', CHROME_PATH || '⚠️ no encontrado (puppeteer usará Chromium propio)');

async function launchBrowser(visible = false) {
  const opts = {
    headless: visible ? false : 'new',
    slowMo:   visible ? 150 : 0,
    args: [
      '--no-sandbox', '--disable-setuid-sandbox',
      '--disable-blink-features=AutomationControlled',
      '--disable-popup-blocking',
      '--window-size=1366,768', '--lang=es-PE,es',
    ],
    defaultViewport: visible ? null : { width: 1366, height: 768 },
    ignoreHTTPSErrors: true,
  };
  if (CHROME_PATH) opts.executablePath = CHROME_PATH;
  return getPuppeteer().launch(opts);
}

// ══════════════════════════════════════════════════════════════════════════════
// SUNARP — Busca el endpoint real en los JS bundles de Angular
// ══════════════════════════════════════════════════════════════════════════════
let sunarpApiUrl = null;       // cache del endpoint una vez encontrado
let sunarpActivePage = null;  // página activa de SUNARP (para mini-viewer en el navegador)
let sunarpTurnstileClip = null; // recorte del widget Turnstile {x,y,width,height}

// Token JWT persistente — se guarda en disco, se reutiliza entre reinicios del servidor
const TOKEN_FILE = path.join(__dirname, 'sunarp_token.json');

function cargarTokenGuardado() {
  try {
    const data = JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8'));
    const edad = Date.now() - data.timestamp;
    if (edad < 20 * 60 * 60 * 1000) { // válido hasta 20 horas
      console.log('[SUNARP] 🔑 Token JWT cargado desde disco (edad:', Math.round(edad/60000), 'min)');
      return data.token;
    }
    console.log('[SUNARP] Token en disco expirado, se necesitará nueva verificación');
  } catch (_) {}
  return null;
}

function guardarToken(token) {
  try {
    fs.writeFileSync(TOKEN_FILE, JSON.stringify({ token, timestamp: Date.now() }), 'utf8');
    console.log('[SUNARP] 🔑 Token JWT guardado en disco (válido ~20h)');
  } catch (_) {}
}

async function descubrirEndpointSUNARP() {
  if (sunarpApiUrl) return sunarpApiUrl;

  const base    = 'https://consultavehicular.sunarp.gob.pe';
  const headers = { 'User-Agent': UA, 'Accept-Language': 'es-PE,es;q=0.9' };

  // Intentar rutas comunes de bundles Angular (estáticos, pueden pasar Cloudflare)
  const bundleCandidatos = [
    '/consulta-vehicular/main.js',
    '/consulta-vehicular/main-es2015.js',
    '/consulta-vehicular/runtime.js',
  ];

  // Intentar primero obtener el HTML (puede fallar por CF, no pasa nada)
  const html = await axios.get(base + '/consulta-vehicular/inicio', { headers, timeout: 10000 })
    .then(r => r.data).catch(() => null);

  if (html) {
    const fromHtml = [...html.matchAll(/src="([^"]*(?:main|runtime)[^"]*\.js[^"]*)"/gi)].map(m => m[1]);
    bundleCandidatos.push(...fromHtml);
  }

  for (const p of bundleCandidatos) {
    const url = p.startsWith('http') ? p : base + p;
    try {
      console.log('[SUNARP] Buscando API en bundle:', url);
      const js = await axios.get(url, { headers, timeout: 12000 }).then(r => r.data).catch(() => null);
      if (!js || typeof js !== 'string' || js.length < 100) continue;

      const patrones = [
        /["'`](https?:\/\/[^"'`\s]{10,80}(?:vehiculo|consulta|placa)[^"'`\s]*)["'`]/gi,
        /["'`](\/[a-z0-9\-_]{2,}\/[a-z0-9\-_/]{2,}(?:vehiculo|consulta|placa)[a-z0-9\-_/]*)["'`]/gi,
        /apiUrl[:\s=]+["'`]([^"'`]+)["'`]/gi,
      ];

      for (const patron of patrones) {
        for (const m of [...js.matchAll(patron)]) {
          const match = m[1];
          if (match.length > 5 && match.length < 120) {
            console.log('[SUNARP] Endpoint encontrado en bundle:', match);
            sunarpApiUrl = match.startsWith('http') ? match : base + match;
            return sunarpApiUrl;
          }
        }
      }
    } catch (_) {}
  }

  return null;
}

// Endpoint real de SUNARP descubierto por intercepción de red
const SUNARP_API_REAL = 'https://api-gateway.sunarp.gob.pe:9443/sunarp/multiservicios/multiservicio-consvehicular/consulta/getDatosVehiculo';
let sunarpAuthToken = cargarTokenGuardado(); // carga token guardado del disco al iniciar

async function consultarSUNARP(placa) {
  console.log('[SUNARP] Iniciando consulta para:', placa);

  // Obtener cookies de Chrome (incluye cf_clearance si el usuario ya visitó SUNARP)
  const cfCookies = await getCFCookies('https://consultavehicular.sunarp.gob.pe');

  const apiHeaders = {
    'User-Agent': UA,
    'Accept': 'application/json, text/plain, */*',
    'Accept-Language': 'es-PE,es;q=0.9',
    'Origin': 'https://consultavehicular.sunarp.gob.pe',
    'Referer': 'https://consultavehicular.sunarp.gob.pe/consulta-vehicular/inicio',
    ...(cfCookies ? { 'Cookie': cfCookies } : {}),
  };

  if (cfCookies) {
    console.log('[SUNARP] Usando cookies de Chrome para bypass de Cloudflare');
  } else {
    console.log('[SUNARP] Sin cookies de Chrome — Cloudflare puede bloquear');
  }

  // 1. Intentar el endpoint real getDatosVehiculo directamente (descubierto por intercepción)
  const bodyVariants = [
    { numPlaca: placa },
    { nroPlaca: placa },
    { placa: placa },
    { numPlaca: placa, tipoDocumento: '1' },
  ];
  const headersConToken = sunarpAuthToken
    ? { ...apiHeaders, 'Authorization': sunarpAuthToken }
    : apiHeaders;

  for (const body of bodyVariants) {
    try {
      console.log('[SUNARP] Probando API real (POST):', SUNARP_API_REAL, JSON.stringify(body));
      const res = await axios.post(SUNARP_API_REAL, body, {
        headers: { ...headersConToken, 'Content-Type': 'application/json' },
        timeout: 12000,
      });
      if (res.data && typeof res.data === 'object') {
        const str = JSON.stringify(res.data);
        if (/placa|marca|modelo|propietario|motor|serie/i.test(str)) {
          console.log('[SUNARP] ✅ API real funcionó directamente!');
          return { ok: true, fuente: 'SUNARP', placa, datos: parsearJSONSunarp(str) };
        }
      }
    } catch (e) {
      console.log('[SUNARP] API real →', e.response?.status || e.code || e.message.substring(0, 60));
    }
  }

  // 2. Candidatos alternativos GET
  const candidatos = [
    `https://consultavehicular.sunarp.gob.pe/ConsultaVehicularWS/api/vehiculo/${placa}`,
    `https://consultavehicular.sunarp.gob.pe/ConsultaVehicularWS/api/consulta/vehiculo/${placa}`,
    `https://consultavehicular.sunarp.gob.pe/ConsultaVehicularWS/Api/Vehicle/${placa}`,
    `https://consultavehicular.sunarp.gob.pe/ConsultaVehicularWS/Api/Vehicle/GetByPlaca?numPlaca=${placa}`,
  ];

  for (const url of candidatos) {
    try {
      console.log('[SUNARP] Probando API:', url);
      const res = await axios.get(url, { headers: apiHeaders, timeout: 10000 });
      if (res.data && typeof res.data === 'object') {
        const str = JSON.stringify(res.data);
        if (str.length > 20 && /placa|vehiculo|marca|propietario|color|motor/i.test(str)) {
          console.log('[SUNARP] ✅ API directa funcionó:', url);
          return { ok: true, fuente: 'SUNARP', placa, datos: parsearJSONSunarp(str) };
        }
      }
    } catch (e) {
      console.log('[SUNARP]', url.split('/').slice(-2).join('/'), '→', e.code || e.message.substring(0, 50));
    }
  }

  // 3. Intentar endpoint descubierto en bundles
  const endpoint = await descubrirEndpointSUNARP();
  if (endpoint && !candidatos.some(c => c.includes(endpoint))) {
    try {
      const url = endpoint.endsWith('/') ? endpoint + placa : endpoint + '/' + placa;
      console.log('[SUNARP] Probando endpoint descubierto:', url);
      const res = await axios.get(url, { headers: apiHeaders, timeout: 10000 });
      if (res.data && typeof res.data === 'object' && Object.keys(res.data).length > 0) {
        console.log('[SUNARP] ✅ Endpoint descubierto funcionó');
        return { ok: true, fuente: 'SUNARP', placa, datos: parsearJSONSunarp(JSON.stringify(res.data)) };
      }
    } catch (_) {}
  }

  // 4. Puppeteer — abre Chrome visible con mini-viewer en la web para el Turnstile
  console.log('[SUNARP] Intentando Puppeteer con mini-viewer interactivo...');
  return await consultarSUNARPPuppeteer(placa);
}

async function launchBrowserSUNARP() {
  const os = require('os');

  // En Windows: copiar perfil real de Chrome para heredar cf_clearance
  let tempDir = null;
  if (IS_WINDOWS && CHROME_PATH) {
    tempDir = path.join(os.tmpdir(), 'sunarp_profile_' + Date.now());
    const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
    const chromeBase = path.join(localAppData, 'Google', 'Chrome', 'User Data');

    const archivosACopiar = [
      { src: path.join(chromeBase, 'Local State'),                        dst: path.join(tempDir, 'Local State') },
      { src: path.join(chromeBase, 'Default', 'Preferences'),             dst: path.join(tempDir, 'Default', 'Preferences') },
      { src: path.join(chromeBase, 'Default', 'Network', 'Cookies'),      dst: path.join(tempDir, 'Default', 'Network', 'Cookies') },
      { src: path.join(chromeBase, 'Default', 'Network', 'Trust Tokens'), dst: path.join(tempDir, 'Default', 'Network', 'Trust Tokens') },
    ];
    for (const { src, dst } of archivosACopiar) {
      try {
        fs.mkdirSync(path.dirname(dst), { recursive: true });
        if (fs.existsSync(src)) { fs.copyFileSync(src, dst); console.log('[SUNARP] Copiado:', path.basename(src)); }
      } catch (e) { console.log('[SUNARP] No se pudo copiar', path.basename(src)); }
    }
  }

  const args = [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',  // crítico en Docker (memoria compartida limitada)
    '--disable-gpu',
    '--window-size=1280,800',
    '--lang=es-PE,es',
    '--disable-popup-blocking',
  ];
  if (tempDir) args.push(`--user-data-dir=${tempDir}`);

  const opts = {
    headless:  IS_WINDOWS ? false : 'new',  // visible en Windows, headless en nube
    slowMo:    IS_WINDOWS ? 60 : 0,
    executablePath: CHROME_PATH || undefined,
    ignoreDefaultArgs: ['--enable-automation', '--enable-blink-features=IdleDetection'],
    args,
    defaultViewport: { width: 1280, height: 800 },
  };
  return getPuppeteer().launch(opts);
}

// ── Resolver Cloudflare Turnstile automáticamente con 2captcha ───────────────
async function resolverTurnstileAuto(page, pageUrl) {
  const apiKey = process.env.TWOCAPTCHA_KEY;
  if (!apiKey || apiKey === 'PON_TU_API_KEY_AQUI') {
    console.log('[2CAPTCHA] Sin API key — usa el mini-viewer manual');
    return '';
  }

  // Extraer site key de la página
  const siteKey = await page.evaluate(() => {
    const el = document.querySelector('[data-sitekey]');
    if (el) return el.getAttribute('data-sitekey');
    for (const s of document.querySelectorAll('script')) {
      const m = s.textContent.match(/sitekey['":\s=]+['"]([0-9a-zA-Z_-]{20,60})['"]/i);
      if (m) return m[1];
    }
    // Buscar en src de iframes Turnstile
    const iframe = document.querySelector('iframe[src*="turnstile"]');
    if (iframe) {
      const m = iframe.src.match(/sitekey=([^&]+)/);
      if (m) return m[1];
    }
    return null;
  }).catch(() => null);

  if (!siteKey) {
    console.log('[2CAPTCHA] No se encontró el site key del Turnstile en la página');
    return '';
  }

  console.log('[2CAPTCHA] Site key:', siteKey);
  console.log('[2CAPTCHA] Enviando a 2captcha para resolver automáticamente...');

  try {
    // 1. Enviar tarea a 2captcha
    const submit = await axios.post('https://2captcha.com/in.php', null, {
      params: {
        key:     apiKey,
        method:  'turnstile',
        sitekey: siteKey,
        pageurl: pageUrl,
        json:    1,
      },
      timeout: 15000,
    });
    if (!submit.data || submit.data.status !== 1)
      throw new Error('2captcha submit: ' + JSON.stringify(submit.data));

    const taskId = submit.data.request;
    console.log('[2CAPTCHA] Tarea enviada, ID:', taskId, '— esperando solución...');

    // 2. Polling hasta recibir el token (hasta 120 seg)
    for (let i = 0; i < 24; i++) {
      await new Promise(r => setTimeout(r, 5000));
      const result = await axios.get('https://2captcha.com/res.php', {
        params: { key: apiKey, action: 'get', id: taskId, json: 1 },
        timeout: 10000,
      });
      if (result.data.status === 1) {
        const token = result.data.request;
        console.log('[2CAPTCHA] ✅ Turnstile resuelto automáticamente!');
        // Inyectar el token en la página
        await page.evaluate((t) => {
          const inp = document.querySelector('[name="cf-turnstile-response"]');
          if (inp) {
            Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')
              .set.call(inp, t);
            inp.dispatchEvent(new Event('input',  { bubbles: true }));
            inp.dispatchEvent(new Event('change', { bubbles: true }));
          }
          // También intentar callback de Turnstile si existe
          if (window.turnstile && window.turnstile.getResponse) {
            try { window.turnstile._callbacks?.forEach?.(cb => cb(t)); } catch (_) {}
          }
        }, token).catch(() => {});
        return token;
      }
      if (result.data.request !== 'CAPCHA_NOT_READY') {
        throw new Error('2captcha result: ' + result.data.request);
      }
      console.log(`[2CAPTCHA] Resolviendo... (${(i + 1) * 5}s)`);
    }
    console.log('[2CAPTCHA] Tiempo agotado (120s)');
  } catch (e) {
    console.log('[2CAPTCHA] Error:', e.message);
  }
  return '';
}

// ── OCR del PNG base64 que devuelve la API de SUNARP (model.imagen) ───────────
async function ocrizarDocumentoSUNARP(base64png, placa) {
  const imgBuffer = Buffer.from(base64png, 'base64');
  const docPath   = path.join(PUBLIC_DIR, 'sunarp_documento.png');
  fs.writeFileSync(docPath, imgBuffer);
  console.log('[OCR] Documento guardado:', docPath);

  const imagenUrl = '/public/sunarp_documento.png';

  // ── Intento 1: tesseract del sistema (Linux/Docker) ──────────────────────
  try {
    const { execFile } = require('child_process');
    const os = require('os');
    const tmpImg = path.join(os.tmpdir(), `sunarp_ocr_${Date.now()}.png`);
    const tmpOut = path.join(os.tmpdir(), `sunarp_ocr_${Date.now()}_out`);
    fs.writeFileSync(tmpImg, imgBuffer);

    await new Promise((resolve, reject) => {
      execFile('tesseract', [tmpImg, tmpOut, '-l', 'spa+eng', '--oem', '3', '--psm', '6'],
        { timeout: 60000 }, (err) => {
          if (err) { reject(err); return; }
          resolve();
        });
    });

    const texto = fs.readFileSync(tmpOut + '.txt', 'utf8');
    try { fs.unlinkSync(tmpImg); fs.unlinkSync(tmpOut + '.txt'); } catch (_) {}
    console.log('[OCR] Sistema tesseract OK. Texto (primeros 600 chars):\n' + texto.substring(0, 600));
    const campos = extraerCamposSUNARP(texto, placa);
    console.log('[OCR] Campos:', Object.keys(campos).join(', ') || 'ninguno');
    return { campos, imagenUrl, textoOCR: texto };

  } catch (e) {
    console.log('[OCR] tesseract sistema no disponible:', e.message.substring(0, 60));
  }

  // ── Intento 2: tesseract.js (lazy load — solo si sistema no está disponible) ─
  try {
    if (!Tesseract) Tesseract = require('tesseract.js');
    console.log('[OCR] Usando tesseract.js (puede tomar 15-40s)...');
    const { data } = await Tesseract.recognize(imgBuffer, 'spa', {
      logger: m => {
        if (m.status === 'recognizing text')
          process.stdout.write(`\r[OCR] ${Math.round(m.progress * 100)}%   `);
      },
    });
    process.stdout.write('\n');
    const texto = data.text || '';
    console.log('[OCR] tesseract.js OK. Texto (primeros 600 chars):\n' + texto.substring(0, 600));
    const campos = extraerCamposSUNARP(texto, placa);
    console.log('[OCR] Campos:', Object.keys(campos).join(', ') || 'ninguno');
    return { campos, imagenUrl, textoOCR: texto };
  } catch (e) {
    console.log('[OCR] tesseract.js error:', e.message);
  }

  // ── Sin OCR: devolver imagen para ver manualmente ─────────────────────────
  console.log('[OCR] Sin OCR disponible — devolviendo imagen del documento');
  return { campos: { 'N° Placa': placa }, imagenUrl, textoOCR: '' };
}

async function consultarSUNARPPuppeteer(placa) {
  let browser;
  try {
    browser = await launchBrowserSUNARP();
    const page = await browser.newPage();
    await page.setUserAgent(UA);
    await page.setExtraHTTPHeaders({
      'Accept-Language': 'es-PE,es;q=0.9',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    });

    let apiData = null;

    // ── Cerrar automáticamente cualquier popup/pestaña nueva que abra SUNARP ──
    browser.on('targetcreated', async target => {
      try {
        if (target.type() === 'page') {
          const newPage = await target.page().catch(() => null);
          if (newPage && newPage !== page) {
            const newUrl = newPage.url();
            console.log('[SUNARP] 🚫 Cerrando ventana emergente:', newUrl || '(nueva pestaña)');
            await newPage.close().catch(() => {});
          }
        }
      } catch (_) {}
    });

    // Interceptar respuestas — captura la API getDatosVehiculo y su token de auth
    page.on('response', async response => {
      try {
        if (apiData) return;
        const ct  = (response.headers()['content-type'] || '').toLowerCase();
        const url = response.url();
        if (response.status() !== 200) return;
        if (/google|gstatic|turnstile|analytics|cloudflare/i.test(url)) return;
        if (!ct.includes('json')) return;
        const body = await response.text().catch(() => '');
        if (body.length < 10) return;
        if (/placa|vehiculo|marca|propietario|motor|serie|color/i.test(body)) {
          console.log('[SUNARP] ✅ API interceptada:', url);
          apiData = body;
        }
      } catch (_) {}
    });

    // Interceptar peticiones — capturar el token Authorization para reutilizarlo
    page.on('request', req => {
      try {
        if (req.url().includes('getDatosVehiculo') || req.url().includes('api-gateway')) {
          const auth = req.headers()['authorization'];
          if (auth && auth.startsWith('Bearer ')) {
            sunarpAuthToken = auth;
            guardarToken(auth);
            console.log('[SUNARP] 🔑 Token JWT capturado y guardado (futuros queries sin Turnstile)');
          }
        }
      } catch (_) {}
    });

    const SUNARP_URL = 'https://consultavehicular.sunarp.gob.pe/consulta-vehicular/inicio';

    // ── Intentar navegación hasta 2 veces (Cloudflare a veces necesita reintento) ─
    let paginaUrl = 'about:blank';
    for (let intento = 1; intento <= 2; intento++) {
      console.log(`[SUNARP] Cargando página (intento ${intento}/2)...`);
      try {
        await page.goto(SUNARP_URL, { waitUntil: 'domcontentloaded', timeout: 50000 });
      } catch (navErr) {
        console.log('[SUNARP] Navegación:', navErr.message.substring(0, 80));
      }
      paginaUrl = page.url();
      console.log('[SUNARP] URL:', paginaUrl);
      if (paginaUrl !== 'about:blank' && !paginaUrl.startsWith('chrome-error://')) break;
      if (intento < 2) {
        console.log('[SUNARP] Reintentando en 5 segundos...');
        await new Promise(r => setTimeout(r, 5000));
      }
    }

    await page.screenshot({ path: path.join(PUBLIC_DIR, 'sunarp_1_carga.png') }).catch(() => {});

    // ── Fallo de conexión tras dos intentos → sesión de Cloudflare expirada ──
    if (paginaUrl === 'about:blank' || paginaUrl.startsWith('chrome-error://')) {
      return {
        ok: false, fuente: 'SUNARP', placa,
        cfSesionExpirada: true,
        error: 'La sesión de Cloudflare expiró. Usa el botón "Renovar sesión SUNARP" en la web y luego reintenta.',
      };
    }

    // Esperar que Angular + Cloudflare Turnstile terminen de cargar
    console.log('[SUNARP] Esperando que cargue el Turnstile...');
    await new Promise(r => setTimeout(r, 8000));

    // ── Detectar posición exacta del widget Turnstile para mini-viewer recortado ─
    sunarpTurnstileClip = await page.evaluate(() => {
      const sels = ['.cf-turnstile', '[data-sitekey]', 'iframe[src*="challenges.cloudflare"]'];
      for (const sel of sels) {
        const el = document.querySelector(sel);
        if (el) {
          const r = el.getBoundingClientRect();
          if (r.width > 10 && r.height > 10) {
            const pad = 25;
            return { x: Math.max(0, r.x - pad), y: Math.max(0, r.y - pad),
                     width: Math.min(r.width + pad * 2, 1260),
                     height: Math.min(r.height + pad * 2, 780) };
          }
        }
      }
      return null;
    }).catch(() => null);
    if (sunarpTurnstileClip) console.log('[SUNARP] Turnstile localizado:', JSON.stringify(sunarpTurnstileClip));
    else console.log('[SUNARP] Turnstile no localizado aún (se mostrará página completa)');

    // ── Intentar resolver Turnstile automáticamente con 2captcha ─────────────
    let cfToken = await resolverTurnstileAuto(page,
      'https://consultavehicular.sunarp.gob.pe/consulta-vehicular/inicio'
    );

    // ── Si 2captcha no está configurado → mini-viewer manual ─────────────────
    if (!cfToken) {
      sunarpActivePage = page;
      console.log('[SUNARP] ⏳ Esperando verificación manual (hasta 90 seg)...');
      console.log('[SUNARP]    → Haz clic en el cuadro de verificación dentro de la web (mini-viewer)');

      for (let i = 0; i < 45 && !cfToken; i++) {
        await new Promise(r => setTimeout(r, 2000));
        cfToken = await page.evaluate(() => {
          const inp = document.querySelector('[name="cf-turnstile-response"]');
          return (inp && inp.value) ? inp.value : '';
        }).catch(() => '');
        if (cfToken) console.log('[SUNARP] ✅ Turnstile resuelto! Token recibido.');
        else if (i % 5 === 0) {
          console.log(`[SUNARP]    Esperando verificación... (${i * 2}s)`);
          await page.bringToFront().catch(() => {});
        }
      }
    }

    if (!cfToken) {
      return {
        ok: false, fuente: 'SUNARP', placa,
        error: 'Verificación de Cloudflare no completada. Configura TWOCAPTCHA_KEY en el .env para resolverlo automáticamente.',
      };
    }

    await page.screenshot({ path: path.join(PUBLIC_DIR, 'sunarp_2_turnstile.png') }).catch(() => {});

    // Buscar campo de placa (Angular usa formcontrolname)
    const inputSel = await page.evaluate(() => {
      for (const inp of document.querySelectorAll('input')) {
        const attrs = ((inp.placeholder||'')+(inp.name||'')+(inp.id||'')+(inp.getAttribute('formcontrolname')||'')).toLowerCase();
        if ((attrs.includes('placa') || attrs.includes('numero')) && !inp.readOnly && !inp.disabled) {
          inp.id = inp.id || '_sunarp_placa_'; return '#' + inp.id;
        }
      }
      // Fallback: primer input de texto visible
      for (const inp of document.querySelectorAll('input[type="text"], input:not([type])')) {
        if (!inp.readOnly && !inp.disabled && inp.offsetParent) {
          inp.id = inp.id || '_sunarp_placa_'; return '#' + inp.id;
        }
      }
      return null;
    });
    console.log('[SUNARP] Campo de placa:', inputSel);

    if (!inputSel) {
      await page.screenshot({ path: path.join(PUBLIC_DIR, 'sunarp_error_form.png'), fullPage: true }).catch(() => {});
      const textoErr = await page.evaluate(() => document.body.innerText.substring(0, 500));
      return {
        ok: false, fuente: 'SUNARP', placa,
        error: 'Formulario no encontrado. El Turnstile no se resolvió. Texto: ' + textoErr.substring(0, 100),
      };
    }

    // Escribir la placa
    await page.click(inputSel, { clickCount: 3 });
    await page.type(inputSel, placa, { delay: 150 });
    console.log('[SUNARP] Placa escrita:', placa);

    // Esperar a que el botón "Realizar Búsqueda" esté activo (requiere Turnstile OK)
    await new Promise(r => setTimeout(r, 3000));
    await page.screenshot({ path: path.join(PUBLIC_DIR, 'sunarp_3_antes_click.png') }).catch(() => {});

    // Click en "Realizar Búsqueda"
    const clickOk = await page.evaluate(() => {
      for (const b of document.querySelectorAll('button, input[type="submit"]')) {
        const txt = (b.textContent + b.value).toLowerCase();
        if ((txt.includes('realizar') || txt.includes('búsqueda') || txt.includes('buscar')) && !b.disabled) {
          b.click(); return true;
        }
      }
      return false;
    });
    console.log('[SUNARP] Click en buscar:', clickOk);

    // ── Esperar que Angular navegue al resultado (cambia la URL del router) ────
    console.log('[SUNARP] Esperando navegación Angular al resultado...');
    await page.waitForFunction(
      () => window.location.href.includes('resultado') ||
            window.location.href.includes('consulta') ||
            window.location.hash.includes('resultado'),
      { timeout: 20000 }
    ).catch(() => {
      console.log('[SUNARP] URL no cambió (SPA sin cambio de ruta) — esperando render...');
    });

    console.log('[SUNARP] URL tras búsqueda:', page.url());

    // ── Esperar que el contenido del resultado esté completamente renderizado ──
    console.log('[SUNARP] Esperando datos del vehículo en el DOM...');
    await page.waitForFunction(
      () => {
        const txt = document.body.innerText;
        // Buscar al menos 3 campos clave del documento SUNARP
        const indicadores = [
          /n[°º]\s*(placa|serie|vin|motor)/i,
          /propietario/i,
          /placa\s+vigente/i,
          /\bcolor\s*[:\-]/i,
          /\bmarca\s*[:\-]/i,
          /\bmodelo\s*[:\-]/i,
          /\bestado\s*[:\-]/i,
          /\bsede\s*[:\-]/i,
          /a[ñn]o\s*(?:de\s*modelo)?\s*[:\-]/i,
        ];
        return indicadores.filter(re => re.test(txt)).length >= 3;
      },
      { timeout: 45000 }
    ).catch(() => {
      console.log('[SUNARP] ⚠️ waitForFunction agotó 45s — leyendo lo que hay en la página');
    });

    // Espera adicional para que Angular termine de renderizar todo
    await new Promise(r => setTimeout(r, 2500));

    await page.screenshot({ path: path.join(PUBLIC_DIR, 'sunarp_4_resultado.png'), fullPage: true }).catch(() => {});

    // ── Prioridad 1: usar la respuesta JSON interceptada de la API ────────────
    // SUNARP devuelve model.imagen = PNG base64 del documento → hay que hacer OCR
    if (apiData) {
      try {
        const jsonApi = JSON.parse(apiData);
        const imgBase64 = jsonApi?.model?.imagen;

        if (imgBase64 && typeof imgBase64 === 'string' && imgBase64.length > 500) {
          // La API devolvió la imagen del documento — aplicar OCR
          console.log('[SUNARP] 🖼 Documento en base64 detectado (longitud:', imgBase64.length, ') — aplicando OCR...');
          const ocrResult = await ocrizarDocumentoSUNARP(imgBase64, placa);

          if (Object.keys(ocrResult.campos).length >= 3) {
            console.log('[SUNARP] ✅ OCR exitoso:', Object.keys(ocrResult.campos).join(', '));
            return {
              ok: true, fuente: 'SUNARP', placa,
              datos: { campos: ocrResult.campos, bloques: [], textoPlano: ocrResult.textoOCR.substring(0, 3000) },
              imagenDocumentoUrl: ocrResult.imagenUrl + '?t=' + Date.now(),
            };
          }

          // OCR insuficiente → devolver imagen para verla manualmente
          console.log('[SUNARP] OCR con pocos campos, devolviendo imagen del documento');
          return {
            ok: true, fuente: 'SUNARP', placa,
            esImagen: true,
            imagenUrl: ocrResult.imagenUrl + '?t=' + Date.now(),
            datos: { campos: ocrResult.campos, bloques: [], textoPlano: ocrResult.textoOCR.substring(0, 3000) },
          };
        }
      } catch (e) {
        console.log('[SUNARP] Error procesando imagen de API:', e.message);
      }

      // Sin imagen → parsear JSON directamente
      const datosApi = parsearJSONSunarp(apiData);
      console.log('[SUNARP] Campos de API (sin imagen):', Object.keys(datosApi.campos).join(', ') || 'ninguno');
      if (Object.keys(datosApi.campos).length >= 2) {
        return { ok: true, fuente: 'SUNARP', placa, datos: datosApi };
      }
    } else {
      console.log('[SUNARP] ⚠️ apiData es null — API no interceptada todavía');
    }

    // ── Prioridad 2: extraer datos del DOM renderizado ────────────────────────
    const texto = await page.evaluate(() => document.body.innerText).catch(() => '');
    console.log('[SUNARP] Texto DOM (primeros 1000 chars):\n' + texto.substring(0, 1000));
    const campos = extraerCamposSUNARP(texto, placa);

    if (Object.keys(campos).length >= 3) {
      console.log('[SUNARP] ✅ Datos extraídos del DOM:', Object.keys(campos).join(', '));
      return { ok: true, fuente: 'SUNARP', placa, datos: { campos, bloques: [], textoPlano: texto.substring(0, 3000) } };
    }

    // ── Prioridad 3: screenshot del documento ─────────────────────────────────
    const imgPath = path.join(PUBLIC_DIR, 'sunarp_result.png');
    await page.screenshot({ path: imgPath, fullPage: true });
    console.log('[SUNARP] Pocos campos extraídos, guardando imagen. Campos encontrados:', Object.keys(campos).join(', ') || 'ninguno');

    // Si la API tenía algo aunque sea poco, devolverlo con la imagen
    const datosFinales = apiData ? parsearJSONSunarp(apiData) : { campos, bloques: [], textoPlano: '' };
    return {
      ok: true, fuente: 'SUNARP', placa,
      esImagen: true,
      imagenUrl: '/public/sunarp_result.png?t=' + Date.now(),
      datos: datosFinales,
    };

  } catch (err) {
    console.error('[SUNARP] Error:', err.message);
    return { ok: false, fuente: 'SUNARP', error: err.message };
  } finally {
    sunarpActivePage = null;
    sunarpTurnstileClip = null;
    if (browser) await browser.close();
  }
}

// Convierte a Título Case solo si el valor es texto (no código alfanumérico)
function toTitulo(s) {
  if (!s) return s;
  const v = String(s).trim();
  // Mantener como está si parece código: mezcla de letras y números (AZK081, G4NAHU415401)
  if (/^[A-Z0-9\-]+$/.test(v) && /\d/.test(v) && /[A-Z]/.test(v)) return v;
  // Para fechas y números puros también sin cambio
  if (/^\d/.test(v)) return v;
  return v.toLowerCase()
    .replace(/(?:^|\s)\S/g, c => c.toUpperCase())   // Título Case
    .replace(/\bDe\b/g, 'de').replace(/\bDel\b/g, 'del')
    .replace(/\bEn\b/g, 'en').replace(/\bY\b/g, 'y')
    .replace(/\bA\b/g, 'a').replace(/\bLa\b/g, 'la')
    .replace(/N° /g, 'N° '); // preservar N°
}

// Extrae campos del texto plano del documento resultado de SUNARP (Paso 3)
function extraerCamposSUNARP(texto, placaConsultada) {
  const t = texto.replace(/\r/g, '\n');
  const get = (regex) => { const m = t.match(regex); return m ? m[1].trim() : null; };

  const campos = {};
  const set = (k, v) => {
    if (!v || v.length > 200 || v === '-' || v === '—') return;
    campos[k] = toTitulo(v);
  };

  // Campos principales (insensible a mayúsculas, acepta Nº Nó N° etc.)
  set('N° Placa',        get(/N[°ºoó\.]\s*PLACA\s*[:\-]?\s*([A-Z0-9\-]{3,12})/i));
  set('N° Serie',        get(/N[°ºoó\.]\s*SERIE\s*[:\-]?\s*([A-Z0-9]{6,25})/i));
  set('N° VIN',          get(/N[°ºoó\.]\s*VIN\s*[:\-]?\s*([A-Z0-9]{6,25})/i)
                      || get(/VIN\s*[:\-]\s*([A-Z0-9]{6,25})/i));
  set('N° Motor',        get(/N[°ºoó\.]\s*MOTOR\s*[:\-]?\s*([A-Z0-9]{4,25})/i));
  set('Color',           get(/\bCOLOR\s*[:\-]\s*([A-ZÁÉÍÓÚÑa-záéíóúñ\s]{2,30}?)(?:\n|$)/i));
  set('Marca',           get(/\bMARCA\s*[:\-]\s*([A-ZÁÉÍÓÚÑa-záéíóúñ\s\-]{2,30}?)(?:\n|$)/i));
  set('Modelo',          get(/\bMODELO\s*[:\-]\s*([^\n]{2,60})/i));
  set('Placa Vigente',   get(/PLACA\s+VIGENTE\s*[:\-]\s*([A-Z0-9\-]{3,12})/i));
  set('Placa Anterior',  get(/PLACA\s+ANTERIOR\s*[:\-]\s*([^\n]{1,30})/i));
  set('Estado',          get(/\bESTADO\s*[:\-]\s*([A-ZÁÉÍÓÚÑa-záéíóúñ\s]{3,40}?)(?:\n|$)/i));
  set('Anotaciones',     get(/ANOTACIONES\s*[:\-]\s*([^\n]{1,80})/i));
  set('Sede',            get(/\bSEDE\s*[:\-]\s*([A-ZÁÉÍÓÚÑa-záéíóúñ\s]{2,40}?)(?:\n|$)/i));
  set('Año de Modelo',   get(/A[ÑN][OI](?:\s+DE\s+MODELO)?\s*[:\-]\s*(\d{4})/i));
  set('Categoría',       get(/CATEGOR[IÍ]A\s*[:\-]\s*([^\n]{1,50})/i));
  set('Uso',             get(/\bUSO\s*[:\-]\s*([^\n]{1,40})/i));
  set('Combustible',     get(/COMBUSTIBLE\s*[:\-]\s*([^\n]{1,40})/i));
  set('N° Ejes',         get(/(?:N[°ºoó\.]\s*)?EJES\s*[:\-]\s*(\d+)/i));
  set('Asientos',        get(/(?:N[°ºoó\.]\s*)?ASIENTOS\s*[:\-]\s*(\d+)/i));

  // Propietario: líneas hasta doble salto o sección siguiente
  const mProp = t.match(/PROPIETARIO[S)(\s]*[:\-]\s*([\s\S]{3,300}?)(?:\n{2,}|INFORMACIÓN|FECHA|REALIZAR|$)/i);
  if (mProp) {
    const nombres = mProp[1].trim().split('\n')
      .map(l => l.trim()).filter(l => l.length > 2 && l.length < 120 && !/^\d+$/.test(l));
    if (nombres.length) campos['Propietario(s)'] = nombres.map(toTitulo).join(' / ');
  }

  // Fecha de consulta
  const mFecha = t.match(/(\d{2}[\/\-]\d{2}[\/\-]\d{4}[\s,]+\d{2}:\d{2}(?::\d{2})?)/);
  if (mFecha) campos['Fecha Consulta'] = mFecha[1].trim();

  // Fallback placa
  if (!campos['N° Placa'] && placaConsultada) campos['N° Placa'] = placaConsultada;

  console.log('[SUNARP] extraerCamposSUNARP →', Object.keys(campos).join(', ') || 'ninguno');
  return campos;
}

function esBase64Largo(v) {
  // Filtrar valores que son PDFs/imágenes en base64 (largo > 300 y solo caracteres base64)
  return typeof v === 'string' && v.length > 300 && /^[A-Za-z0-9+/=\r\n]+$/.test(v.replace(/\s/g, ''));
}

function parsearJSONSunarp(raw) {
  const result = { campos: {}, bloques: [], textoPlano: '' };
  try {
    const json = JSON.parse(raw);

    // Log estructura raíz para debug
    console.log('[SUNARP] Claves raíz de la API:', Object.keys(json).join(', '));

    // La API real retorna: { cod, mensaje, model: { nroPlaca, nroSerie, ... sedes:[], propietarios:[] } }
    // Buscar el objeto con los datos del vehículo
    const data = json.model || json.data || json.resultado || json.vehiculo
               || json.datosVehiculo || json.response || json;

    if (!data || typeof data !== 'object') return result;
    console.log('[SUNARP] Claves del objeto de datos:', Object.keys(data).slice(0, 20).join(', '));

    // Mapeo directo: clave de la API → etiqueta visible
    const MAPA = {
      nroPlaca:       'N° Placa',   numPlaca: 'N° Placa',   placa: 'N° Placa',
      nroSerie:       'N° Serie',   numSerie: 'N° Serie',   serie: 'N° Serie',
      nroVin:         'N° VIN',     vin:      'N° VIN',
      nroMotor:       'N° Motor',   numMotor: 'N° Motor',   motor: 'N° Motor',
      color:          'Color',      colorVehiculo: 'Color',
      marca:          'Marca',      marcaVehiculo: 'Marca',
      modelo:         'Modelo',     modeloVehiculo: 'Modelo',
      placaVigente:   'Placa Vigente',
      placaAnterior:  'Placa Anterior',
      estado:         'Estado',     estadoVehiculo: 'Estado',  situacion: 'Estado',
      anotaciones:    'Anotaciones',
      anioModelo:     'Año de Modelo', anio: 'Año de Modelo', ano: 'Año de Modelo',
      categoria:      'Categoría',  categoriaVehiculo: 'Categoría',
      uso:            'Uso',        usoVehiculo: 'Uso',
      combustible:    'Combustible',
      numAsientos:    'Asientos',   asientos: 'Asientos',
      pesoBruto:      'Peso Bruto', peso: 'Peso Bruto',
      cilindrada:     'Cilindrada',
      potencia:       'Potencia',
    };

    // 1. Extraer campos directos (no recursivo — evita mezclar con sedes/otros objetos)
    for (const [k, label] of Object.entries(MAPA)) {
      const v = data[k];
      if (v === undefined || v === null || v === '' || typeof v === 'object') continue;
      const sv = String(v).trim();
      if (!sv || esBase64Largo(sv) || sv.length > 300) continue;
      result.campos[label] = toTitulo(sv);
    }

    // 2. Sede — viene en data.sedes (array) o data.nombreSede / data.sede
    const sedeArr = data.sedes || data.oficinas;
    if (Array.isArray(sedeArr) && sedeArr.length > 0) {
      const s = sedeArr[0];
      const nombreSede = s.nombre || s.nombreSede || s.descSede || s.descripcion;
      if (nombreSede) result.campos['Sede'] = toTitulo(String(nombreSede));
    } else {
      const nombreSede = data.nombreSede || data.sede || data.oficina;
      if (nombreSede && typeof nombreSede === 'string')
        result.campos['Sede'] = toTitulo(nombreSede);
    }

    // 3. Propietarios — viene en data.propietarios / data.titulares (array)
    const propArr = data.propietarios || data.titulares || data.owners;
    if (Array.isArray(propArr) && propArr.length > 0) {
      const nombres = propArr.map(p => {
        if (typeof p === 'string') return toTitulo(p.trim());
        if (typeof p !== 'object') return null;
        const n = p.nombre || p.nombrePropietario || p.name
               || [p.apellidoPaterno, p.apellidoMaterno, p.nombres].filter(Boolean).join(' ');
        return n ? toTitulo(n.trim()) : null;
      }).filter(Boolean);
      if (nombres.length) result.campos['Propietario(s)'] = nombres.join(' / ');
    }

    // 4. Ordenar igual que el documento SUNARP (Paso 3)
    const ORDEN = ['N° Placa','N° Serie','N° VIN','N° Motor','Color','Marca','Modelo',
                   'Placa Vigente','Placa Anterior','Estado','Anotaciones','Sede',
                   'Año de Modelo','Categoría','Uso','Combustible','Asientos',
                   'Peso Bruto','Cilindrada','Potencia','Propietario(s)'];
    const ordenado = {};
    for (const k of ORDEN) if (result.campos[k]) ordenado[k] = result.campos[k];
    // Resto de campos no mapeados
    for (const [k, v] of Object.entries(result.campos)) if (!ordenado[k]) ordenado[k] = v;
    result.campos = ordenado;

    console.log('[SUNARP] ✅ Campos extraídos:', Object.keys(result.campos).join(', '));
  } catch (e) {
    console.log('[SUNARP] parsearJSONSunarp error:', e.message);
  }
  result.textoPlano = raw.length < 1500 ? raw : raw.substring(0, 400) + '...[truncado]';
  return result;
}

// ══════════════════════════════════════════════════════════════════════════════
// SAT — Popup directo en Popupv2.aspx?t=8, sin CAPTCHA (gratis)
// ══════════════════════════════════════════════════════════════════════════════
async function consultarSAT(placa) {
  let browser;
  try {
    console.log('[SAT] Consultando...');
    browser = await launchBrowser(false);
    const page = await browser.newPage();
    await page.setUserAgent(UA);
    await page.setExtraHTTPHeaders({ 'Referer': 'https://www.sat.gob.pe/websitev9/TributosMultas/Papeletas/ConsultasPapeletas' });

    let apiData = null;

    const registrarCaptura = (p) => {
      p.on('response', async response => {
        try {
          if (apiData) return;
          const url = response.url();
          const ct  = (response.headers()['content-type'] || '').toLowerCase();
          if (response.status() < 200 || response.status() >= 300) return;
          if (/google|gstatic|recaptcha|analytics|facebook/i.test(url)) return;
          // Solo JSON puro (no HTML, no text/html)
          if (!ct.includes('application/json')) return;
          const body = await response.text().catch(() => '');
          if (body.length < 10) return;
          if (/papeleta|infraccion|multa|monto/i.test(body)) {
            console.log('[SAT] ✅ Datos JSON capturados:', url);
            apiData = body;
          }
        } catch (_) {}
      });
    };
    registrarCaptura(page);

    // ── Ir directamente al popup de consulta de papeletas ────────────────────
    // URL descubierta en la lista de enlaces de la página principal SAT
    const POPUP_URL = 'https://www.sat.gob.pe/websitev8/Popupv2.aspx?t=8';
    console.log('[SAT] Abriendo popup de consultas:', POPUP_URL);

    await page.goto(POPUP_URL, { waitUntil: 'domcontentloaded', timeout: 25000 });
    await new Promise(r => setTimeout(r, 3000));

    const urlCargada = page.url();
    console.log('[SAT] URL cargada:', urlCargada);
    await page.screenshot({ path: path.join(PUBLIC_DIR, 'sat_popup.png') }).catch(() => {});

    // ── Buscar formulario (puede estar en iframe) ─────────────────────────────
    let ctx = page;
    const frames = page.frames ? page.frames() : [];
    console.log('[SAT] Frames:', frames.length);
    for (const frame of frames) {
      const info = await frame.evaluate(() => ({
        selects: document.querySelectorAll('select').length,
        inputs:  document.querySelectorAll('input').length,
        url:     window.location.href,
      })).catch(() => null);
      if (info) console.log('[SAT] Frame:', JSON.stringify(info));
      if (info && (info.selects > 0 || info.inputs > 1) && frame !== page.mainFrame()) {
        ctx = frame;
        console.log('[SAT] Usando iframe:', frame.url());
        break;
      }
    }

    // ── Seleccionar "Búsqueda por Placa" ─────────────────────────────────────
    const selOk = await ctx.evaluate(() => {
      for (const sel of document.querySelectorAll('select')) {
        for (const opt of sel.options) {
          if (/placa/i.test(opt.text || opt.value)) {
            sel.value = opt.value;
            sel.dispatchEvent(new Event('change', { bubbles: true }));
            sel.dispatchEvent(new Event('input',  { bubbles: true }));
            return 'ok:' + opt.text;
          }
        }
      }
      // Listar opciones disponibles para debug
      const opts = [...document.querySelectorAll('select option')].map(o => o.text);
      return 'no_placa. Opciones: ' + opts.join(', ');
    });
    console.log('[SAT] Select:', selOk);
    await new Promise(r => setTimeout(r, 2000));

    // ── Escribir la placa ─────────────────────────────────────────────────────
    const inputOk = await ctx.evaluate((p) => {
      // Lista de inputs disponibles para debug
      const lista = [...document.querySelectorAll('input')].map(i => ({n: i.name, id: i.id, t: i.type}));
      for (const inp of document.querySelectorAll('input[type="text"], input[type="search"], input:not([type])')) {
        if (inp.readOnly || inp.disabled) continue;
        const nameId = (inp.name + inp.id).toLowerCase();
        if (nameId.includes('busca') && nameId.includes('header')) continue; // skip barra de búsqueda
        inp.focus();
        inp.value = p;
        inp.dispatchEvent(new Event('input',  { bubbles: true }));
        inp.dispatchEvent(new Event('change', { bubbles: true }));
        inp.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true }));
        return 'ok:' + (inp.name || inp.id || '?');
      }
      return 'no_input. Inputs: ' + JSON.stringify(lista);
    }, placa);
    console.log('[SAT] Input:', inputOk);
    await new Promise(r => setTimeout(r, 500));

    // ── Bypass reCAPTCHA y submit ─────────────────────────────────────────────
    const submitOk = await ctx.evaluate(() => {
      document.querySelectorAll('textarea[name*="captcha"], textarea[id*="captcha"], #g-recaptcha-response').forEach(ta => {
        ta.value = 'bypass_free';
        ta.dispatchEvent(new Event('change', { bubbles: true }));
      });
      if (typeof grecaptcha !== 'undefined') {
        try { grecaptcha.getResponse = () => 'bypass_free'; } catch (_) {}
      }
      for (const b of document.querySelectorAll('input[type="submit"], input[type="button"], button[type="submit"], button')) {
        const txt = (b.value || b.textContent || '').trim();
        if (/buscar|consultar|enviar|ver|aceptar/i.test(txt)) { b.click(); return 'btn:' + txt; }
      }
      const form = document.querySelector('form');
      if (form) { form.submit(); return 'form_submit'; }
      return 'nada';
    });
    console.log('[SAT] Submit:', submitOk);

    console.log('[SAT] Esperando respuesta...');
    await new Promise(r => setTimeout(r, 8000));
    await page.screenshot({ path: path.join(PUBLIC_DIR, 'sat_resultado.png') }).catch(() => {});

    // ── Extraer resultados ────────────────────────────────────────────────────
    let datos;
    if (apiData) {
      datos = parsearJSONSAT(apiData);
    } else {
      datos = await extraerDOM(ctx);
    }

    console.log('[SAT] Papeletas encontradas:', datos.papeletas.length);
    return { ok: true, fuente: 'SAT', placa, datos };

  } catch (err) {
    console.error('[SAT] Error:', err.message);
    return { ok: false, fuente: 'SAT', error: err.message };
  } finally {
    if (browser) await browser.close();
  }
}

function parsearJSONSAT(raw) {
  const result = { papeletas: [], resumen: {}, textoPlano: raw.substring(0, 2000) };
  try {
    const json = JSON.parse(raw);
    const buscar = (obj, d = 0) => {
      if (d > 5) return null;
      if (Array.isArray(obj) && obj.length > 0 && typeof obj[0] === 'object') return obj;
      if (typeof obj === 'object' && obj)
        for (const v of Object.values(obj)) { const f = buscar(v, d+1); if (f) return f; }
      return null;
    };
    const arr = buscar(json);
    if (arr) {
      const LABELS = {
        numPapeleta:'N° Papeleta', nroPapeleta:'N° Papeleta', numero:'N° Papeleta',
        fecha:'Fecha', fechaInfraccion:'Fecha Infracción',
        placa:'Placa', codigo:'Código', codInfraccion:'Código',
        descripcion:'Descripción', monto:'Monto (S/)', montoTotal:'Total (S/)',
        estado:'Estado', estadoPago:'Estado Pago', lugar:'Lugar',
      };
      result.papeletas = arr.map(item => {
        const row = {};
        for (const [k, v] of Object.entries(item)) row[LABELS[k] || k] = String(v ?? '');
        return row;
      });
    }
  } catch { /* no JSON */ }
  return result;
}

async function extraerDOM(ctx) {
  return ctx.evaluate(() => {
    const result = { papeletas: [], resumen: {}, textoPlano: '' };
    document.querySelectorAll('table').forEach(table => {
      const ths = [...table.querySelectorAll('th')].map(th => th.innerText.trim());
      if (!ths.length) return;
      table.querySelectorAll('tbody tr').forEach(tr => {
        const cells = [...tr.querySelectorAll('td')].map(td => td.innerText.trim());
        if (cells.length >= 2 && cells.some(c => c)) {
          const row = {};
          cells.forEach((c, i) => { row[ths[i] || `col${i+1}`] = c; });
          result.papeletas.push(row);
        }
      });
    });
    document.querySelectorAll('*').forEach(el => {
      if (el.children.length) return;
      const txt = (el.innerText || '').trim();
      if (txt.match(/S\/[\s\d,.]+/) || /total|deuda|monto|pendiente/i.test(txt))
        if (txt.length > 0 && txt.length < 120) result.resumen[txt] = txt;
    });
    result.textoPlano = document.body.innerText.substring(0, 5000);
    return result;
  });
}

// ══════════════════════════════════════════════════════════════════════════════
// ENDPOINT PRINCIPAL
// ══════════════════════════════════════════════════════════════════════════════
app.get('/api/consultar/:placa', async (req, res) => {
  const placa = req.params.placa.toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!placa || placa.length < 4 || placa.length > 8)
    return res.status(400).json({ error: 'Placa inválida' });

  console.log(`\n${'═'.repeat(50)}`);
  console.log(` Placa: ${placa}  [${new Date().toLocaleTimeString('es-PE')}]`);
  console.log('═'.repeat(50));

  // Ejecutar secuencial para evitar dos Chrome simultáneos (consume mucha RAM)
  const sat    = await consultarSAT(placa);
  const sunarp = await consultarSUNARP(placa);

  res.json({ placa, sunarp, sat, timestamp: new Date().toISOString() });
});

// ── Mini-viewer SUNARP: screenshot, click relay y status ─────────────────────

// Screenshot del Puppeteer de SUNARP — recortado al widget Turnstile si está localizado
app.get('/api/sunarp/preview', async (req, res) => {
  if (!sunarpActivePage) return res.status(404).end();
  try {
    const opts = { type: 'jpeg', quality: 80 };
    if (sunarpTurnstileClip) opts.clip = sunarpTurnstileClip;
    const img = await sunarpActivePage.screenshot(opts);
    res.setHeader('Content-Type', 'image/jpeg');
    res.setHeader('Cache-Control', 'no-cache');
    res.send(img);
  } catch (e) {
    res.status(500).end();
  }
});

// Relay de clic — frontend envía coordenadas fraccionarias (0–1) del área mostrada
app.post('/api/sunarp/click', express.json(), async (req, res) => {
  if (!sunarpActivePage) return res.json({ ok: false, msg: 'no page' });
  const { xFrac, yFrac } = req.body || {};
  if (typeof xFrac !== 'number' || typeof yFrac !== 'number') return res.json({ ok: false, msg: 'bad coords' });
  try {
    let pageX, pageY;
    if (sunarpTurnstileClip) {
      pageX = sunarpTurnstileClip.x + xFrac * sunarpTurnstileClip.width;
      pageY = sunarpTurnstileClip.y + yFrac * sunarpTurnstileClip.height;
    } else {
      pageX = xFrac * 1280;
      pageY = yFrac * 800;
    }
    await sunarpActivePage.mouse.click(pageX, pageY);
    console.log(`[SUNARP] 🖱 Click mini-viewer: frac(${xFrac.toFixed(2)},${yFrac.toFixed(2)}) → página(${Math.round(pageX)},${Math.round(pageY)})`);
    res.json({ ok: true });
  } catch (e) {
    res.json({ ok: false, msg: e.message });
  }
});

// Estado: activo, token recibido, y dimensiones del recorte (para mapeo de clicks)
app.get('/api/sunarp/status', async (req, res) => {
  if (!sunarpActivePage) return res.json({ active: false, token: '', clip: null });
  try {
    const token = await sunarpActivePage.evaluate(() => {
      const i = document.querySelector('[name="cf-turnstile-response"]');
      return i?.value || '';
    });
    res.json({ active: true, token: token || '', clip: sunarpTurnstileClip });
  } catch (_) {
    res.json({ active: !!sunarpActivePage, token: '', clip: null });
  }
});

// Abrir Chrome real en SUNARP para renovar la sesión de Cloudflare (cf_clearance)
app.post('/api/sunarp/renovar-sesion', async (req, res) => {
  if (!CHROME_PATH) return res.json({ ok: false, msg: 'Chrome no encontrado' });
  const { exec } = require('child_process');
  const url = 'https://consultavehicular.sunarp.gob.pe/consulta-vehicular/inicio';
  console.log('[SUNARP] 🌐 Abriendo Chrome para renovar sesión de Cloudflare...');
  exec(`"${CHROME_PATH}" "${url}"`, (err) => {
    if (err) console.log('[SUNARP] Error abriendo Chrome:', err.message);
  });
  res.json({ ok: true, msg: 'Chrome abierto. Espera que cargue SUNARP, luego reintenta la consulta.' });
});

// Estado del token JWT guardado (para mostrar en el UI si el Turnstile es necesario)
app.get('/api/sunarp/token-status', (_, res) => {
  let tieneToken = false;
  let edadMin = null;
  try {
    const data = JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8'));
    edadMin = Math.round((Date.now() - data.timestamp) / 60000);
    tieneToken = edadMin < 20 * 60;
  } catch (_) {}
  res.json({ tieneToken, edadMin });
});

// Borrar token guardado (forzar nueva verificación Turnstile)
app.post('/api/sunarp/borrar-token', (_, res) => {
  try { fs.unlinkSync(TOKEN_FILE); } catch (_) {}
  sunarpAuthToken = null;
  console.log('[SUNARP] 🗑 Token borrado — próxima consulta usará Turnstile');
  res.json({ ok: true });
});

app.get('/api/health', (_, res) => res.json({ status: 'ok' }));
app.get('/', (_, res) => res.sendFile(path.join(__dirname, 'index.html')));

app.listen(PORT, () => {
  console.log('\n' + '═'.repeat(50));
  console.log(`  ✅  Servidor en http://localhost:${PORT}`);
  console.log('═'.repeat(50));
  console.log(`  Chrome: ${CHROME_PATH ? '✅ ' + CHROME_PATH : '⚠️  usando Chromium de Puppeteer'}`);
  console.log('\n  Abre http://localhost:3000 en tu navegador\n');
});
