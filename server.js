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
    // ── Menú Ventas ── (trigger del menú desplegable, no el subitem)
    menu_ventas: '[data-kt-menu-trigger="click"]',  // se filtra por texto "Ventas"

    // ── Botón Nuevo Lead ──
    btn_nuevo_lead: 'a[href="nuevoSeguimiento"]',

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

// Cargar credenciales: primero archivo local, luego variables de entorno (Render)
const CREDS_FILE = path.join(__dirname, 'win-credentials.json');
function loadCreds() {
  // 1. Intentar desde archivo (actualizado por /configurar)
  if (fs.existsSync(CREDS_FILE)) {
    try {
      const c = JSON.parse(fs.readFileSync(CREDS_FILE, 'utf8'));
      WIN.creds.usuario  = c.usuario  || '';
      WIN.creds.password = c.password || '';
      console.log('✓ Credenciales WIN cargadas desde archivo');
      return;
    } catch(e) { console.warn('⚠ Error leyendo win-credentials.json'); }
  }
  // 2. Fallback: variables de entorno (útil en Render si se configura una vez)
  if (process.env.WIN_USUARIO && process.env.WIN_PASSWORD) {
    WIN.creds.usuario  = process.env.WIN_USUARIO;
    WIN.creds.password = process.env.WIN_PASSWORD;
    console.log('✓ Credenciales WIN cargadas desde variables de entorno');
  }
}
loadCreds();

// ─────────────────────────────────────────
// PROGRESO — estado actual de la automatización
// ─────────────────────────────────────────
let progreso = { num: 0, total: 12, paso: 'En espera', icono: '⏳', activo: false };
function setProgreso(num, paso, icono = '⚙️') {
  progreso = { num, total: 12, paso, icono, activo: true, ts: Date.now() };
  console.log(`  [${num}/11] ${icono} ${paso}`);
}
function resetProgreso() {
  progreso = { num: 0, total: 12, paso: 'En espera', icono: '⏳', activo: false };
}

// Carpeta screenshots
const SHOTS_DIR = path.join(__dirname, 'screenshots');
if (!fs.existsSync(SHOTS_DIR)) fs.mkdirSync(SHOTS_DIR);

