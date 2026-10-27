// Utilidades compartidas por los paneles

// =========================================================
// Sesión con Amazon Cognito (Authorization Code + PKCE)
// =========================================================
const auth = new oidc.UserManager({
  authority: PANEL.authority,
  client_id: PANEL.clientId,
  redirect_uri: `${location.origin}/`,
  response_type: "code",
  scope: "openid email profile",
  userStore: new oidc.WebStorageStateStore({ store: sessionStorage }),
});

function entrar(volver = location.pathname) {
  return auth.signinRedirect({ state: volver });
}

// Devuelve el usuario con un token vigente o manda a iniciar sesión
async function sesion() {
  let u = await auth.getUser();
  if (u && u.expired && u.refresh_token) {
    try { u = await auth.signinSilent(); } catch (_) { u = null; }
  }
  if (u && !u.expired) return u;
  await entrar();
  throw new Error("Redirigiendo al inicio de sesión…");
}

async function cerrarSesion() {
  await auth.removeUser();
  // Cognito no publica end_session_endpoint: se usa su URL de logout
  location.href = `${PANEL.cognitoDomain}/logout?client_id=${PANEL.clientId}&logout_uri=${encodeURIComponent(`${location.origin}/`)}`;
}

// Llama a API Gateway con el token de acceso
async function apiFetch(ruta, opciones = {}) {
  const u = await sesion();
  const r = await fetch(PANEL.apiUrl + ruta, {
    ...opciones,
    headers: { ...(opciones.headers || {}), Authorization: `Bearer ${u.access_token}` },
  });
  if (r.status === 401) {
    await auth.removeUser();
    await entrar();
    throw new Error("Tu sesión expiró. Volviendo a iniciar sesión…");
  }
  return r;
}

async function pedir(ruta, opciones = {}) {
  const r = await apiFetch(ruta, opciones);
  let data = {};
  try { data = await r.json(); } catch (_) { /* respuesta sin JSON */ }
  if (!r.ok) throw new Error(data.error || `La solicitud falló (error ${r.status})`);
  return data;
}

let toastTimer;
function aviso(texto, error = false) {
  const t = document.getElementById("toast");
  t.textContent = texto;
  t.className = "toast" + (error ? " error" : "");
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 4200);
}

function el(tag, props = {}, ...hijos) {
  const e = document.createElement(tag);
  Object.assign(e, props);
  hijos.forEach((h) => h != null && e.append(h));
  return e;
}

function formatoBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

// Iconos SVG (cadenas constantes, nunca datos del usuario)
const ICONOS = {
  imagen: '<rect x="3.5" y="4.5" width="17" height="15" rx="2"/><circle cx="9" cy="10" r="1.8"/><path d="M20.5 16l-5-5-8.5 8.5"/>',
  pdf: '<path d="M14 3.5H7a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8.5z"/><path d="M14 3.5v5h5"/><path d="M8.5 15.5h7"/>',
  doc: '<path d="M14 3.5H7a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8.5z"/><path d="M14 3.5v5h5"/><path d="M8.5 12.5h7M8.5 16h5"/>',
  video: '<rect x="3" y="5.5" width="13" height="13" rx="2"/><path d="M16 10l5-3v10l-5-3"/>',
  hoja: '<rect x="4" y="4" width="16" height="16" rx="2"/><path d="M4 9.5h16M4 14.5h16M10 4v16"/>',
  pres: '<rect x="3" y="4" width="18" height="12" rx="1.5"/><path d="M12 16v4M8 20h8"/>',
  otro: '<path d="M14 3.5H7a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8.5z"/><path d="M14 3.5v5h5"/>',
  ojo: '<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="3"/>',
  abrir: '<path d="M14 4h6v6"/><path d="M20 4l-9 9"/><path d="M18 14v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4"/>',
  papelera: '<path d="M4 7h16"/><path d="M9 7V4.5h6V7"/><path d="M6 7l1 12.5a1.5 1.5 0 0 0 1.5 1.5h7a1.5 1.5 0 0 0 1.5-1.5L18 7"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  subir: '<path d="M12 16V4"/><path d="M7 9l5-5 5 5"/><path d="M5 20h14"/>',
};
function icono(nombre) {
  const s = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  s.setAttribute("viewBox", "0 0 24 24");
  s.setAttribute("aria-hidden", "true");
  s.innerHTML = ICONOS[nombre] || ICONOS.otro;
  return s;
}

