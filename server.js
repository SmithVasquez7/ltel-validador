/**
 * L-TEL — Servidor de Automatización WIN
 * Node.js + Express + Puppeteer
 *
 * Local:  node server.js
 * Cloud:  Render.com (usa @sparticuz/chromium)
 */

const express   = require('express');
const cors      = require('cors');
const path      = require('path');
const fs        = require('fs');

// ── Puppeteer: local usa puppeteer completo, Render usa puppeteer-core + chromium ──
const IS_RENDER = !!process.env.RENDER;
let puppeteer, chromium;
if (IS_RENDER) {
  puppeteer = require('puppeteer-core');
  chromium  = require('@sparticuz/chromium');
} else {
  puppeteer = require('puppeteer');
}

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(cors({ origin: '*' }));
app.use(express.json());

// ─────────────────────────────────────────
// CONFIGURACIÓN WIN — SELECTORES REALES
// ─────────────────────────────────────────
const WIN = {
  url_login: 'https://appwinforce.win.pe/login',

  creds: { usuario: '', password: '' },

  sel: {
    // ── Login ──
    input_usuario:  '#email',
    input_password: '#password',
    btn_login:      '[type="submit"]',

    // ── Menú Ventas ──
    menu_ventas: '.menu-link',   // se filtra por texto "Ventas"

    // ── Botón Nuevo Lead ──
    btn_nuevo_lead: '#btnNuevoLead',

    // ── Formulario Dirección (calle) ──
    input_distrito:  '#gf_distrito',
    input_hhuu:      '#gf_hhuu',
    input_via:       '#gf_via',
    input_numero:    '#gf_numero',

    // ── Formulario Coordenadas ──
    input_lat:  '#gf_lat',
    input_lon:  '#gf_lon',

    // ── Botón Buscar mapa ──
    btn_buscar: '#gf_buscar',

    // ── Popup del mapa ──
    popup_confirmar: '.leaflet-popup-content .gf_btnPopup',
    popup_content:   '.leaflet-popup-content',

    // ── Botón Continuar (tab Mapa → tab Información cliente) ──
    btn_continuar: '#continuar',

    // ── Tab "Información del cliente" ──
    alert_cobertura:   '.alert.bg-light-success h5',
    select2_tipo_doc:  '.select2_select',
    input_dni:         '#documento_identidad',
    btn_buscar_score:  '#search_score_cliente',
    score_titulo:      '#espere_por_favor',
    score_detalle:     '#estamos_verificando',
  }
};

// Cargar credenciales desde archivo
const CREDS_FILE = path.join(__dirname, 'win-credentials.json');
function loadCreds() {
  if (fs.existsSync(CREDS_FILE)) {
    try {
      const c = JSON.parse(fs.readFileSync(CREDS_FILE, 'utf8'));
      WIN.creds.usuario  = c.usuario  || '';
      WIN.creds.password = c.password || '';
      console.log('✓ Credenciales WIN cargadas');
    } catch(e) { console.warn('⚠ Error leyendo win-credentials.json'); }
  }
}
loadCreds();

// Carpeta screenshots
const SHOTS_DIR = path.join(__dirname, 'screenshots');
if (!fs.existsSync(SHOTS_DIR)) fs.mkdirSync(SHOTS_DIR);

async function shot(page, name) {
  try {
    await page.screenshot({ path: path.join(SHOTS_DIR, `${name}_${Date.now()}.png`) });
    console.log(`  📸 ${name}`);
  } catch(_) {}
}

// ─────────────────────────────────────────
// BROWSER — reutilizable entre peticiones
// ─────────────────────────────────────────
let browser  = null;
let page     = null;
let loggedIn = false;

async function getPage() {
  if (!browser || !browser.connected) {
    console.log('🌐 Iniciando Chrome... (Render:', IS_RENDER, ')');

    let launchOptions;
    if (IS_RENDER) {
      // Render.com: usa Chromium headless ligero
      launchOptions = {
        args:            chromium.args,
        defaultViewport: chromium.defaultViewport,
        executablePath:  await chromium.executablePath(),
        headless:        chromium.headless,
      };
    } else {
      // Local: usa Chrome instalado con puppeteer, ventana visible
      launchOptions = {
        headless:        false,
        defaultViewport: null,
        args:            ['--start-maximized', '--no-sandbox'],
      };
    }

    browser = await puppeteer.launch(launchOptions);
    page     = null;
    loggedIn = false;
  }
  if (!page || page.isClosed()) {
    page     = await browser.newPage();
    loggedIn = false;
  }
  return page;
}