const sleep = ms => new Promise(r => setTimeout(r, ms));

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
// LOGIN EN WIN (flujo: WIN → Iniciar con Google → Google OAuth → WIN)
// ─────────────────────────────────────────
async function doLogin(pg) {
  setProgreso(1, 'Iniciando sesión en WIN...', '🔑');
  console.log('🔑 Abriendo página de login WIN...');
  await pg.goto(WIN.url_login, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await shot(pg, '01_login_page');

  // ── Paso 1: Ingresar usuario y contraseña ──
  console.log('  → Ingresando credenciales WIN...');
  await pg.waitForSelector('#username', { timeout: 15000 });
  await pg.click('#username', { clickCount: 3 });
  await pg.type('#username', WIN.creds.usuario, { delay: 60 });
  await pg.click('#password', { clickCount: 3 });
  await pg.type('#password', WIN.creds.password, { delay: 60 });
  await shot(pg, '01b_creds_filled');
  await pg.click('#ingresar');
  console.log('  → Credenciales enviadas, esperando siguiente pantalla...');

  // ── Paso 2: Esperar pantalla de selección y clic "Iniciar con Google" ──
  setProgreso(1, 'Seleccionando acceso con Google...', '🔐');
  try {
    await pg.waitForSelector('.login-button.google', { timeout: 20000 });
    await shot(pg, '02_selector_pantalla');
    console.log('  → Clic en "Iniciar con Google"...');
    await pg.click('.login-button.google');
    await shot(pg, '02b_google_clicked');
  } catch(e) {
    await shot(pg, '02_error');
    throw new Error('No apareció el botón "Iniciar con Google": ' + e.message);
  }

  // ── Paso 3: Google OAuth — ingresar email ──
  setProgreso(1, 'Ingresando correo en Google...', '📧');
  console.log('  → Esperando campo email de Google...');
  await pg.waitForSelector('#identifierId', { timeout: 20000 });
  await pg.click('#identifierId', { clickCount: 3 });
  await pg.type('#identifierId', WIN.creds.usuario, { delay: 60 });
  await shot(pg, '03_google_email');
  await pg.click('#identifierNext');
  console.log('  → Email enviado, esperando pantalla de contraseña...');
  await sleep(2000); // esperar transición de pantalla

  // ── Paso 4: Google OAuth — ingresar contraseña ──
  setProgreso(1, 'Ingresando contraseña en Google...', '🔒');
  await pg.waitForSelector('input[name="Passwd"]', { visible: true, timeout: 20000 });
  await sleep(800);
  await pg.click('input[name="Passwd"]', { clickCount: 3 });
  await pg.type('input[name="Passwd"]', WIN.creds.password, { delay: 60 });
  await shot(pg, '04_google_password');
  await pg.click('#passwordNext');
  console.log('  → Contraseña enviada...');

  // ── Paso 5: Posible pantalla "Continuar" ──
  try {
    await pg.waitForFunction(() => {
      const spans = document.querySelectorAll('[jsname="V67aGc"]');
      return [...spans].some(s => s.textContent.trim() === 'Continuar');
    }, { timeout: 10000 });
    await pg.evaluate(() => {
      const spans = document.querySelectorAll('[jsname="V67aGc"]');
      const btn = [...spans].find(s => s.textContent.trim() === 'Continuar');
      if (btn) (btn.closest('button') || btn).click();
    });
    console.log('  → Clic en Continuar');
    await shot(pg, '05_continuar');
  } catch(_) {
    console.log('  → Sin pantalla Continuar, siguiendo...');
  }

  // ── Paso 6: Esperar que WIN cargue con menú ──
  setProgreso(1, 'Esperando que WIN cargue...', '⏳');
  try {
    await pg.waitForFunction(
      () => !window.location.href.includes('accounts.google.com') && !window.location.href.includes('/login'),
      { timeout: 30000 }
    );
  } catch(_) {
    await shot(pg, '06_win_no_cargo');
    throw new Error('Google OK pero WIN no redirigió. URL: ' + pg.url());
  }
  try {
    await pg.waitForSelector('[data-kt-menu-trigger="click"]', { timeout: 20000 });
  } catch(_) {
    await shot(pg, '06_menu_no_cargo');
    throw new Error('WIN cargó pero el menú no apareció. URL: ' + pg.url());
  }

  await shot(pg, '06_post_login');
  loggedIn = true;
  console.log('✓ Login exitoso. URL:', pg.url());
}

// Detecta si WIN cerró la sesión y re-ingresa automáticamente
async function checkSesionWIN(pg) {
  const url = pg.url();
  const enLogin = url.includes('/login') || url.includes('accounts.google.com');
  if (enLogin) {
    console.log('⚠ Sesión WIN expirada. Re-ingresando automáticamente...');
    loggedIn = false;
    await doLogin(pg);
    return true;
  }
  return false;
}

// ─────────────────────────────────────────
// FLUJO COMPLETO DE VALIDACIÓN
// ─────────────────────────────────────────
async function ejecutarValidacion(datos) {
  resetProgreso();
  const pg = await getPage();

  // Login inicial o re-login si la sesión expiró
  if (!loggedIn) {
    await doLogin(pg);
  } else {
    await checkSesionWIN(pg);
  }

  // ── PASO 1: Clic en menú "Ventas" ──────────────────────────────
  setProgreso(2, 'Navegando al menú Ventas...', '📋');
  console.log('📌 Paso 1: Navegando a Ventas...');
  await checkSesionWIN(pg);

  try {
    await pg.waitForFunction(() => {
      const items = document.querySelectorAll('[data-kt-menu-trigger="click"]');
      return [...items].some(el => el.querySelector('.menu-title')?.textContent.trim() === 'Ventas');
    }, { timeout: 15000 });

    await pg.evaluate(() => {
      const items = document.querySelectorAll('[data-kt-menu-trigger="click"]');
      const ventas = [...items].find(el => el.querySelector('.menu-title')?.textContent.trim() === 'Ventas');
      if (ventas) ventas.querySelector('.menu-link').click();
    });

    await sleep(2000); // esperar que el submenú se despliegue
    await shot(pg, '04_menu_ventas');
  } catch(e) {
    throw new Error('No se encontró el menú Ventas: ' + e.message);
  }

  // ── PASO 2: Clic en submenú "Nuevo Lead" (navega a la página) ──
  setProgreso(3, 'Abriendo página Nuevo Lead...', '📝');
  console.log('📌 Paso 2: Clic en submenú Nuevo Lead...');
  await pg.waitForSelector(WIN.sel.btn_nuevo_lead, { timeout: 10000 });
  await sleep(500); // pequeña pausa antes de hacer clic
  await pg.click(WIN.sel.btn_nuevo_lead);
  await sleep(3000); // esperar que la página de leads cargue completamente
  await shot(pg, '05_pagina_nuevo_lead');

  // ── PASO 3: Clic en botón "Añadir nuevo Lead" (abre el modal) ──
  setProgreso(4, 'Abriendo formulario (Añadir nuevo Lead)...', '📋');
  console.log('📌 Paso 3: Clic en botón "Añadir nuevo Lead"...');
  try {
    await pg.waitForSelector('#btnNuevoLead', { timeout: 15000 });
    await sleep(500);
    await pg.click('#btnNuevoLead');
    await sleep(2000); // esperar que el modal se abra con su animación
    await shot(pg, '06_modal_abierto');
  } catch(e) {
    await shot(pg, '06_btn_no_encontrado');
    throw new Error('No apareció el botón "Añadir nuevo Lead": ' + e.message);
  }

  // ── PASO 4: Llenar formulario según tipo ───────────────────────
  if (datos.tipo === 'coords') {
    setProgreso(5, 'Ingresando coordenadas GPS...', '📍');
    console.log('📌 Paso 4: Ingresando coordenadas...');
    const [lat, lon] = datos.direccion.split(',').map(s => s.trim());

    await pg.waitForSelector(WIN.sel.input_lat, { timeout: 10000 });
    await sleep(500);
    await limpiarYEscribir(pg, WIN.sel.input_lat, lat);
    await sleep(600);
    await limpiarYEscribir(pg, WIN.sel.input_lon, lon);
    await sleep(600);
    await shot(pg, '06_coords_filled');

  } else {
    setProgreso(5, 'Ingresando dirección por calle...', '🏠');
    console.log('📌 Paso 4: Ingresando dirección por calle...');

    // Distrito
    await pg.waitForSelector(WIN.sel.input_distrito, { timeout: 10000 });
    await sleep(500);
    await limpiarYEscribir(pg, WIN.sel.input_distrito, datos.distrito || '');
    await sleep(1000); // esperar autocomplete de distrito

    // Urbanización (opcional)
    if (datos.hhuu) {
      await limpiarYEscribir(pg, WIN.sel.input_hhuu, datos.hhuu);
      await sleep(800);
    }

    // Nombre de calle
    await limpiarYEscribir(pg, WIN.sel.input_via, datos.via || '');
    await sleep(800);

    // Número
    await limpiarYEscribir(pg, WIN.sel.input_numero, datos.numero || '');
    await sleep(600);
    await shot(pg, '06_calle_filled');
  }

  // ── PASO 5: Clic en Buscar ─────────────────────────────────────
  setProgreso(6, 'Buscando ubicación en mapa...', '🗺️');
  console.log('📌 Paso 5: Buscando en mapa...');
  await pg.waitForSelector(WIN.sel.btn_buscar, { timeout: 8000 });
  await sleep(500);
  await pg.click(WIN.sel.btn_buscar);
  await sleep(2500); // esperar que el mapa procese y genere el popup
  await shot(pg, '07_after_buscar');

  // ── PASO 6: Clic en Confirmar del popup ───────────────────────
  setProgreso(7, 'Confirmando punto en el mapa...', '📌');
  console.log('📌 Paso 6: Esperando popup de confirmación...');
  try {
    await pg.waitForSelector(WIN.sel.popup_confirmar, { timeout: 20000 });
  } catch(e) {
    await shot(pg, '08_popup_timeout');
    const sinResultado = await pg.$('.no-results, .sin-cobertura, [class*="no-result"]').catch(() => null);
    if (sinResultado) {
      return { ok: true, resultado: 'sin_cobertura', detalle: 'Dirección no encontrada en cobertura WIN', paso: 'sin_resultado' };
    }
    throw new Error('No apareció el popup del mapa. Verifica la dirección o revisa screenshots. ' + e.message);
  }

  await sleep(800);
  await shot(pg, '08_popup_visible');

  let popupTexto = '';
  try {
    popupTexto = await pg.$eval(WIN.sel.popup_content, el => {
      return el.firstChild?.textContent?.trim() || el.textContent.trim();
    });
  } catch(_) {}
  console.log('  📍 Popup:', popupTexto);

  await pg.click(WIN.sel.popup_confirmar);
  await sleep(2000);
  await shot(pg, '09_confirmar_clicked');

  // ── PASO 7: Clic en Continuar ─────────────────────────────────
  setProgreso(8, 'Avanzando a información del cliente...', '➡️');
  console.log('📌 Paso 7: Esperando y clicando Continuar...');
  await pg.waitForSelector(WIN.sel.btn_continuar, { timeout: 25000 });
  await sleep(800);
  await shot(pg, '10_continuar_visible');
  await pg.click(WIN.sel.btn_continuar);
  await sleep(2500);
  await shot(pg, '11_info_cliente_tab');

  // ── PASO 8: Leer resultado de cobertura ───────────────────────
  setProgreso(9, 'Verificando cobertura WIN...', '📡');
  console.log('📌 Paso 8: Verificando cobertura...');
  let tieneCobertura = false;
  try {
    await pg.waitForSelector(WIN.sel.alert_cobertura, { timeout: 12000 });
    await sleep(500);
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

  // ── PASO 9: Seleccionar tipo de documento "DNI" ───────────────
  setProgreso(10, 'Seleccionando tipo de documento DNI...', '🪪');
  console.log('📌 Paso 9: Seleccionando tipo DNI...');

  // Clic en el contenedor select2 para abrir el dropdown
  await pg.waitForSelector('#select2-tipo_doc-container', { timeout: 10000 });
  await sleep(500);
  await pg.click('#select2-tipo_doc-container');
  await sleep(1200); // esperar que se despliegue el dropdown

  // Esperar que aparezcan las opciones y seleccionar DNI
  await pg.waitForSelector('#select2-tipo_doc-results', { visible: true, timeout: 10000 });
  await sleep(400);
  await pg.evaluate(() => {
    const opts = document.querySelectorAll('#select2-tipo_doc-results .select2-results__option');
    const dni  = [...opts].find(o => o.textContent.trim() === 'DNI');
    if (dni) dni.click();
    else throw new Error('Opción DNI no encontrada');
  });
  await sleep(1000);
  await shot(pg, '13_tipo_doc_dni');

  // ── PASO 10: Ingresar número de DNI ───────────────────────────
  setProgreso(10, `Ingresando DNI ${datos.dni}...`, '🔢');
  console.log('📌 Paso 10: Ingresando DNI:', datos.dni);
  if (!datos.dni) throw new Error('DNI no proporcionado para búsqueda de score');
  await limpiarYEscribir(pg, WIN.sel.input_dni, datos.dni);
  await sleep(800);
  await shot(pg, '14_dni_ingresado');

  // ── PASO 11: Clic en buscar score ─────────────────────────────
  setProgreso(11, 'Consultando score crediticio...', '📊');
  console.log('📌 Paso 11: Buscando score del cliente...');
  await pg.waitForSelector(WIN.sel.btn_buscar_score, { timeout: 5000 });
  await sleep(300);
  await pg.click(WIN.sel.btn_buscar_score);
  await sleep(1500);
  await shot(pg, '15_score_buscando');

  // ── PASO 12: Esperar resultado del score ──────────────────────
  setProgreso(12, 'Esperando resultado del score...', '⏳');
  console.log('⏳ Esperando resultado del score...');
  try {
    await pg.waitForFunction(() => {
      const el = document.getElementById('espere_por_favor');
      return el && el.textContent.trim() !== '' && !el.textContent.includes('Espere');
    }, { timeout: 30000 });
    await sleep(500);
  } catch(_) {
    await shot(pg, '16_score_timeout');
    throw new Error('Tiempo de espera agotado al obtener el score del cliente');
  }

  const scoreTitulo  = await pg.$eval(WIN.sel.score_titulo,  el => el.textContent.trim()).catch(() => '');
  const scoreDetalle = await pg.$eval(WIN.sel.score_detalle, el => el.textContent.trim()).catch(() => '');
  await shot(pg, '16_score_resultado');

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

// Debug: ver estado actual del navegador
app.get('/debug', async (_req, res) => {
  try {
    if (!page || page.isClosed()) return res.json({ ok: false, msg: 'Sin página activa' });
    const url   = page.url();
    const title = await page.title().catch(() => '');
    const shot64 = await page.screenshot({ encoding: 'base64', type: 'jpeg', quality: 60 }).catch(() => null);
    res.json({ ok: true, url, title, loggedIn, screenshot: shot64 ? `data:image/jpeg;base64,${shot64}` : null });
  } catch(e) {
    res.json({ ok: false, error: e.message });
  }
});

// Progreso actual de la automatización
app.get('/progreso', (_req, res) => {
  res.json(progreso);
});

// Estado
app.get('/estado', (_req, res) => {
  res.json({
    ok:            true,
    servidor:      'L-TEL Validador WIN v2.0',
    loggedIn,
    credsCargadas: !!(WIN.creds.usuario && WIN.creds.password),
    timestamp:     new Date().toISOString(),
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
    // Si el error fue de sesión expirada, reintentar una vez automáticamente
    if (e.message.toLowerCase().includes('login') || e.message.toLowerCase().includes('sesi')) {
      console.log('🔄 Reintentando tras re-login...');
      loggedIn = false;
      try {
        const resultado = await ejecutarValidacion({ dni, tipo, direccion, distrito, hhuu, via, numero });
        console.log('✓ Reintento exitoso:', resultado.resultado);
        return res.json({ ...resultado, dni, tipo });
      } catch(e2) {
        console.error('✗ Reintento fallido:', e2.message);
        return res.status(500).json({ ok: false, error: e2.message });
      }
    }
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
app.post('/logout-win', async (_req, res) => {
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