// =========================================================
// Cielo nocturno: nubes de aurora que derivan despacio
// =========================================================
(function cielo() {
  const c = document.getElementById("cielo");
  if (!c || !c.getContext) return;
  const ctx = c.getContext("2d");
  const reducir = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const ESCALA = 0.5;
  const nubes = [
    { x: .12, y: .18, r: .55, c: "94,234,212", a: .17, f: 0 },
    { x: .82, y: .12, r: .62, c: "167,139,250", a: .24, f: 1.7 },
    { x: .65, y: .9, r: .7, c: "255,122,154", a: .11, f: 3.1 },
    { x: .28, y: .78, r: .5, c: "122,162,255", a: .13, f: 4.4 },
    { x: .5, y: .45, r: .38, c: "167,139,250", a: .08, f: 5.2 },
  ];
  let w, h, estrellas = [];

  function medir() {
    w = c.width = Math.ceil(innerWidth * ESCALA);
    h = c.height = Math.ceil(innerHeight * ESCALA);
    estrellas = Array.from({ length: Math.round((w * h) / 2600) }, () => ({
      x: Math.random() * w, y: Math.random() * h,
      r: Math.random() * .7 + .2, f: Math.random() * 6.28, v: Math.random() * .8 + .4,
    }));
  }

  function dibujar(t) {
    ctx.globalCompositeOperation = "source-over";
    ctx.fillStyle = "#120E2A";
    ctx.fillRect(0, 0, w, h);
    ctx.globalCompositeOperation = "lighter";
    const m = Math.max(w, h);
    for (const n of nubes) {
      const x = (n.x + Math.sin(t * .00004 + n.f) * .09) * w;
      const y = (n.y + Math.cos(t * .00003 + n.f) * .07) * h;
      const r = n.r * m * (1 + Math.sin(t * .00005 + n.f) * .06);
      const g = ctx.createRadialGradient(x, y, 0, x, y, r);
      g.addColorStop(0, `rgba(${n.c},${n.a})`);
      g.addColorStop(.5, `rgba(${n.c},${n.a * .35})`);
      g.addColorStop(1, `rgba(${n.c},0)`);
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, w, h);
    }
    ctx.globalCompositeOperation = "source-over";
    for (const s of estrellas) {
      const a = reducir ? .45 : .25 + .45 * (.5 + .5 * Math.sin(t * .0012 * s.v + s.f));
      ctx.fillStyle = `rgba(241,238,255,${a})`;
      ctx.beginPath();
      ctx.arc(s.x, s.y, s.r, 0, 6.283);
      ctx.fill();
    }
  }

  let ultimo = 0;
  function bucle(t) {
    if (t - ultimo > 33) { dibujar(t); ultimo = t; }
    if (!document.hidden) requestAnimationFrame(bucle);
  }

  medir();
  addEventListener("resize", () => { medir(); dibujar(performance.now()); });
  if (reducir) {
    dibujar(0);
  } else {
    requestAnimationFrame(bucle);
    document.addEventListener("visibilitychange", () => { if (!document.hidden) requestAnimationFrame(bucle); });
  }
})();

// Riel de las páginas internas: exige sesión y muestra quién entró
if (document.getElementById("btn-salir")) {
  document.getElementById("btn-salir").onclick = cerrarSesion;
  sesion().then((u) => {
    const correo = u.profile.email || u.profile["cognito:username"] || "Usuario";
    document.getElementById("quien").textContent = correo;
    document.getElementById("avatar").textContent = correo[0].toUpperCase();
  }).catch(() => {});
}