// ─────────────────────────────────────────
// LOGIN EN WIN
// ─────────────────────────────────────────
async function doLogin(pg) {
  console.log('🔑 Haciendo login en WIN...');
  await pg.goto(WIN.url_login, { waitUntil: 'networkidle2', timeout: 30000 });
  await shot(pg, '01_login_page');

  // Esperar campo usuario
  await pg.waitForSelector(WIN.sel.input_usuario, { timeout: 12000 });

  // Llenar usuario
  await pg.click(WIN.sel.input_usuario, { clickCount: 3 });
  await pg.type(WIN.sel.input_usuario, WIN.creds.usuario, { delay: 55 });

  // Llenar password
  await pg.click(WIN.sel.input_password, { clickCount: 3 });
  await pg.type(WIN.sel.input_password, WIN.creds.password, { delay: 55 });

  await shot(pg, '02_login_filled');
  await pg.click(WIN.sel.btn_login);

  // Esperar navegación post-login
  await pg.waitForNavigation({ waitUntil: 'networkidle2', timeout: 20000 });
  await shot(pg, '03_post_login');

  const url = pg.url();
  if (url.includes('/login')) {
    throw new Error('Login fallido — verifica credenciales WIN');
  }
  loggedIn = true;
  console.log('✓ Login exitoso. URL:', url);
}

