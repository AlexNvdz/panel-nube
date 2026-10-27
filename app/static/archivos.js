const MAX = 10 * 1024 * 1024;
const URL_VIGENCIA_MS = 4 * 60 * 1000; // las URLs prefirmadas duran 5 min

// Tipos permitidos (iguales a la Lambda) y su grupo visual
const TIPOS = {
  "image/jpeg": "imagen", "image/png": "imagen", "image/gif": "imagen", "image/webp": "imagen",
  "application/pdf": "pdf", "video/mp4": "video",
  "application/msword": "doc",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "doc",
  "application/vnd.ms-excel": "hoja",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "hoja",
  "application/vnd.ms-powerpoint": "pres",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": "pres",
};
const POR_EXTENSION = {
  jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", gif: "image/gif", webp: "image/webp",
  pdf: "application/pdf", mp4: "video/mp4",
  doc: "application/msword", docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel", xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ppt: "application/vnd.ms-powerpoint", pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};
const NOMBRE_GRUPO = { imagen: "Imagen", pdf: "PDF", video: "Video", doc: "Word", hoja: "Excel", pres: "PowerPoint", otro: "Archivo" };

const extension = (n) => (n.split(".").pop() || "").toLowerCase();
const grupoDe = (nombre) => TIPOS[POR_EXTENSION[extension(nombre)]] || "otro";
const nombreVisible = (n) => n.replace(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}-/, "");

function chipTipo(grupo) {
  const s = el("span", { className: `tipo t-${grupo}` });
  s.append(icono(grupo));
  return s;
}

const relativo = new Intl.RelativeTimeFormat("es", { numeric: "auto" });
function haceCuanto(fecha) {
  const s = Math.min(0, (new Date(fecha) - Date.now()) / 1000); // relojes desfasados nunca dan "dentro de"
  const pasos = [[60, "second"], [3600, "minute"], [86400, "hour"], [604800, "day"], [2629800, "week"], [31557600, "month"], [Infinity, "year"]];
  const div = { second: 1, minute: 60, hour: 3600, day: 86400, week: 604800, month: 2629800, year: 31557600 };
  for (const [lim, u] of pasos) if (Math.abs(s) < lim) return relativo.format(Math.round(s / div[u]), u);
}

// =========================================================
// LISTA DE ARCHIVOS
// =========================================================
const lista = document.getElementById("lista");
const filtro = document.getElementById("filtro");
let archivos = [];
let cargadoEn = 0;

async function cargar({ silencioso = false, resaltar = null } = {}) {
  if (!silencioso) lista.replaceChildren(...Array.from({ length: 4 }, () => el("li", { className: "esqueleto" })));
  try {
    ({ archivos } = await pedir("/api/archivos"));
    cargadoEn = Date.now();
    archivos.sort((a, b) => b.fecha.localeCompare(a.fecha));
    pintar(resaltar);
  } catch (e) {
    lista.replaceChildren(el("li", { className: "vacio", textContent: `No se pudo cargar la lista. ${e.message}` }));
  }
}

function pintar(resaltar = null) {
  const total = archivos.reduce((s, a) => s + a.tamano, 0);
  document.getElementById("n-archivos").textContent = archivos.length;
  document.getElementById("peso").textContent = formatoBytes(total);

  const q = filtro.value.trim().toLowerCase();
  const visibles = archivos.filter((a) => nombreVisible(a.nombre).toLowerCase().includes(q));
  if (!archivos.length) {
    lista.replaceChildren(el("li", { className: "vacio", textContent: "El bucket está vacío. Arrastra un archivo al portal para subir el primero." }));
    return;
  }
  if (!visibles.length) {
    lista.replaceChildren(el("li", { className: "vacio", textContent: `Ningún archivo coincide con "${filtro.value}".` }));
    return;
  }
  lista.replaceChildren(...visibles.map((a) => fila(a, a.key === resaltar)));
}

