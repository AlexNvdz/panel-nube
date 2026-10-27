const $ = (id) => document.getElementById(id);
let tablas = [];        // esquema de todas las tablas
let actual = null;      // tabla seleccionada
let items = [];         // filas recibidas
let siguiente = null;   // { url, params } para "Cargar más"
let cols = [];
let orden = { col: null, dir: 1 };
let resaltar = null;    // ID a destacar tras guardar

const tipoTexto = (t) => (t === "N" ? "número" : "texto");
const esFecha = (campo) => /fecha|actualizacion/i.test(campo);
const singular = (t) => (/(res|les)$/.test(t) ? t.slice(0, -2) : t.endsWith("s") ? t.slice(0, -1) : t);
const capital = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const numero = new Intl.NumberFormat("es-CO", { maximumFractionDigits: 2 });
const tablaPorPk = () => Object.fromEntries(tablas.map((t) => [t.llaves.pk.nombre, t]));
const urlTabla = (t) => `/api/dynamo/tablas/${encodeURIComponent(t)}`;

// =========================================================
// TABLAS (esquema)
// =========================================================
async function cargarEsquema(seleccionarNombre) {
  try {
    ({ tablas } = await pedir("/api/dynamo/esquema"));
  } catch (e) {
    $("tablas").replaceChildren(el("li", { className: "vacio", textContent: `No se pudieron cargar las tablas. ${e.message}` }));
    return;
  }
  if (!tablas.length) {
    $("tablas").replaceChildren(el("li", { className: "vacio", textContent: "La cuenta no tiene tablas en esta región." }));
    return;
  }
  $("tablas").replaceChildren(...tablas.map((t) => {
    const extra = [];
    if (t.indices.length) extra.push(`${t.indices.length} índice${t.indices.length > 1 ? "s" : ""}`);
    if (t.escritura) extra.push("acepta registros");
    const b = el("button", { type: "button" },
      el("span", { className: "t-nombre", textContent: t.nombre }),
      el("span", { className: "t-cuenta", textContent: t.conteoExacto ? t.conteo : `${t.conteo}+` }),
      el("span", { className: "t-llave", textContent: [`Llave ${t.llaves.pk.nombre}`, ...extra].join(", ") }));
    b.setAttribute("aria-pressed", String(actual?.nombre === t.nombre));
    b.dataset.tabla = t.nombre;
    b.onclick = () => seleccionar(t.nombre);
    return el("li", {}, b);
  }));
  seleccionar(seleccionarNombre || actual?.nombre || tablas[0].nombre, { mantenerVista: !!seleccionarNombre });
}

function seleccionar(nombre, { mantenerVista = false } = {}) {
  const t = tablas.find((x) => x.nombre === nombre);
  if (!t) return;
  const cambio = actual?.nombre !== nombre;
  actual = t;
  document.querySelectorAll(".tablas-lista button").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.tabla === nombre)));
  $("vacio").hidden = true;
  $("panel").hidden = false;
  $("titulo").textContent = t.nombre;

  const { pk, sk } = t.llaves;
  const hechos = [el("li", { className: "llave" }, "Llave ", el("b", { textContent: pk.nombre }), ` (${tipoTexto(pk.tipo)})`)];
  if (sk) hechos.push(el("li", { className: "llave" }, "Orden ", el("b", { textContent: sk.nombre }), ` (${tipoTexto(sk.tipo)})`));
  hechos.push(el("li", {}, el("b", { textContent: t.conteoExacto ? t.conteo : `${t.conteo}+` }), " elementos"));
  hechos.push(el("li", {}, el("b", { textContent: formatoBytes(t.tamano) })));
  t.indices.forEach((i) => hechos.push(el("li", { className: "indice" }, "Índice ", el("b", { textContent: i.nombre }))));
  if (t.escritura) hechos.push(el("li", { className: "escritura" }, "Acepta registros nuevos"));
  $("hechos").replaceChildren(...hechos);

  // buscar por ID
  $("pk-etiqueta").textContent = `${pk.nombre} (${tipoTexto(pk.tipo)})`;
  $("sk-campo").hidden = !sk;
  $("sk").required = !!sk;
  if (sk) $("sk-etiqueta").textContent = `${sk.nombre} (${tipoTexto(sk.tipo)})`;

  // índice
  $("tab-indice").hidden = !t.indices.length;
  $("indice").replaceChildren(...t.indices.map((i) => el("option", { value: i.nombre, textContent: i.nombre })));
  actualizarIndice();

  // nuevo registro
  $("tab-nuevo").hidden = !t.escritura;
  if (t.escritura) {
    $("tab-nuevo").textContent = `Nuevo ${t.escritura.singular}`;
    construirFormularioNuevo(t);
  }

  if (cambio) {
    $("pk").value = $("sk").value = $("filtro").value = "";
    $("filtros").replaceChildren();
    orden = { col: null, dir: 1 };
  }
  construirAtajos();
  actualizarLimpiar();
  if (!mantenerVista || cambio) pestana("filtrar");
  ejecutarFiltros();
}