// ─────────────────────────────────────────
// FLUJO COMPLETO DE VALIDACIÓN
// ─────────────────────────────────────────
async function ejecutarValidacion(datos) {
  const pg = await getPage();

  // Login si es necesario
  if (!loggedIn) {
    await doLogin(pg);
  } else {
    // Verificar que no haya caducado la sesión
    const url = pg.url();
    if (url.includes('/login')) {
      loggedIn = false;
      await doLogin(pg);
    }
  }

  // ── PASO 1: Clic en menú "Ventas" ──────────────────────────────
  console.log('📌 Paso 1: Navegando a Ventas...');
  try {
    // Buscar el link de menú que contenga el texto "Ventas"
    await pg.waitForFunction(() => {
      const links = document.querySelectorAll('.menu-link');
      return [...links].some(l => l.textContent.trim().includes('Ventas'));
    }, { timeout: 10000 });

    await pg.evaluate(() => {
      const links = document.querySelectorAll('.menu-link');
      const ventas = [...links].find(l => l.textContent.trim().includes('Ventas'));
      if (ventas) ventas.click();
    });

    await pg.waitForTimeout(800);
    await shot(pg, '04_menu_ventas');
  } catch(e) {
    throw new Error('No se encontró el menú Ventas: ' + e.message);
  }

  // ── PASO 2: Clic en "Añadir nuevo Lead" ───────────────────────
  console.log('📌 Paso 2: Clic en Nuevo Lead...');
  await pg.waitForSelector(WIN.sel.btn_nuevo_lead, { timeout: 10000 });
  await pg.click(WIN.sel.btn_nuevo_lead);
  await pg.waitForTimeout(1200); // esperar que abra el modal
  await shot(pg, '05_modal_nuevo_lead');

  // ── PASO 3: Llenar formulario según tipo ───────────────────────
  if (datos.tipo === 'coords') {
    console.log('📌 Paso 3: Ingresando coordenadas...');
    const [lat, lon] = datos.direccion.split(',').map(s => s.trim());

    await pg.waitForSelector(WIN.sel.input_lat, { timeout: 10000 });
    await limpiarYEscribir(pg, WIN.sel.input_lat, lat);
    await limpiarYEscribir(pg, WIN.sel.input_lon, lon);
    await shot(pg, '06_coords_filled');

  } else {
    console.log('📌 Paso 3: Ingresando dirección por calle...');

    // Distrito
    await pg.waitForSelector(WIN.sel.input_distrito, { timeout: 10000 });
    await limpiarYEscribir(pg, WIN.sel.input_distrito, datos.distrito || '');
    await pg.waitForTimeout(600); // esperar autocomplete

    // Urbanización (opcional)
    if (datos.hhuu) {
      await limpiarYEscribir(pg, WIN.sel.input_hhuu, datos.hhuu);
      await pg.waitForTimeout(400);
    }

    // Nombre de calle
    await limpiarYEscribir(pg, WIN.sel.input_via, datos.via || '');
    await pg.waitForTimeout(400);

    // Número
    await limpiarYEscribir(pg, WIN.sel.input_numero, datos.numero || '');
    await shot(pg, '06_calle_filled');
  }

  // ── PASO 4: Clic en Buscar ─────────────────────────────────────
  console.log('📌 Paso 4: Buscando en mapa...');
  await pg.waitForSelector(WIN.sel.btn_buscar, { timeout: 8000 });
  await pg.click(WIN.sel.btn_buscar);

  // Esperar que aparezca el popup del mapa (máx 20s)
  console.log('⏳ Esperando popup del mapa...');
  await shot(pg, '07_after_buscar');

  // ── PASO 5: Clic en Confirmar del popup ───────────────────────
  console.log('📌 Paso 5: Esperando popup de confirmación...');
  try {
    await pg.waitForSelector(WIN.sel.popup_confirmar, { timeout: 20000 });
    await shot(pg, '08_popup_visible');

    // Leer texto del popup para devolverlo como resultado
    let popupTexto = '';
    try {
      popupTexto = await pg.$eval(WIN.sel.popup_content, el => {
        // El texto es el primer nodo de texto del div (antes del input)
        return el.firstChild?.textContent?.trim() || el.textContent.trim();
      });
    } catch(_) {}

    console.log('  📍 Popup:', popupTexto);
    await pg.click(WIN.sel.popup_confirmar);
    await shot(pg, '09_confirmar_clicked');

    // ── PASO 6: Clic en Continuar ─────────────────────────────────
    console.log('📌 Paso 6: Esperando y clicando Continuar...');
    await pg.waitForSelector(WIN.sel.btn_continuar, { timeout: 25000 });
    await shot(pg, '10_continuar_visible');
    await pg.click(WIN.sel.btn_continuar);
    await pg.waitForTimeout(1200);
    await shot(pg, '11_info_cliente_tab');

    // ── PASO 7: Leer resultado de cobertura ───────────────────────
    console.log('📌 Paso 7: Verificando cobertura...');
    let tieneCobertura = false;
    try {
      await pg.waitForSelector(WIN.sel.alert_cobertura, { timeout: 10000 });
      const cobText = await pg.$eval(WIN.sel.alert_cobertura, el => el.textContent.trim());
      tieneCobertura = cobText.toLowerCase().includes('cobertura');
      console.log('  📍 Cobertura:', cobText, '→', tieneCobertura);
    } catch(_) {
      console.warn('  ⚠ No se encontró alerta de cobertura (asumiendo sin cobertura)');
    }
    await shot(pg, '12_cobertura_leida');

    if (!tieneCobertura) {
      return {
        ok:        true,
        resultado: 'sin_cobertura',
        detalle:   'La dirección NO tiene cobertura WIN',
        paso:      'cobertura_verificada',
      };
    }

    // ── PASO 8: Seleccionar tipo de documento "DNI" ───────────────
    console.log('📌 Paso 8: Seleccionando tipo DNI...');
    try {
      await pg.click(WIN.sel.select2_tipo_doc);
      await pg.waitForSelector('.select2-results__option', { timeout: 8000 });
      await pg.evaluate(() => {
        const opts = document.querySelectorAll('.select2-results__option');
        const dni  = [...opts].find(o => o.textContent.includes('DNI'));
        if (dni) dni.click();
        else throw new Error('Opción DNI no encontrada en dropdown');
      });
      await pg.waitForTimeout(500);
      await shot(pg, '13_tipo_doc_dni');
    } catch(e) {
      throw new Error('No se pudo seleccionar DNI en tipo de documento: ' + e.message);
    }

    // ── PASO 9: Ingresar número de DNI ────────────────────────────
    console.log('📌 Paso 9: Ingresando DNI:', datos.dni);
    if (!datos.dni) throw new Error('DNI no proporcionado para búsqueda de score');
    await limpiarYEscribir(pg, WIN.sel.input_dni, datos.dni);
    await shot(pg, '14_dni_ingresado');

    // ── PASO 10: Clic en buscar score ─────────────────────────────
    console.log('📌 Paso 10: Buscando score del cliente...');
    await pg.click(WIN.sel.btn_buscar_score);
    await shot(pg, '15_score_buscando');

    // ── PASO 11: Esperar resultado del score ──────────────────────
    console.log('⏳ Esperando resultado del score...');
    try {
      await pg.waitForFunction(() => {
        const el = document.getElementById('espere_por_favor');
        return el && el.textContent.trim() !== '' && !el.textContent.includes('Espere');
      }, { timeout: 25000 });
    } catch(_) {
      await shot(pg, '16_score_timeout');
      throw new Error('Tiempo de espera agotado al obtener el score del cliente');
    }

    const scoreTitulo  = await pg.$eval(WIN.sel.score_titulo,  el => el.textContent.trim()).catch(() => '');
    const scoreDetalle = await pg.$eval(WIN.sel.score_detalle, el => el.textContent.trim()).catch(() => '');
    await shot(pg, '16_score_resultado');

    // Extraer número del score (busca el primer número en el texto)
    const textoScore = scoreTitulo + ' ' + scoreDetalle;
    const scoreMatch = textoScore.match(/\d+/);
    const scoreNum   = scoreMatch ? parseInt(scoreMatch[0]) : null;
    const aprobado   = scoreNum !== null && scoreNum >= 301;

    console.log(`  📊 Score: ${scoreNum} | Aprobado (≥301): ${aprobado}`);
    console.log(`  📝 "${scoreTitulo}" — "${scoreDetalle}"`);

    return {
      ok:             true,
      resultado:      aprobado ? 'aprobado' : 'rechazado',
      detalle:        `${scoreTitulo} — ${scoreDetalle}`,
      scoreTitulo,
      scoreDetalle,
      scoreNum,
      aprobado,
      tieneCobertura: true,
      paso:           'score_obtenido',
    };

  } catch(e) {
    await shot(pg, '08_popup_timeout');
    const sinResultado = await pg.$('.no-results, .sin-cobertura, [class*="no-result"]').catch(() => null);
    if (sinResultado) {
      return { ok: true, resultado: 'sin_cobertura', detalle: 'Dirección no encontrada en cobertura WIN', paso: 'sin_resultado' };
    }
    throw new Error('No apareció el popup del mapa. Verifica la dirección o revisa screenshots. ' + e.message);
  }
}