function fila(a, nuevo) {
  const nombre = nombreVisible(a.nombre);
  const grupo = grupoDe(nombre);
  const tipo = chipTipo(grupo);
  if (grupo === "imagen") {
    const img = el("img", { src: a.url, alt: "", loading: "lazy" });
    img.onerror = () => tipo.replaceChildren(icono("imagen"));
    tipo.replaceChildren(img);
  }

  const acciones = el("div", { className: "acciones" });
  const li = el("li", { className: "fila-archivo" + (nuevo ? " nuevo" : "") },
    tipo,
    el("div", { className: "info" },
      el("div", { className: "nombre", textContent: nombre, title: a.key }),
      el("div", { className: "meta" },
        el("span", { textContent: NOMBRE_GRUPO[grupo] }),
        el("span", { textContent: formatoBytes(a.tamano) }),
        el("span", { textContent: haceCuanto(a.fecha), title: new Date(a.fecha).toLocaleString("es") }))),
    acciones);

  function botones() {
    acciones.replaceChildren();
    if (["imagen", "video", "pdf"].includes(grupo)) {
      acciones.append(boton("ojo", `Ver ${nombre}`, () => ver(a.key, nombre, grupo)));
    }
    acciones.append(
      boton("abrir", `Abrir ${nombre} en otra pestaña`, () => abrir(a.key)),
      boton("papelera", `Eliminar ${nombre}`, confirmar, "peligro"));
  }

  function confirmar() {
    const si = el("button", { className: "btn-peligro", textContent: "Eliminar" });
    const no = el("button", { className: "btn-fantasma", textContent: "Cancelar" });
    no.style.padding = ".5rem .85rem";
    acciones.replaceChildren(el("div", { className: "confirmar" }, el("span", { textContent: "¿Eliminar?" }), si, no));
    const volver = setTimeout(botones, 5000);
    no.onclick = () => { clearTimeout(volver); botones(); };
    si.onclick = async () => {
      clearTimeout(volver);
      si.disabled = no.disabled = true;
      try {
        await pedir("/api/eliminar", {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ key: a.key }),
        });
        li.classList.add("saliendo");
        setTimeout(() => {
          archivos = archivos.filter((x) => x.key !== a.key);
          pintar();
        }, 300);
        aviso(`${nombre} eliminado`);
      } catch (e) {
        aviso(`No se pudo eliminar. ${e.message}`, true);
        botones();
      }
    };
    si.focus();
  }

  botones();
  return li;
}

function boton(ico, etiqueta, accion, extra = "") {
  const b = el("button", { className: `btn-icono ${extra}`, title: etiqueta, type: "button" });
  b.setAttribute("aria-label", etiqueta);
  b.append(icono(ico));
  b.onclick = accion;
  return b;
}

async function urlFresca(key) {
  if (Date.now() - cargadoEn > URL_VIGENCIA_MS) await cargar({ silencioso: true });
  const a = archivos.find((x) => x.key === key);
  if (!a) throw new Error("El archivo ya no existe en el bucket.");
  return a.url;
}

async function abrir(key) {
  const pestana = window.open("", "_blank");
  try {
    pestana.location = await urlFresca(key);
  } catch (e) {
    pestana.close();
    aviso(e.message, true);
  }
}

// visor
const visor = document.getElementById("visor");
async function ver(key, nombre, grupo) {
  let url;
  try { url = await urlFresca(key); } catch (e) { return aviso(e.message, true); }
  document.getElementById("visor-nombre").textContent = nombre;
  document.getElementById("visor-abrir").href = url;
  const cuerpo = document.getElementById("visor-cuerpo");
  const medio = grupo === "imagen" ? el("img", { src: url, alt: nombre })
    : grupo === "video" ? el("video", { src: url, controls: true, autoplay: true })
    : el("iframe", { src: url, title: nombre });
  cuerpo.replaceChildren(medio);
  visor.showModal();
}
document.getElementById("visor-cerrar").onclick = () => visor.close();
visor.addEventListener("click", (e) => { if (e.target === visor) visor.close(); });
visor.addEventListener("close", () => document.getElementById("visor-cuerpo").replaceChildren());

filtro.addEventListener("input", () => pintar());
document.getElementById("btn-recargar").onclick = () => cargar();

// =========================================================
// PORTAL DE SUBIDA
// =========================================================
const portal = document.getElementById("portal");
const input = document.getElementById("archivo");
const progreso = document.getElementById("progreso");
const satelite = document.getElementById("satelite");
const pct = document.getElementById("portal-pct");
const titulo = document.getElementById("portal-titulo");
const detalle = document.getElementById("portal-detalle");
const colaUl = document.getElementById("cola");

const REPOSO = { titulo: "Suelta tus archivos aquí", detalle: "o haz clic para elegirlos" };
let cola = [];
let trabajando = false;
let reposoTimer;

function estadoPortal(estado, t = REPOSO.titulo, d = REPOSO.detalle) {
  clearTimeout(reposoTimer);
  portal.dataset.estado = estado;
  titulo.textContent = t;
  detalle.textContent = d;
}

function avancePortal(p) {
  progreso.style.strokeDashoffset = 100 - p;
  satelite.style.transform = `rotate(${p * 3.6}deg)`;
  pct.textContent = `${Math.floor(p)}%`;
}

function volverAReposo(ms) {
  reposoTimer = setTimeout(() => {
    estadoPortal("reposo");
    avancePortal(0);
    satelite.style.transform = "";
  }, ms);
}

// arrastrar y soltar
let profundidad = 0;
portal.addEventListener("dragenter", (e) => {
  e.preventDefault();
  if (++profundidad === 1 && !trabajando) estadoPortal("arrastre", "Suéltalos para subir", "Se suben uno por uno");
});
portal.addEventListener("dragover", (e) => e.preventDefault());
portal.addEventListener("dragleave", () => {
  if (--profundidad === 0 && portal.dataset.estado === "arrastre") estadoPortal("reposo");
});
portal.addEventListener("drop", (e) => {
  e.preventDefault();
  profundidad = 0;
  if (portal.dataset.estado === "arrastre") estadoPortal("reposo");
  encolar(e.dataTransfer.files);
});
portal.addEventListener("click", (e) => { if (e.target !== input) { e.preventDefault(); input.click(); } });
portal.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); input.click(); } });
input.addEventListener("change", () => { encolar(input.files); input.value = ""; });
// evita que el navegador abra el archivo si se suelta fuera del portal
addEventListener("dragover", (e) => e.preventDefault());
addEventListener("drop", (e) => e.preventDefault());