function actualizarIndice() {
  const i = actual && actual.indices.find((x) => x.nombre === $("indice").value);
  if (!i) return;
  $("ipk-etiqueta").textContent = `${i.llaves.pk.nombre} (${tipoTexto(i.llaves.pk.tipo)})`;
  $("isk-campo").hidden = !i.llaves.sk;
  if (i.llaves.sk) {
    $("isk-etiqueta").textContent = i.llaves.sk.tipo === "N"
      ? `${i.llaves.sk.nombre}, igual a (opcional)`
      : `${i.llaves.sk.nombre}, empieza con (opcional)`;
  }
}

// =========================================================
// PESTAÑAS
// =========================================================
const PESTANAS = { filtrar: ["tab-filtrar", "form-filtrar"], llave: ["tab-llave", "form-item"], indice: ["tab-indice", "form-indice"], nuevo: ["tab-nuevo", "form-nuevo"] };
function pestana(nombre) {
  for (const [k, [tab, form]] of Object.entries(PESTANAS)) {
    $(tab).setAttribute("aria-selected", String(k === nombre));
    $(tab).tabIndex = k === nombre ? 0 : -1;
    $(form).hidden = k !== nombre;
  }
}
for (const [k, [tab, form]] of Object.entries(PESTANAS)) {
  $(tab).onclick = () => {
    pestana(k);
    $(form).querySelector("input:not([type=hidden]), select")?.focus();
  };
}
document.querySelector(".pestanas").addEventListener("keydown", (e) => {
  if (!["ArrowLeft", "ArrowRight"].includes(e.key)) return;
  const tabs = [...document.querySelectorAll(".pestanas [role=tab]:not([hidden])")];
  const i = tabs.indexOf(document.activeElement);
  const sig = tabs[(i + (e.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length];
  sig.click();
  sig.focus();
});

// =========================================================
// FILTROS
// =========================================================
const OPS = {
  eq: "es igual a", ne: "es distinto de", contains: "contiene", begins_with: "empieza con",
  gt: "mayor que", ge: "mayor o igual a", lt: "menor que", le: "menor o igual a",
  between: "entre", exists: "tiene valor", not_exists: "no tiene valor",
};
const OPS_FECHA = { gt: "después de", lt: "antes de", between: "entre fechas" };
function operadoresPara(campo) {
  if (campo.tipo === "N") return ["eq", "ne", "gt", "ge", "lt", "le", "between", "exists", "not_exists"];
  if (esFecha(campo.nombre)) return ["eq", "gt", "lt", "between", "exists", "not_exists"];
  return ["eq", "ne", "contains", "begins_with", "between", "exists", "not_exists"];
}
const camposFiltrables = () => actual.campos.filter((c) => c.tipo === "S" || c.tipo === "N");

function agregarFiltro(inicial = {}) {
  const campos = camposFiltrables();
  if (!campos.length) return;
  const fila = el("div", { className: "filtro" });
  const selCampo = el("select");
  selCampo.setAttribute("aria-label", "Campo");
  campos.forEach((c) => selCampo.append(el("option", { value: c.nombre, textContent: c.nombre })));
  const selOp = el("select");
  selOp.setAttribute("aria-label", "Condición");
  const valor = el("span", { className: "filtro-valor" });
  const quitar = el("button", { type: "button", className: "btn-icono", title: "Quitar filtro" });
  quitar.setAttribute("aria-label", "Quitar filtro");
  quitar.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>';
  quitar.onclick = () => { fila.remove(); actualizarLimpiar(); construirAtajos(); };

  function campoActual() { return campos.find((c) => c.nombre === selCampo.value); }

  function entrada(c, v, etiqueta) {
    let inp;
    if (c.valores && !["contains", "begins_with"].includes(selOp.value)) {
      inp = el("select");
      inp.append(el("option", { value: "", textContent: "Elige…" }));
      c.valores.forEach(([val, n]) => inp.append(el("option", { value: val, textContent: `${val} (${n})` })));
    } else if (esFecha(c.nombre) && c.tipo === "S") {
      inp = el("input", { type: "date" });
    } else if (c.tipo === "N") {
      inp = el("input", { type: "number", step: "any", inputMode: "decimal", placeholder: c.min != null ? `${c.min} a ${c.max}` : "Número" });
    } else {
      inp = el("input", { type: "text", placeholder: "Valor" });
    }
    inp.setAttribute("aria-label", etiqueta);
    if (v != null) inp.value = v;
    return inp;
  }

  function pintarValor(v1, v2) {
    const c = campoActual();
    const op = selOp.value;
    valor.replaceChildren();
    if (op === "exists" || op === "not_exists") return;
    valor.append(entrada(c, v1, `Valor de ${c.nombre}`));
    if (op === "between") valor.append(el("span", { className: "y", textContent: "y" }), entrada(c, v2, `Segundo valor de ${c.nombre}`));
  }

  function pintarOps(opInicial) {
    const c = campoActual();
    const ops = operadoresPara(c);
    selOp.replaceChildren(...ops.map((o) => el("option", { value: o, textContent: (esFecha(c.nombre) && OPS_FECHA[o]) || OPS[o] })));
    selOp.value = ops.includes(opInicial) ? opInicial : ops[0];
  }

  selCampo.onchange = () => { pintarOps(); pintarValor(); };
  selOp.onchange = () => {
    const vals = [...valor.querySelectorAll("input, select")].map((i) => i.value);
    pintarValor(vals[0], vals[1]);
  };

  selCampo.value = inicial.campo && campos.some((c) => c.nombre === inicial.campo) ? inicial.campo : campos.find((c) => !c.llave)?.nombre || campos[0].nombre;
  pintarOps(inicial.op);
  pintarValor(inicial.valor, inicial.valor2);

  fila.append(selCampo, selOp, valor, quitar);
  fila.leer = () => {
    const c = campoActual();
    const [v1, v2] = [...valor.querySelectorAll("input, select")].map((i) => i.value.trim());
    return { campo: c.nombre, op: selOp.value, tipo: c.tipo, valor: v1, valor2: v2 };
  };
  $("filtros").append(fila);
  actualizarLimpiar();
  return fila;
}

function leerFiltros() {
  const filtros = [...$("filtros").children].map((f) => f.leer());
  const incompleto = filtros.find((f) => !["exists", "not_exists"].includes(f.op) && (!f.valor || (f.op === "between" && !f.valor2)));
  if (incompleto) throw new Error(`Completa el valor del filtro sobre ${incompleto.campo}`);
  return filtros;
}

function actualizarLimpiar() {
  $("btn-limpiar").hidden = !$("filtros").children.length;
}

// Atajos: un clic filtra por un valor frecuente (categoría, ciudad...)
function construirAtajos() {
  const activos = new Map([...$("filtros").children].map((f) => f.leer()).filter((f) => f.op === "eq").map((f) => [f.campo, f.valor]));
  const grupos = actual.campos.filter((c) => c.valores && c.valores.length > 1 && !/Id$/.test(c.nombre) && !esFecha(c.nombre));
  $("atajos").replaceChildren(...grupos.map((c) => el("div", { className: "atajo-grupo" },
    el("span", { className: "atajo-campo", textContent: c.nombre }),
    ...c.valores.map(([v, n]) => {
      const b = el("button", { type: "button", className: "chip" }, v, el("span", { textContent: n }));
      b.setAttribute("aria-pressed", String(activos.get(c.nombre) === v));
      b.onclick = () => alternarAtajo(c.nombre, v);
      return b;
    }))));
}

function alternarAtajo(campo, valor) {
  const filas = [...$("filtros").children];
  const existente = filas.find((f) => f.leer().campo === campo && f.leer().op === "eq");
  const yaActivo = existente && existente.leer().valor === valor;
  filas.filter((f) => f.leer().campo === campo).forEach((f) => f.remove());
  if (!yaActivo) agregarFiltro({ campo, op: "eq", valor });
  actualizarLimpiar();
  construirAtajos();
  ejecutarFiltros();
}

function ejecutarFiltros() {
  let filtros;
  try { filtros = leerFiltros(); } catch (e) { return aviso(e.message, true); }
  const params = { limit: $("form-filtrar").limit.value };
  if (filtros.length) params.filtros = JSON.stringify(filtros);
  ejecutar(urlTabla(actual.nombre), params);
}

$("btn-agregar-filtro").onclick = () => agregarFiltro().querySelector("select")?.focus();
$("btn-limpiar").onclick = () => { $("filtros").replaceChildren(); actualizarLimpiar(); construirAtajos(); ejecutarFiltros(); };
$("form-filtrar").onsubmit = (ev) => { ev.preventDefault(); construirAtajos(); ejecutarFiltros(); };

// =========================================================
// CONSULTAS
// =========================================================
async function ejecutar(url, params, agregar = false) {
  const qs = new URLSearchParams(Object.entries(params).filter(([, v]) => v !== "" && v != null));
  $("btn-mas").disabled = true;
  if (!agregar) {
    esqueleto();
    $("conteo").textContent = "Consultando…";
  }
  try {
    const data = await pedir(`${url}?${qs}`);
    items = agregar ? items.concat(data.items) : data.items;
    siguiente = data.next ? { url, params: { ...params, next: data.next } } : null;
    pintar(data.leidos);
  } catch (e) {
    if (!agregar) {
      items = [];
      siguiente = null;
      $("cabecera").replaceChildren();
      $("filas").replaceChildren(el("tr", { className: "sin-filas" }, el("td", { textContent: e.message })));
      $("conteo").textContent = "";
    }
    aviso(e.message, true);
  } finally {
    $("btn-mas").disabled = false;
  }
}

function esqueleto() {
  const n = Math.max(cols.length, 4);
  $("filas").replaceChildren(...Array.from({ length: 6 }, () =>
    el("tr", { className: "esq" }, ...Array.from({ length: n }, () => el("td", {}, el("span"))))));
}

function textoValor(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

function comparar(a, b) {
  if (a == null) return 1;
  if (b == null) return -1;
  if (typeof a === "number" && typeof b === "number") return a - b;
  return String(a).localeCompare(String(b), "es", { numeric: true });
}

function pintar(leidos) {
  const llaves = [actual.llaves.pk, actual.llaves.sk].filter(Boolean).map((l) => l.nombre);
  const resto = new Set();
  items.forEach((it) => Object.keys(it).forEach((k) => llaves.includes(k) || resto.add(k)));
  cols = llaves.concat([...resto].sort());
  const fk = tablaPorPk();

  $("cabecera").replaceChildren(el("tr", {}, ...cols.map((c) => {
    const th = el("th", { scope: "col", className: llaves.includes(c) ? "llave" : "" });
    const b = el("button", { type: "button", className: "orden", textContent: c });
    b.append(el("span", { className: "flecha", textContent: orden.col === c ? (orden.dir > 0 ? "↑" : "↓") : "" }));
    b.onclick = () => {
      orden = orden.col === c ? { col: c, dir: -orden.dir } : { col: c, dir: 1 };
      pintar(leidos);
    };
    th.setAttribute("aria-sort", orden.col === c ? (orden.dir > 0 ? "ascending" : "descending") : "none");
    th.append(b);
    return th;
  })));

  const q = $("filtro").value.trim().toLowerCase();
  let visibles = q ? items.filter((it) => JSON.stringify(it).toLowerCase().includes(q)) : items.slice();
  if (orden.col) visibles.sort((a, b) => comparar(a[orden.col], b[orden.col]) * orden.dir);

  if (!visibles.length) {
    const msg = items.length ? `Ninguna fila contiene "${$("filtro").value}".` : "Ningún elemento cumple la consulta. Ajusta o quita filtros.";
    $("filas").replaceChildren(el("tr", { className: "sin-filas" }, el("td", { colSpan: Math.max(cols.length, 1), textContent: msg })));
  } else {
    const pk = actual.llaves.pk.nombre;
    $("filas").replaceChildren(...visibles.map((it) => {
      const tr = el("tr", { tabIndex: 0, className: resaltar && it[pk] === resaltar ? "nuevo" : "" }, ...cols.map((c) => {
        const v = it[c];
        const t = textoValor(v);
        if (t === null) return el("td", { className: "nulo", textContent: "—" });
        const clase = llaves.includes(c) ? "llave" : fk[c] && fk[c].nombre !== actual.nombre ? "ref" : typeof v === "number" ? "num" : typeof v === "object" ? "obj" : "";
        return el("td", { className: clase, textContent: typeof v === "number" ? numero.format(v) : t, title: t.length > 30 ? t : "" });
      }));
      tr.onclick = () => abrirDetalle(actual.nombre, it, true);
      tr.onkeydown = (e) => { if (e.key === "Enter") abrirDetalle(actual.nombre, it, true); };
      return tr;
    }));
    resaltar = null;
  }
  const base = q ? `${visibles.length} de ${items.length} filas` : `${items.length} fila${items.length === 1 ? "" : "s"}`;
  const extra = [];
  if (leidos != null && leidos !== items.length) extra.push(`DynamoDB revisó ${leidos}`);
  if (siguiente) extra.push("hay más en la tabla");
  $("conteo").textContent = [base, ...extra].join(", ");
  $("btn-mas").hidden = !siguiente;
}

$("form-item").onsubmit = (ev) => {
  ev.preventDefault();
  ejecutar(`${urlTabla(actual.nombre)}/item`, { pk: $("pk").value.trim(), sk: $("sk").value.trim() });
};
$("form-indice").onsubmit = (ev) => {
  ev.preventDefault();
  ejecutar(`${urlTabla(actual.nombre)}/indice/${encodeURIComponent($("indice").value)}`, {
    pk: $("ipk").value.trim(),
    sk: $("isk-campo").hidden ? "" : $("isk").value.trim(),
    limit: 25,
  });
};
$("indice").onchange = actualizarIndice;
$("btn-mas").onclick = () => siguiente && ejecutar(siguiente.url, siguiente.params, true);
$("filtro").addEventListener("input", () => actual && pintar());

// =========================================================
// NUEVO REGISTRO
// =========================================================
function construirFormularioNuevo(t) {
  const esc = t.escritura;
  $("nuevo-id").textContent = esc.siguienteId;
  $("btn-guardar").textContent = `Guardar ${esc.singular}`;
  $("nuevo-error").hidden = true;
  $("nuevo-campos").replaceChildren(...esc.campos.map((c) => {
    const id = `nuevo-${c.nombre}`;
    const campoEsquema = t.campos.find((x) => x.nombre === c.nombre);
    const attrs = { id, name: c.nombre, required: !!c.requerido, autocomplete: "off" };
    let inp, lista = null;
    if (c.tipo === "N") {
      inp = el("input", { ...attrs, type: "number", step: "0.01", min: c.min ?? "", inputMode: "decimal", placeholder: "0" });
    } else {
      inp = el("input", { ...attrs, type: c.formato === "email" ? "email" : "text", maxLength: c.max || 200 });
      if (campoEsquema?.valores) {
        // sugiere los valores que ya existen (ciudades, categorías) sin impedir uno nuevo
        lista = el("datalist", { id: `${id}-opciones` });
        campoEsquema.valores.forEach(([v]) => lista.append(el("option", { value: v })));
        inp.setAttribute("list", lista.id);
        inp.placeholder = `Ej. ${campoEsquema.valores[0][0]}`;
      }
    }
    const error = el("span", { className: "error-campo", id: `${id}-error` });
    inp.setAttribute("aria-describedby", error.id);
    inp.addEventListener("input", () => { inp.removeAttribute("aria-invalid"); error.textContent = ""; });
    return el("label", { className: "campo" },
      el("span", { textContent: c.etiqueta + (c.requerido ? "" : " (opcional)") }), inp, lista, error);
  }));
}

function marcarErrores(errores = {}) {
  let primero = null;
  for (const [campo, msg] of Object.entries(errores)) {
    const inp = $(`nuevo-${campo}`);
    if (!inp) continue;
    inp.setAttribute("aria-invalid", "true");
    $(`${inp.id}-error`).textContent = msg;
    primero ||= inp;
  }
  primero?.focus();
  if (errores._) { $("nuevo-error").textContent = errores._; $("nuevo-error").hidden = false; }
}

$("form-nuevo").onsubmit = async (ev) => {
  ev.preventDefault();
  const form = ev.target;
  limpiarMensajes();
  const datos = Object.fromEntries([...form.querySelectorAll("input[name]")].map((i) => [i.name, i.value.trim()]));
  const faltan = Object.fromEntries(actual.escritura.campos.filter((c) => c.requerido && !datos[c.nombre]).map((c) => [c.nombre, "Este campo es obligatorio"]));
  if (Object.keys(faltan).length) return marcarErrores(faltan);

  const boton = $("btn-guardar");
  boton.disabled = true;
  boton.textContent = "Guardando…";
  try {
    const r = await apiFetch(`${urlTabla(actual.nombre)}/items`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(datos),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      marcarErrores(data.campos);
      if (!data.campos) { $("nuevo-error").textContent = data.error || `No se pudo guardar (error ${r.status})`; $("nuevo-error").hidden = false; }
      return;
    }
    const pk = actual.llaves.pk.nombre;
    aviso(data.mensaje || "Registro guardado");
    form.reset();
    resaltar = data.item[pk];
    await cargarEsquema(actual.nombre);
    pestana("nuevo");
    $("nuevo-campos").querySelector("input")?.focus();
  } catch (e) {
    $("nuevo-error").textContent = `No se pudo guardar. ${e.message}`;
    $("nuevo-error").hidden = false;
  } finally {
    boton.disabled = false;
    boton.textContent = `Guardar ${actual.escritura.singular}`;
  }
};
function limpiarMensajes() {
  $("nuevo-error").hidden = true;
  $("form-nuevo").querySelectorAll("[aria-invalid]").forEach((i) => i.removeAttribute("aria-invalid"));
  $("form-nuevo").querySelectorAll(".error-campo").forEach((s) => (s.textContent = ""));
}
$("form-nuevo").addEventListener("reset", limpiarMensajes);

// =========================================================
// DETALLE con relaciones entre tablas
// =========================================================
let pila = [];          // elementos abiertos, para "Volver"
let focoPrevio = null;

function resaltarJSON(obj) {
  const frag = document.createDocumentFragment();
  const json = JSON.stringify(obj, null, 2);
  const re = /("(?:\\.|[^"\\])*")(\s*:)?|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)|\b(true|false|null)\b/g;
  let i = 0, m;
  while ((m = re.exec(json))) {
    frag.append(json.slice(i, m.index));
    if (m[1]) {
      frag.append(el("span", { className: m[2] ? "k" : "s", textContent: m[1] }));
      if (m[2]) frag.append(m[2]);
    } else if (m[3]) frag.append(el("span", { className: "n", textContent: m[3] }));
    else frag.append(el("span", { className: "b", textContent: m[4] }));
    i = re.lastIndex;
  }
  frag.append(json.slice(i));
  return frag;
}

function abrirDetalle(tabla, item, nuevo = false) {
  if (nuevo) {
    pila = [];
    focoPrevio = document.activeElement;
  }
  pila.push({ tabla, item });
  mostrarDetalle();
  $("detalle").classList.add("abierto");
  $("detalle").setAttribute("aria-hidden", "false");
  $("velo").hidden = false;
  $("detalle-cerrar").focus();
}

function mostrarDetalle() {
  const { tabla, item } = pila[pila.length - 1];
  const t = tablas.find((x) => x.nombre === tabla);
  const pk = t.llaves.pk.nombre;
  $("detalle-titulo").textContent = `${capital(singular(tabla))} ${textoValor(item[pk]) ?? ""}`;
  $("detalle-volver").hidden = pila.length < 2;
  $("detalle-json").replaceChildren(resaltarJSON(item));
  $("detalle").querySelector(".detalle-cuerpo").scrollTop = 0;
  pintarRelaciones(t, item);
}

function pintarRelaciones(t, item) {
  const cont = $("relaciones");
  cont.replaceChildren();
  const pk = t.llaves.pk.nombre;
  const fk = tablaPorPk();

  // 1) Este elemento apunta a otros (venta → cliente, producto)
  const refs = Object.keys(item).filter((k) => k !== pk && fk[k] && fk[k].nombre !== t.nombre);
  if (refs.length) {
    const sec = el("section", { className: "rel" }, el("h3", { textContent: "Referencias" }));
    const lista = el("div", { className: "rel-refs" });
    refs.forEach((k) => {
      const destino = fk[k];
      const b = el("button", { type: "button", className: "rel-ref" },
        el("span", { className: "rel-tabla", textContent: capital(singular(destino.nombre)) }),
        el("strong", { textContent: item[k] }));
      b.onclick = () => abrirReferencia(destino.nombre, item[k], b);
      lista.append(b);
    });
    sec.append(lista);
    cont.append(sec);
  }

  // 2) Otros elementos apuntan a este (cliente → ventas)
  const valor = item[pk];
  tablas.filter((o) => o.nombre !== t.nombre && o.campos.some((c) => c.nombre === pk)).forEach((o) => {
    const sec = el("section", { className: "rel" });
    const titulo = el("h3", { textContent: capital(o.nombre) });
    const cuerpo = el("div", { className: "rel-lista" }, el("p", { className: "sub", textContent: "Consultando…" }));
    sec.append(titulo, cuerpo);
    cont.append(sec);
    cargarRelacion(o, pk, valor, titulo, cuerpo);
  });
}

async function cargarRelacion(o, campo, valor, titulo, cuerpo) {
  const indice = o.indices.find((i) => i.llaves.pk.nombre === campo);
  const tipo = o.campos.find((c) => c.nombre === campo)?.tipo || "S";
  const [url, params, como] = indice
    ? [`${urlTabla(o.nombre)}/indice/${encodeURIComponent(indice.nombre)}`, { pk: valor, limit: 50 }, `índice ${indice.nombre}`]
    : [urlTabla(o.nombre), { limit: 50, filtros: JSON.stringify([{ campo, op: "eq", valor, tipo }]) }, "filtro"];
  try {
    const data = await pedir(`${url}?${new URLSearchParams(params)}`);
    titulo.append(el("span", { className: "rel-n", textContent: data.items.length + (data.next ? "+" : "") }),
      el("span", { className: "rel-como", textContent: `por ${como}` }));
    if (!data.items.length) {
      cuerpo.replaceChildren(el("p", { className: "sub", textContent: `Sin ${o.nombre} relacionadas con ${valor}.` }));
      return;
    }
    const pkO = o.llaves.pk.nombre;
    const otros = o.campos.map((c) => c.nombre).filter((n) => n !== pkO && n !== campo).slice(0, 4);
    cuerpo.replaceChildren(...data.items.map((it) => {
      const b = el("button", { type: "button", className: "rel-fila" },
        el("strong", { textContent: it[pkO] }),
        el("span", { className: "rel-datos" }, ...otros.filter((n) => it[n] != null).map((n) =>
          el("span", {}, el("i", { textContent: n }), typeof it[n] === "number" ? numero.format(it[n]) : String(it[n])))));
      b.onclick = () => abrirDetalle(o.nombre, it);
      return b;
    }));
  } catch (e) {
    cuerpo.replaceChildren(el("p", { className: "sub", textContent: `No se pudo consultar. ${e.message}` }));
  }
}

async function abrirReferencia(tabla, valor, boton) {
  boton.disabled = true;
  try {
    const data = await pedir(`${urlTabla(tabla)}/item?${new URLSearchParams({ pk: valor })}`);
    if (!data.items.length) return aviso(`${capital(singular(tabla))} ${valor} no existe en la tabla ${tabla}.`, true);
    abrirDetalle(tabla, data.items[0]);
  } catch (e) {
    aviso(e.message, true);
  } finally {
    boton.disabled = false;
  }
}

function cerrarDetalle() {
  $("detalle").classList.remove("abierto");
  $("detalle").setAttribute("aria-hidden", "true");
  $("velo").hidden = true;
  pila = [];
  focoPrevio?.focus();
}

$("detalle-volver").onclick = () => { if (pila.length > 1) { pila.pop(); mostrarDetalle(); } };
$("detalle-cerrar").onclick = cerrarDetalle;
$("velo").onclick = cerrarDetalle;
addEventListener("keydown", (e) => { if (e.key === "Escape" && $("detalle").classList.contains("abierto")) cerrarDetalle(); });
$("detalle-copiar").onclick = async () => {
  try {
    await navigator.clipboard.writeText(JSON.stringify(pila[pila.length - 1].item, null, 2));
    aviso("JSON copiado al portapapeles");
  } catch (_) {
    aviso("El navegador no permitió copiar. Selecciona el texto y cópialo a mano.", true);
  }
};

cargarEsquema();
