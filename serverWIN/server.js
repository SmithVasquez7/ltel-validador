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
    input_cruce:     '#gf_cruce',
    input_manzana:   '#gf_manzana',
    input_lote:      '#gf_lote',
    input_km:        '#gf_km',

    // ── Formulario Coordenadas ──
    input_lat:  '#gf_lat',
    input_lon:  '#gf_lon',

    // ── Botón Buscar mapa ──
    btn_buscar:       '#gf_buscar',             // búsqueda por dirección
    btn_buscar_coord: '#gf_buscar_coordenadas', // búsqueda por coordenadas GPS

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
let progreso = { num: 0, total: 12, paso: 'En espera', icono: '⏳', activo: false, operadorActivo: '', operadorNombreActivo: '' };
function setProgreso(num, paso, icono = '⚙️') {
  progreso = { ...progreso, num, total: 12, paso, icono, activo: true, ts: Date.now() };
  console.log(`  [${num}/11] ${icono} ${paso}`);
}
function resetProgreso() {
  progreso = { num: 0, total: 12, paso: 'En espera', icono: '⏳', activo: false, operadorActivo: '', operadorNombreActivo: '' };
}

// Captura en vivo — se actualiza cada vez que el dashboard la pide (máx cada 2s)
let liveShot = null;
let liveShotTs = 0;

// Carpeta screenshots
const SHOTS_DIR = path.join(__dirname, 'screenshots');
if (!fs.existsSync(SHOTS_DIR)) fs.mkdirSync(SHOTS_DIR);

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ─────────────────────────────────────────
// GUARDAR EN FIRESTORE vía REST API (sin firebase-admin)
// ─────────────────────────────────────────
const FS_API_KEY  = 'AIzaSyDre3Wdt__AKKP2NGiv-I5ksqscoVPDsho';
const FS_PROJECT  = 'softkes-ssi';
const FS_COLL     = 'validacionesWIN';

function toFsVal(v) {
  if (v === null || v === undefined) return { nullValue: null };
  if (typeof v === 'boolean')        return { booleanValue: v };
  if (typeof v === 'number')         return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  if (typeof v === 'string')         return { stringValue: v };
  return { stringValue: String(v) };
}