function encolar(files) {
  if (!files || !files.length) return;
  colaUl.querySelector(".vacio")?.remove();
  for (const f of files) {
    const tipo = TIPOS[f.type] ? f.type : POR_EXTENSION[extension(f.name)];
    const item = {
      f, tipo,
      li: el("li", { className: "item-cola" }),
      estado: el("span", { className: "estado", textContent: "En espera" }),
      barra: el("i"),
    };
    item.li.append(
      chipTipo(TIPOS[tipo] || "otro"),
      el("span", { className: "nombre", textContent: f.name, title: f.name }),
      item.estado,
      el("div", { className: "barra-carga" }, item.barra));
    colaUl.prepend(item.li);

    if (!tipo) marcarError(item, "Tipo no permitido");
    else if (f.size === 0) marcarError(item, "Archivo vacío");
    else if (f.size > MAX) marcarError(item, `Pesa ${formatoBytes(f.size)}, máximo 10 MB`);
    else cola.push(item);
  }
  procesar();
}

function marcarError(item, msg) {
  item.li.className = "item-cola error";
  item.estado.textContent = msg;
}

async function procesar() {
  if (trabajando) return;
  trabajando = true;
  while (cola.length) {
    const item = cola.shift();
    const restantes = cola.length;
    const res = await subir(item, restantes);
    if (res.ok) {
      item.li.className = "item-cola listo";
      item.barra.style.width = "100%";
      item.estado.textContent = "Subido";
      await cargar({ silencioso: true, resaltar: res.key });
    } else {
      marcarError(item, res.error);
      estadoPortal("error", "No se pudo subir", res.error);
      avancePortal(100);
      await new Promise((r) => setTimeout(r, 1800));
    }
  }
  trabajando = false;
  if (portal.dataset.estado !== "error") {
    estadoPortal("listo", "Listo", "Todo quedó guardado en el bucket");
    avancePortal(100);
  }
  volverAReposo(2200);
}

async function subir(item, restantes) {
  const { f } = item;
  const enCola = restantes ? `, ${restantes} en cola` : "";
  item.li.className = "item-cola guardando";
  item.estado.textContent = "Pidiendo permiso a la API";
  estadoPortal("guardando", f.name, `Pidiendo URL prefirmada a la API${enCola}`);
  pct.textContent = "0%";

  // 1) La Lambda (detrás del autorizador JWT) entrega un POST prefirmado con límite de tamaño
  let info;
  try {
    info = await pedir("/api/subir", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ filename: f.name, contentType: item.tipo, size: f.size }),
    });
  } catch (e) {
    return { ok: false, error: e.message };
  }

  // 2) El navegador sube directo a S3; el bucket sigue privado
  return new Promise((resolve) => {
    const datos = new FormData();
    Object.entries(info.fields).forEach(([k, v]) => datos.append(k, v));
    datos.append("file", f); // S3 exige que el archivo vaya al final

    const xhr = new XMLHttpRequest();
    const inicio = performance.now();
    item.li.className = "item-cola subiendo";
    item.estado.textContent = "Subiendo 0%";
    estadoPortal("subiendo", f.name, `Subiendo a S3${enCola}`);
    avancePortal(0);

    xhr.upload.onprogress = (e) => {
      if (!e.lengthComputable) return;
      const p = Math.min(99, (e.loaded / e.total) * 100);
      const seg = (performance.now() - inicio) / 1000;
      const vel = e.loaded / Math.max(seg, .05);
      const falta = Math.max(0, (e.total - e.loaded) / vel);
      item.barra.style.width = `${p}%`;
      item.estado.textContent = `Subiendo ${Math.floor(p)}%`;
      avancePortal(p);
      detalle.textContent = `${formatoBytes(e.loaded)} de ${formatoBytes(e.total)}, ${falta < 1 ? "casi listo" : `quedan ${Math.ceil(falta)} s`}${enCola}`;
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) return resolve({ ok: true, key: info.key });
      const codigo = (xhr.responseText.match(/<Code>([^<]+)<\/Code>/) || [])[1];
      resolve({ ok: false, error: codigo === "EntityTooLarge" ? "S3 rechazó el archivo: supera 10 MB" : `S3 rechazó la subida (${codigo || xhr.status})` });
    };
    xhr.onerror = () => resolve({ ok: false, error: "No se pudo conectar con S3 (revisa el CORS del bucket)" });
    xhr.ontimeout = () => resolve({ ok: false, error: "S3 tardó demasiado" });
    xhr.timeout = 120000;
    xhr.open("POST", info.url);
    xhr.send(datos);
  });
}

cargar();
// mantiene las fechas relativas al día
setInterval(() => { if (!trabajando && !lista.querySelector(".confirmar")) pintar(); }, 60000);