// Helper: limpiar campo y escribir
async function limpiarYEscribir(pg, selector, texto) {
  await pg.waitForSelector(selector, { timeout: 8000 });
  await pg.click(selector, { clickCount: 3 });
  await pg.keyboard.down('Control');
  await pg.keyboard.press('A');
  await pg.keyboard.up('Control');
  await pg.keyboard.press('Backspace');
  if (texto) await pg.type(selector, texto, { delay: 45 });
}

// ─────────────────────────────────────────
// ENDPOINTS
// ─────────────────────────────────────────

// Estado
app.get('/estado', (req, res) => {
  res.json({
    ok: true,
    servidor: 'L-TEL Validador WIN v2.0',
    loggedIn,
    credenciales_ok: !!(WIN.creds.usuario && WIN.creds.password),
    timestamp: new Date().toISOString(),
  });
});

// Validar cobertura
app.post('/validar', async (req, res) => {
  const { dni, tipo, direccion, distrito, hhuu, via, numero } = req.body;

  if (!tipo) return res.status(400).json({ ok: false, error: 'Falta campo: tipo' });
  if (tipo === 'coords' && !direccion) return res.status(400).json({ ok: false, error: 'Falta coordenadas' });
  if (tipo === 'calle' && (!distrito || !via || !numero)) return res.status(400).json({ ok: false, error: 'Faltan campos: distrito, via, numero' });
  if (!WIN.creds.usuario) return res.status(500).json({ ok: false, error: 'Credenciales WIN no configuradas' });

  console.log(`\n${'═'.repeat(50)}`);
  console.log(`▶ Validando — DNI: ${dni} | Tipo: ${tipo}`);
  if (tipo === 'calle') console.log(`  ${distrito} / ${hhuu||'-'} / ${via} ${numero}`);
  else console.log(`  Coords: ${direccion}`);
  console.log(`${'═'.repeat(50)}`);

  try {
    const resultado = await ejecutarValidacion({ dni, tipo, direccion, distrito, hhuu, via, numero });
    console.log('✓ Resultado:', resultado.resultado);
    res.json({ ...resultado, dni, tipo });
  } catch(e) {
    console.error('✗ Error:', e.message);
    if (e.message.includes('Login') || e.message.includes('login')) loggedIn = false;
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Guardar credenciales WIN
app.post('/configurar', (req, res) => {
  const { usuario, password } = req.body;
  if (!usuario || !password) return res.status(400).json({ ok: false, error: 'Faltan credenciales' });
  WIN.creds.usuario  = usuario;
  WIN.creds.password = password;
  fs.writeFileSync(CREDS_FILE, JSON.stringify({ usuario, password }, null, 2));
  loggedIn = false;
  console.log('✓ Credenciales WIN actualizadas');
  res.json({ ok: true });
});

// Forzar logout WIN
app.post('/logout-win', async (req, res) => {
  loggedIn = false;
  if (page && !page.isClosed()) await page.goto(WIN.url_login).catch(()=>{});
  res.json({ ok: true, message: 'Sesión WIN cerrada' });
});

// Screenshots estáticos
app.use('/screenshots', express.static(SHOTS_DIR));

// ─────────────────────────────────────────
app.listen(PORT, () => {
  console.log('');
  console.log('╔══════════════════════════════════════════╗');
  console.log('║  L-TEL Validador WIN  —  Puerto ' + PORT + '      ║');
  console.log('╚══════════════════════════════════════════╝');
  console.log('');
  console.log('  GET  /estado       → Estado servidor');
  console.log('  POST /validar      → Validar cobertura');
  console.log('  POST /configurar   → Guardar creds WIN');
  console.log('  POST /logout-win   → Cerrar sesión WIN');
  console.log('');
  if (!WIN.creds.usuario) {
    console.log('  ⚠  Sin credenciales WIN. Configura en el dashboard.');
    console.log('');
  }
});

process.on('SIGINT',  () => { browser?.close(); process.exit(); });
process.on('SIGTERM', () => { browser?.close(); process.exit(); });