async function guardarEnFirestore(datos) {
  const url = `https://firestore.googleapis.com/v1/projects/${FS_PROJECT}/databases/(default)/documents/${FS_COLL}?key=${FS_API_KEY}`;
  const fields = {};
  Object.entries(datos).forEach(([k, v]) => { fields[k] = toFsVal(v); });

  const resp = await fetch(url, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ fields }),
  });

  const json = await resp.json();
  if (!resp.ok) throw new Error(json.error?.message || `HTTP ${resp.status}`);
  const docId = json.name.split('/').pop();
  console.log(`  ✅ Firestore OK → validacionesWIN/${docId}`);
  return docId;
}

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
      // Local: Chrome visible — Google bloquea el modo headless en el login
      launchOptions = {
        headless:        false,
        defaultViewport: null,
        args:            ['--no-sandbox', '--window-size=1100,750', '--window-position=200,50'],
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

  // ── Pasos 3-5: Google OAuth (solo si Google pide credenciales) ──
  // Si la sesión Google ya está activa, salta directo a WIN sin pedir email/password
  setProgreso(1, 'Autenticando con Google...', '🔐');
  console.log('  → Detectando si Google requiere credenciales o ya hay sesión activa...');

  const googleRequiereCreds = await Promise.race([
    // Opción A: Google pide email → hay que ingresar credenciales
    pg.waitForSelector('#identifierId', { timeout: 18000 }).then(() => true).catch(() => false),
    // Opción B: WIN ya cargó directamente (sesión Google activa)
    pg.waitForFunction(
      () => !window.location.href.includes('accounts.google.com'),
      { timeout: 18000 }
    ).then(() => false).catch(() => false),
  ]);

  if (googleRequiereCreds) {
    console.log('  → Google pide credenciales — ingresando...');
    setProgreso(1, 'Ingresando correo en Google...', '📧');
    await pg.click('#identifierId', { clickCount: 3 });
    await pg.type('#identifierId', WIN.creds.usuario, { delay: 60 });
    await shot(pg, '03_google_email');
    await pg.click('#identifierNext');
    console.log('  → Email enviado, esperando pantalla de contraseña...');
    await sleep(2000);

    setProgreso(1, 'Ingresando contraseña en Google...', '🔒');
    await pg.waitForSelector('input[name="Passwd"]', { visible: true, timeout: 20000 });
    await sleep(800);
    await pg.click('input[name="Passwd"]', { clickCount: 3 });
    await pg.type('input[name="Passwd"]', WIN.creds.password, { delay: 60 });
    await shot(pg, '04_google_password');
    await pg.click('#passwordNext');
    console.log('  → Contraseña enviada...');

    // Posible pantalla "Continuar"
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
  } else {
    console.log('  → Sesión Google activa — WIN cargó directamente, saltando OAuth');
    await shot(pg, '03_google_session_activa');
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
// Refresca la página primero para verificar si la sesión sigue activa
async function checkSesionWIN(pg) {
  console.log('🔄 Refrescando página para verificar sesión WIN...');
  try {
    await pg.reload({ waitUntil: 'domcontentloaded', timeout: 20000 });
  } catch(_) {
    console.warn('  ⚠ Reload tardó demasiado, continuando...');
  }
  await sleep(1500);
  const url = pg.url();
  const enLogin = url.includes('/login') || url.includes('accounts.google.com');
  if (enLogin) {
    console.log('⚠ Sesión WIN expirada tras refresco. Re-ingresando...');
    loggedIn = false;
    await doLogin(pg);
    return true;
  }
  console.log('  ✓ Sesión WIN activa tras refresco. Continuando...');
  return false;
}

// ─────────────────────────────────────────
// FLUJO COMPLETO DE VALIDACIÓN
// ─────────────────────────────────────────
async function ejecutarValidacion(datos) {
  resetProgreso();
  // Registrar quién está corriendo esta validación
  progreso.operadorActivo      = datos.operador      || '';
  progreso.operadorNombreActivo = datos.operadorNombre || datos.operador || '';
  cancelarFlag = false; // resetear al inicio de cada validación
  const pg = await getPage();

  // Helper para verificar cancelación en cualquier punto del flujo
  function checkCancelar() {
    if (cancelarFlag) {
      cancelarFlag = false;
      throw new Error('CANCELADO: La validación fue cancelada por el operador');
    }
  }

  // Login inicial o re-login si la sesión expiró
  checkCancelar();
  if (!loggedIn) {
    await doLogin(pg);
  } else {
    await checkSesionWIN(pg);
  }

  // ── PASO 1: Clic en menú "Ventas" ──────────────────────────────
  checkCancelar();
  setProgreso(2, 'Navegando al menú Ventas...', '📋');
  console.log('📌 Paso 1: Navegando a Ventas...');
  await checkSesionWIN(pg);

  try {
    await pg.waitForFunction(() => {
      const items = document.querySelectorAll('[data-kt-menu-trigger="click"]');
      return [...items].some(el => el.querySelector('.menu-title')?.textContent.trim() === 'Ventas');
    }, { timeout: 15000 });

    // Clic nativo de Puppeteer sobre el .menu-link de Ventas
    const ventasHandle = await pg.evaluateHandle(() => {
      const items = document.querySelectorAll('[data-kt-menu-trigger="click"]');
      const ventas = [...items].find(el => el.querySelector('.menu-title')?.textContent.trim() === 'Ventas');
      return ventas?.querySelector('.menu-link') || null;
    });
    if (!ventasHandle || !(await ventasHandle.asElement())) throw new Error('No se encontró .menu-link del menú Ventas');
    await ventasHandle.click();

    await sleep(2500); // esperar que el submenú se despliegue con animación
    await shot(pg, '04_menu_ventas');
  } catch(e) {
    throw new Error('No se encontró el menú Ventas: ' + e.message);
  }

  // ── PASO 2: Clic en submenú "Nuevo Lead" (navega a la página) ──
  setProgreso(3, 'Abriendo página Nuevo Lead...', '📝');
  console.log('📌 Paso 2: Clic en submenú Nuevo Lead...');
  // visible:true asegura que el elemento esté visible (no solo en el DOM oculto)
  await pg.waitForSelector(WIN.sel.btn_nuevo_lead, { visible: true, timeout: 10000 });
  await sleep(500);
  await pg.click(WIN.sel.btn_nuevo_lead);
  await sleep(3000); // esperar que la página de leads cargue completamente
  await shot(pg, '05_pagina_nuevo_lead');

  // ── PASO 3: Clic en botón "Añadir nuevo Lead" (abre el modal) ──
  checkCancelar();
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
    await sleep(3000); // esperar que aparezcan sugerencias
    await seleccionarSugerencia(pg, WIN.sel.input_distrito, datos.distrito || '');
    await sleep(2000);

    // Urbanización (opcional)
    if (datos.hhuu) {
      await limpiarYEscribir(pg, WIN.sel.input_hhuu, datos.hhuu);
      await sleep(2500);
      await seleccionarSugerencia(pg, WIN.sel.input_hhuu, datos.hhuu);
      await sleep(1500);
    }

    // Nombre de calle
    await limpiarYEscribir(pg, WIN.sel.input_via, datos.via || '');
    await sleep(2500);
    await seleccionarSugerencia(pg, WIN.sel.input_via, datos.via || '');
    await sleep(1500);

    // Número (sin autocomplete, solo escribir)
    await limpiarYEscribir(pg, WIN.sel.input_numero, datos.numero || '');
    await sleep(800);

    // Campos opcionales
    if (datos.cruce)   { await limpiarYEscribir(pg, WIN.sel.input_cruce,   datos.cruce);   await sleep(800); }
    if (datos.manzana) { await limpiarYEscribir(pg, WIN.sel.input_manzana, datos.manzana); await sleep(800); }
    if (datos.lote)    { await limpiarYEscribir(pg, WIN.sel.input_lote,    datos.lote);    await sleep(800); }
    if (datos.km)      { await limpiarYEscribir(pg, WIN.sel.input_km,      datos.km);      await sleep(800); }

    await shot(pg, '06_calle_filled');
  }

  // ── PASO 5: Clic en Buscar ─────────────────────────────────────
  checkCancelar();
  setProgreso(6, 'Buscando ubicación en mapa...', '🗺️');
  console.log('📌 Paso 5: Buscando en mapa...');
  const selBuscar = datos.tipo === 'coords' ? WIN.sel.btn_buscar_coord : WIN.sel.btn_buscar;
  await pg.waitForSelector(selBuscar, { timeout: 8000 });
  await sleep(500);
  await pg.click(selBuscar);
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
  checkCancelar();
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
    // El span dentro del alert de cobertura tiene texto único:
    // Tiene cobertura → "si está dentro de la cobertura"
    // Sin cobertura   → "no está dentro de la cobertura"
    await pg.waitForFunction(() =>
      [...document.querySelectorAll('span')].some(s =>
        s.textContent.includes('dentro de la cobertura')
      ), { timeout: 12000 }
    );
    await sleep(300);

    // Ambos spans están en el DOM — buscar el que esté realmente visible (con dimensiones)
    const cobText = await pg.evaluate(() => {
      const spans = [...document.querySelectorAll('span')]
        .filter(s => s.textContent.includes('dentro de la cobertura'));
      for (const sp of spans) {
        const r = sp.getBoundingClientRect();
        if (r.width > 0 && r.height > 0) {
          return sp.textContent.includes('no está') ? 'Sin Cobertura' : 'Tiene Cobertura';
        }
      }
      return null;
    });

    tieneCobertura = cobText === 'Tiene Cobertura';
    console.log('  📍 Cobertura:', cobText, '→ tieneCobertura:', tieneCobertura);
  } catch(_) {
    console.warn('  ⚠ No se encontró span de cobertura (asumiendo sin cobertura)');
  }
  await shot(pg, '12_cobertura_leida');

  // Siempre continúa a consultar el score del DNI, sin importar la cobertura

  // ── PASO 9: Seleccionar tipo de documento (DNI o RUC) ────────
  const tipoDoc = (datos.tipoDoc || 'DNI').toUpperCase();
  setProgreso(10, `Seleccionando tipo de documento ${tipoDoc}...`, '🪪');
  console.log(`📌 Paso 9: Seleccionando tipo ${tipoDoc}...`);

  // Clic en el combobox de tipo_doc para abrir el dropdown
  await pg.waitForSelector('span[aria-controls="select2-tipo_doc-container"]', { timeout: 10000 });
  await sleep(500);
  await pg.click('span[aria-controls="select2-tipo_doc-container"]');
  await sleep(1500);

  // Esperar que aparezcan las opciones en el DOM
  await pg.waitForSelector('#select2-tipo_doc-results .select2-results__option', { visible: true, timeout: 10000 });
  await sleep(400);
  await shot(pg, '13a_dropdown_abierto');

  const opcionesDNI = await pg.$$eval(
    '#select2-tipo_doc-results .select2-results__option',
    els => els.map(e => e.textContent.trim())
  );
  console.log('  📋 Opciones disponibles:', opcionesDNI);

  // Seleccionar la opción según tipoDoc (DNI o RUC)
  const optionHandles = await pg.$$('#select2-tipo_doc-results .select2-results__option');
  let docClicked = false;
  for (const handle of optionHandles) {
    const texto = await handle.evaluate(el => el.textContent.trim());
    if (texto === tipoDoc) {
      await handle.click();
      docClicked = true;
      console.log(`  ✓ ${tipoDoc} seleccionado`);
      break;
    }
  }
  if (!docClicked) throw new Error(`Opción ${tipoDoc} no encontrada en lista. Opciones: ` + opcionesDNI.join(', '));

  await sleep(1000);
  await shot(pg, '13_tipo_doc_dni');

  // ── PASO 10: Ingresar número de documento ─────────────────────
  setProgreso(10, `Ingresando ${tipoDoc} ${datos.dni}...`, '🔢');
  console.log(`📌 Paso 10: Ingresando ${tipoDoc}:`, datos.dni);
  if (!datos.dni) throw new Error(`${tipoDoc} no proporcionado para búsqueda de score`);
  await limpiarYEscribir(pg, WIN.sel.input_dni, datos.dni);
  await sleep(800);
  await shot(pg, '14_dni_ingresado');

  // ── PASO 11: Clic en buscar score ─────────────────────────────
  checkCancelar();
  setProgreso(11, 'Consultando score crediticio...', '📊');
  console.log('📌 Paso 11: Buscando score del cliente...');
  await pg.waitForSelector(WIN.sel.btn_buscar_score, { timeout: 5000 });
  await sleep(300);
  await pg.click(WIN.sel.btn_buscar_score);
  await sleep(1500);
  await shot(pg, '15_score_buscando');

  // ── PASO 12: Cerrar SweetAlert si aparece y leer score ────────
  setProgreso(12, 'Esperando resultado del score...', '⏳');
  console.log('⏳ Esperando resultado del score...');

  // Cerrar el SweetAlert ("Bien... Adelante") si aparece
  try {
    await pg.waitForSelector('.swal2-confirm', { visible: true, timeout: 8000 });
    await sleep(500);
    await pg.click('.swal2-confirm');
    console.log('  ✓ SweetAlert cerrado');
    await sleep(800);
  } catch(_) {
    console.log('  → Sin SweetAlert, continuando...');
  }

  // Esperar que #estamos_verificando tenga el score (ej: "Score: 401 - 500")
  try {
    await pg.waitForFunction(() => {
      const el = document.getElementById('estamos_verificando');
      return el && el.textContent.trim() !== '' && el.textContent.includes('Score');
    }, { timeout: 20000 });
    await sleep(500);
  } catch(_) {
    await shot(pg, '16_score_timeout');
    throw new Error('Tiempo de espera agotado al obtener el score del cliente');
  }

  const scoreDetalle = await pg.$eval('#estamos_verificando', el => el.textContent.trim()).catch(() => '');
  const scoreTitulo  = await pg.$eval('#espere_por_favor',    el => el.textContent.trim()).catch(() => '');
  await shot(pg, '16_score_resultado');
  console.log(`  📊 Score texto: "${scoreDetalle}" | Título: "${scoreTitulo}"`);

  // Extraer el número MENOR del rango (ej: "Score: 201 - 500" → 201)
  // Se usa el mínimo: si algún extremo del rango está bajo 301, no califica
  const numeros = scoreDetalle.match(/\d+/g);
  const scoreNum = numeros ? Math.min(...numeros.map(Number)) : null;
  const aprobado = tieneCobertura && scoreNum !== null && scoreNum >= 301;

  console.log(`  📊 Score: ${scoreNum} | Aprobado (≥301): ${aprobado}`);

  // ── Guardar en Firestore desde el servidor ──────────────────────
  const resultado = aprobado ? 'aprobado' : 'rechazado';
  try {
    await guardarEnFirestore({
      dni:              datos.dni       || '',
      direccion:        datos.tipo === 'calle'
        ? `${datos.via||''} ${datos.numero||''}${datos.hhuu?' - '+datos.hhuu:''}, ${datos.distrito||''}`
        : (datos.direccion || ''),
      tipo:             datos.tipo      || 'calle',
      distrito:         datos.distrito  || '',
      hhuu:             datos.hhuu      || '',
      via:              datos.via       || '',
      numero:           datos.numero    || '',
      resultado,
      detalleResultado: scoreDetalle    || '',
      scoreNum:         scoreNum        !== null ? scoreNum : -1,
      aprobado,
      tieneCobertura,
      operador:         datos.operador       || '',
      operadorNombre:   datos.operadorNombre || '',
      fechaISO:         new Date().toISOString(),
    });
  } catch(fsErr) {
    console.error(`  ❌ Firestore NO guardó: ${fsErr.message}`);
  }

  // ── Volver atrás para dejar la plataforma lista para la siguiente consulta ──
  console.log('  ← Volviendo atrás para nueva consulta...');
  await pg.goBack({ waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
  await sleep(1500);

  return {
    ok:             true,
    resultado,
    detalle:        scoreDetalle || scoreTitulo || 'Score obtenido',
    scoreTitulo,
    scoreDetalle,
    scoreNum,
    aprobado,
    tieneCobertura,
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

// Helper: elegir la sugerencia más parecida al texto ingresado
async function seleccionarSugerencia(pg, inputSel, texto) {
  if (!texto) return;
  const textNorm = texto.trim().toLowerCase();

  try {
    // Esperar hasta 3s a que aparezca al menos un item de sugerencia visible
    let intentos = 0;
    let items = [];
    while (intentos < 6) {
      items = await pg.evaluate((inputSel) => {
        const input = document.querySelector(inputSel);
        if (!input) return [];

        // GeoFinder mete las sugerencias en un <ul> hermano o en un contenedor cercano
        const root = input.closest('td, .form-group, .input-group, div') || document.body;
        const candidates = [
          ...document.querySelectorAll('ul.ui-autocomplete li.ui-menu-item'),
          ...document.querySelectorAll('.autocomplete-items div, .autocomplete-list li'),
          ...document.querySelectorAll('[class*="suggest"] li, [class*="suggest"] div'),
          ...document.querySelectorAll('[class*="autocomplete"] li, [class*="autocomplete"] div'),
          ...document.querySelectorAll('.tt-suggestion, .dropdown-item'),
          ...root.querySelectorAll('li, [role="option"]'),
        ];

        return candidates
          .filter(el => el.offsetParent !== null && (el.textContent || '').trim().length > 0)
          .map(el => ({
            text: (el.textContent || '').trim(),
            tag:  el.tagName,
            cls:  el.className,
          }));
      }, inputSel);

      if (items.length > 0) break;
      await sleep(500);
      intentos++;
    }

    if (items.length === 0) {
      console.log(`  ⚠ No aparecieron sugerencias para "${inputSel}" — usando ArrowDown+Enter`);
      await pg.focus(inputSel);
      await pg.keyboard.press('ArrowDown');
      await sleep(400);
      await pg.keyboard.press('Enter');
      await sleep(400);
      return;
    }

    // Buscar la sugerencia con mejor coincidencia con el texto ingresado
    let mejorIdx  = 0;
    let mejorScore = -1;
    items.forEach((item, i) => {
      const t = item.text.toLowerCase();
      let score = 0;
      if (t === textNorm)                     score = 100; // exacta
      else if (t.startsWith(textNorm))        score = 80;
      else if (t.includes(textNorm))          score = 60;
      else if (textNorm.includes(t))          score = 40;
      else {
        // contar palabras en común
        const wordsA = textNorm.split(/\s+/);
        const wordsB = t.split(/\s+/);
        score = wordsA.filter(w => wordsB.some(b => b.includes(w) || w.includes(b))).length;
      }
      if (score > mejorScore) { mejorScore = score; mejorIdx = i; }
    });

    console.log(`  → Sugerencias para "${texto}": ${items.map(i=>i.text).join(' | ')}`);
    console.log(`  ✓ Eligiendo: "${items[mejorIdx].text}" (score ${mejorScore})`);

    // Navegar con teclado hasta la posición correcta y presionar Enter
    await pg.focus(inputSel);
    await sleep(200);
    for (let i = 0; i <= mejorIdx; i++) {
      await pg.keyboard.press('ArrowDown');
      await sleep(150);
    }
    await pg.keyboard.press('Enter');
    await sleep(500);

  } catch (err) {
    console.log(`  ⚠ seleccionarSugerencia error en "${inputSel}": ${err.message}`);
    // Fallback: ArrowDown + Enter
    try {
      await pg.focus(inputSel);
      await pg.keyboard.press('ArrowDown');
      await sleep(350);
      await pg.keyboard.press('Enter');
      await sleep(400);
    } catch (_) {}
  }
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

// Progreso actual + captura en vivo del navegador
app.get('/progreso', async (_req, res) => {
  // Tomar captura solo si hay automatización activa y han pasado ≥2s desde la última
  if (progreso.activo && page && !page.isClosed() && (Date.now() - liveShotTs) > 2000) {
    try {
      liveShot = await page.screenshot({ encoding: 'base64', type: 'jpeg', quality: 55 });
      liveShotTs = Date.now();
    } catch(_) {}
  }
  res.json({ ...progreso, screenshot: progreso.activo ? liveShot : null, colaOcupada, colaEsperando });
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

// ── Cola de validaciones (una a la vez) ──────────────────────────
let colaOcupada   = false;
let colaEsperando = 0;    // cuántos trabajadores están esperando turno

async function ejecutarConCola(datos) {
  // Si hay una validación en curso, esperar hasta que termine (máx 5 min)
  const MAX_ESPERA = 300_000;
  const INTERVALO  = 2_000;
  let esperado = 0;
  while (colaOcupada) {
    if (esperado >= MAX_ESPERA) throw new Error('Tiempo de espera agotado — intenta de nuevo');
    await sleep(INTERVALO);
    esperado += INTERVALO;
  }
  colaOcupada = true;
  try {
    return await ejecutarValidacion(datos);
  } catch(err) {
    console.log('⚠ Validación falló — limpiando estado...');
    try {
      if (page && !page.isClosed()) {
        const esErrorSesion = err.message.toLowerCase().includes('login') ||
                              err.message.toLowerCase().includes('sesi') ||
                              err.message.toLowerCase().includes('google');
        if (esErrorSesion) {
          // Solo si es error de sesión, forzar re-login
          loggedIn = false;
          console.log('  → Error de sesión detectado, se hará re-login');
        } else {
          // Para cualquier otro error, volver a la página principal de WIN (sesión intacta)
          await page.goto('https://appwinforce.win.pe/consultarpedidos', {
            waitUntil: 'domcontentloaded', timeout: 8000
          }).catch(() => {});
          console.log('  → Browser redirigido a página principal WIN');
        }
      }
    } catch(_) {}
    resetProgreso();
    throw err; // re-lanzar para que el endpoint maneje el error
  } finally {
    colaOcupada = false;
    colaEsperando = Math.max(0, colaEsperando - 1);
  }
}

// Validar cobertura
app.post('/validar', async (req, res) => {
  const { dni, tipo, tipoDoc, direccion, distrito, hhuu, via, numero, cruce, manzana, lote, km, operador, operadorNombre } = req.body;

  if (!tipo) return res.status(400).json({ ok: false, error: 'Falta campo: tipo' });
  if (tipo === 'coords' && !direccion) return res.status(400).json({ ok: false, error: 'Falta coordenadas' });
  if (tipo === 'calle' && (!distrito || !via || !numero)) return res.status(400).json({ ok: false, error: 'Faltan campos: distrito, via, numero' });
  if (!WIN.creds.usuario) return res.status(500).json({ ok: false, error: 'Credenciales WIN no configuradas' });

  // Informar cuántos están esperando
  if (colaOcupada) colaEsperando++;
  const posicion = colaEsperando;

  console.log(`\n${'═'.repeat(50)}`);
  console.log(`▶ Validando — DNI: ${dni} | Tipo: ${tipo} | Operador: ${operadorNombre||operador}`);
  if (tipo === 'calle') console.log(`  ${distrito} / ${hhuu||'-'} / ${via} ${numero}`);
  else console.log(`  Coords: ${direccion}`);
  if (posicion > 0) console.log(`  ⏳ En cola — posición #${posicion}`);
  console.log(`${'═'.repeat(50)}`);

  const datos = { dni, tipo, tipoDoc, direccion, distrito, hhuu, via, numero, cruce, manzana, lote, km, operador, operadorNombre };

  try {
    const resultado = await ejecutarConCola(datos);
    console.log('✓ Resultado:', resultado.resultado);
    res.json({ ...resultado, dni, tipo });
  } catch(e) {
    console.error('✗ Error:', e.message);
    if (e.message.toLowerCase().includes('login') || e.message.toLowerCase().includes('sesi')) {
      console.log('🔄 Reintentando tras re-login...');
      loggedIn = false;
      try {
        const resultado = await ejecutarConCola(datos);
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

// Cancelar validación en curso
let cancelarFlag = false;
app.post('/cancelar', (req, res) => {
  if (!colaOcupada) return res.json({ ok: false, msg: 'No hay validación en curso' });
  const { operador } = req.body || {};
  // Solo el operador que inició la validación puede cancelarla
  if (operador && progreso.operadorActivo && operador !== progreso.operadorActivo) {
    return res.json({ ok: false, msg: 'No puedes cancelar la validación de otro trabajador' });
  }
  cancelarFlag = true;
  console.log(`⚠ Cancelación solicitada por: ${operador || 'desconocido'}`);
  res.json({ ok: true, msg: 'Cancelación en proceso...' });
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
