/* ══════════════════════════════════════════════════════════════
   L-TEL Validador — Shared JavaScript Module
   Firebase config, auth, password hashing, UI utilities.
   Se carga en TODAS las páginas (incluido login.html).
   ══════════════════════════════════════════════════════════════ */

// ── Firebase Config (fuente única de verdad) ─────────────────
const firebaseConfig = {
  apiKey: "AIzaSyDre3Wdt__AKKP2NGiv-I5ksqscoVPDsho",
  authDomain: "softkes-ssi.firebaseapp.com",
  projectId: "softkes-ssi",
  storageBucket: "softkes-ssi.firebasestorage.app",
  messagingSenderId: "949401432052",
  appId: "1:949401432052:web:131984f96192cf9ff493a1"
};
if (!firebase.apps.length) firebase.initializeApp(firebaseConfig);
const db = firebase.firestore();

// ── Auth / Session ───────────────────────────────────────────
const AUTH_KEY = 'validadorUser';
const SESSION_HOURS = 12; // la sesión expira a las 12 horas

function getSession() {
  // Intentar localStorage primero, luego sessionStorage (migración)
  let raw = localStorage.getItem(AUTH_KEY);
  if (!raw) {
    raw = sessionStorage.getItem(AUTH_KEY);
    if (raw) {
      // Migrar de sessionStorage a localStorage
      localStorage.setItem(AUTH_KEY, raw);
      sessionStorage.removeItem(AUTH_KEY);
    }
  }
  if (!raw) return null;
  try {
    const data = JSON.parse(raw);
    if (data._exp && Date.now() > data._exp) {
      localStorage.removeItem(AUTH_KEY);
      return null;
    }
    return data;
  } catch { return null; }
}

function saveSession(userData) {
  userData._exp = Date.now() + SESSION_HOURS * 60 * 60 * 1000;
  localStorage.setItem(AUTH_KEY, JSON.stringify(userData));
}

function requireAuth(requiredRole) {
  const session = getSession();
  if (!session) { window.location.href = 'login.html'; return null; }
  if (requiredRole && session.rol !== requiredRole) {
    alert('Acceso restringido. Solo ' + requiredRole + 's.');
    window.location.href = 'dashboard.html';
    return null;
  }
  return session;
}

function logout() {
  localStorage.removeItem(AUTH_KEY);
  sessionStorage.removeItem(AUTH_KEY);
  window.location.href = 'login.html';
}

// ── Password Hashing (SHA-256 + salt) ────────────────────────
function generateSalt() {
  const arr = new Uint8Array(16);
  crypto.getRandomValues(arr);
  return Array.from(arr, b => b.toString(16).padStart(2, '0')).join('');
}

async function hashPassword(password, salt) {
  const encoder = new TextEncoder();
  const data = encoder.encode(salt + ':' + password);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(hashBuffer), b => b.toString(16).padStart(2, '0')).join('');
}

async function verifyPassword(inputPassword, storedHash, storedSalt) {
  const inputHash = await hashPassword(inputPassword, storedSalt);
  return inputHash === storedHash;
}

// ── UI Utilities ─────────────────────────────────────────────
function escHtml(s) {
  return String(s || '').replace(/[<>&"']/g, c => ({
    '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

// Toast notification
function showToast(msg, duration) {
  duration = duration || 2200;
  let toast = document.getElementById('shared-toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'shared-toast';
    toast.className = 'toast';
    document.body.appendChild(toast);
  }
  toast.textContent = msg;
  toast.classList.add('show');
  clearTimeout(toast._tid);
  toast._tid = setTimeout(function() { toast.classList.remove('show'); }, duration);
}

// Copy to clipboard with toast
function copyToClipboard(text) {
  if (!text || text === '—') return;
  navigator.clipboard.writeText(text).then(function() {
    showToast('Copiado: ' + (text.length > 40 ? text.slice(0, 40) + '…' : text));
  }).catch(function() {
    showToast('Error al copiar');
  });
}

// Make detail items clickable for copy
function enableDetailCopy() {
  document.addEventListener('click', function(e) {
    var item = e.target.closest('.detail-item');
    if (item) {
      var val = item.querySelector('.detail-val');
      if (val) copyToClipboard(val.textContent.trim());
    }
  });
}

// ── Mobile Sidebar ───────────────────────────────────────────
function openSidebar() {
  var sb = document.getElementById('sidebar');
  var ov = document.getElementById('sidebar-overlay');
  if (sb) sb.classList.add('open');
  if (ov) ov.classList.add('open');
}
function closeSidebar() {
  var sb = document.getElementById('sidebar');
  var ov = document.getElementById('sidebar-overlay');
  if (sb) sb.classList.remove('open');
  if (ov) ov.classList.remove('open');
}

// ── Init user info in sidebar ────────────────────────────────
function initSidebarUser(session) {
  var nameEl   = document.getElementById('user-name');
  var roleEl   = document.getElementById('user-role');
  var avatarEl = document.getElementById('user-avatar');
  var adminLink = document.getElementById('link-admin');

  if (nameEl)   nameEl.textContent  = session.nombre || session.usuario;
  if (roleEl)   roleEl.textContent  = session.rol === 'admin' ? 'Administrador' : 'Operador';
  if (avatarEl) avatarEl.textContent = (session.nombre || session.usuario).charAt(0).toUpperCase();
  if (adminLink && session.rol === 'admin') adminLink.style.display = 'flex';
}

// ── Badge maps (reutilizable) ────────────────────────────────
var BADGE_MAP = {
  aprobado:      '<span class="badge badge-success"><i class="fas fa-check-circle"></i> Aprobado</span>',
  rechazado:     '<span class="badge badge-error"><i class="fas fa-user-times"></i> Score bajo</span>',
  sin_cobertura: '<span class="badge badge-error"><i class="fas fa-times"></i> Sin cobertura</span>',
  con_cobertura: '<span class="badge badge-success"><i class="fas fa-wifi"></i> Con cobertura</span>',
  pendiente:     '<span class="badge badge-pending"><i class="fas fa-clock"></i> Pendiente</span>',
};
var BADGE_MAP_LG = {
  aprobado:      '<span class="badge badge-success" style="font-size:.82rem;padding:.3rem .9rem"><i class="fas fa-check-circle"></i> Aprobado</span>',
  rechazado:     '<span class="badge badge-error" style="font-size:.82rem;padding:.3rem .9rem"><i class="fas fa-user-times"></i> Score bajo</span>',
  sin_cobertura: '<span class="badge badge-error" style="font-size:.82rem;padding:.3rem .9rem"><i class="fas fa-times-circle"></i> Sin cobertura</span>',
  pendiente:     '<span class="badge badge-pending" style="font-size:.82rem;padding:.3rem .9rem"><i class="fas fa-clock"></i> Pendiente</span>',
};

// ── Theme Toggle (dark/light) ───────────────────────────────
var THEME_KEY = 'validadorTheme';

function getTheme() {
  return localStorage.getItem(THEME_KEY) || 'dark';
}

function setTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  localStorage.setItem(THEME_KEY, theme);
  // Actualizar todos los iconos de toggle
  var icons = document.querySelectorAll('.theme-toggle i');
  for (var i = 0; i < icons.length; i++) {
    icons[i].className = theme === 'dark' ? 'fas fa-sun' : 'fas fa-moon';
  }
}

function toggleTheme() {
  setTheme(getTheme() === 'dark' ? 'light' : 'dark');
}

// Aplicar tema guardado inmediatamente (antes de DOMContentLoaded para evitar flash)
(function() {
  var saved = localStorage.getItem(THEME_KEY);
  if (saved) document.documentElement.setAttribute('data-theme', saved);
})();

// ── Skeleton Loading ────────────────────────────────────────
function skeletonRows(cols, rows) {
  rows = rows || 5;
  var widths = ['w-60','w-70','w-50','w-80','w-40','w-30','w-60','w-70'];
  var html = '';
  for (var r = 0; r < rows; r++) {
    html += '<tr class="skeleton-row">';
    for (var c = 0; c < cols; c++) {
      var w = widths[(r + c) % widths.length];
      // Una columna al azar usa badge skeleton
      if (c === cols - 2 && cols > 3) {
        html += '<td><div class="skeleton-bar w-badge"></div></td>';
      } else {
        html += '<td><div class="skeleton-bar ' + w + '"></div></td>';
      }
    }
    html += '</tr>';
  }
  return html;
}

// ── Favicon Dinámico con Notificación ───────────────────────
var _faviconOriginal = null;
var _faviconCanvas = null;

function setFaviconBadge(count) {
  var link = document.querySelector('link[rel="icon"]');
  if (!link) return;

  // Guardar favicon original la primera vez
  if (!_faviconOriginal) {
    _faviconOriginal = link.href;
  }

  if (!count || count <= 0) {
    // Restaurar favicon original
    link.href = _faviconOriginal;
    document.title = document.title.replace(/^\(\d+\)\s*/, '');
    return;
  }

  // Crear canvas para dibujar badge sobre el favicon
  if (!_faviconCanvas) {
    _faviconCanvas = document.createElement('canvas');
    _faviconCanvas.width = 32;
    _faviconCanvas.height = 32;
  }
  var canvas = _faviconCanvas;
  var ctx = canvas.getContext('2d');

  var img = new Image();
  img.crossOrigin = 'anonymous';
  img.onload = function() {
    ctx.clearRect(0, 0, 32, 32);
    ctx.drawImage(img, 0, 0, 32, 32);

    // Dibujar circulo rojo con número
    ctx.beginPath();
    ctx.arc(24, 8, 9, 0, 2 * Math.PI);
    ctx.fillStyle = '#ef4444';
    ctx.fill();
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 1.5;
    ctx.stroke();

    ctx.fillStyle = '#fff';
    ctx.font = 'bold 11px Arial';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(count > 9 ? '9+' : String(count), 24, 8.5);

    link.href = canvas.toDataURL('image/png');
  };
  img.onerror = function() {};
  img.src = _faviconOriginal;

  // Actualizar título del tab
  var cleanTitle = document.title.replace(/^\(\d+\)\s*/, '');
  document.title = '(' + count + ') ' + cleanTitle;
}

// ── Init on DOMContentLoaded ─────────────────────────────────
document.addEventListener('DOMContentLoaded', function() {
  enableDetailCopy();
  // Aplicar tema y actualizar iconos
  setTheme(getTheme());
});
