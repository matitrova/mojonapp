// ---------------------------------------------------------------------------
// CRM: contactos + pipeline visual (nuevo → contactado → visita → oferta →
// cerrado/perdido). Un contacto puede tener uno o más lotes de interés
// asociados y un historial de actividades (colección Firestore "contactos",
// ver firestore.rules).
//
// "Agregar interesado" en la ficha de un lote (js/ficha.js, colección
// "lotes", array "interesados") sigue existiendo tal cual y NO depende de
// este módulo para seguir funcionando — pero además de guardarse ahí,
// crearContactoDesdeInteresado() (llamada desde ficha.js) alimenta este
// pipeline central, fire-and-forget, para que cargar un interesado desde
// la ficha sea la MISMA acción que darlo de alta acá, sin que nadie tenga
// que cargarlo dos veces.
//
// `mapa`, `mostrarFicha` y `tituloLote` los recibe este módulo por
// parámetro (configurarCrm), igual que dashboard.js — viven en
// mapa.js/ficha.js, y ficha.js importa crearContactoDesdeInteresado() de
// acá: inyectar por parámetro en vez de `import` evita la dependencia
// circular entre los dos módulos. `permisos.js` sí se importa directo:
// no depende de crm.js, así que no hay riesgo de ciclo ahí.
// ---------------------------------------------------------------------------

import { db, auth } from "./firebase-config.js";
import {
  collection,
  doc,
  getDocs,
  addDoc,
  updateDoc,
  deleteDoc,
  arrayUnion,
  query,
  where,
  limit
} from "https://www.gstatic.com/firebasejs/12.18.0/firebase-firestore.js";
import { getContactosActuales, setContactosActuales, getLotesActuales } from "./estado.js";
import { centroideDePoligono } from "./geometria.js";
import { registrarAuditoria } from "./auditoria.js";
import { esRootActual, tienePermiso } from "./permisos.js";

const COLECCION_CONTACTOS = "contactos";

// Techo de lo que se le pide a Firestore de una sola vez: una consulta sin
// límite crece en costo (y en tiempo de carga) al mismo ritmo que la
// cartera — con esto, aunque la agencia llegue a tener miles de contactos
// algún día, abrir el CRM sigue siendo una sola lectura acotada. 500
// contactos activos es un techo cómodo para una inmobiliaria chica/mediana
// durante años, no un límite real del día a día.
const LIMITE_CONTACTOS = 500;

// Sin actualizarse en más de esta cantidad de días (y sin estar ya
// cerrado/perdido), un contacto se marca "estancado" — mismo espíritu que
// "Reservas por vencer" del Dashboard: hacer visible lo que se está
// enfriando antes de que se pierda solo por no haberlo mirado.
const DIAS_ESTANCADO = 7;

// Un seguimiento agendado entra a la lista de "Seguimientos" del panel si
// ya venció o si es hoy o en los próximos N días — mismo umbral "urgente"
// que ya usa el Dashboard para reservas por vencer.
const DIAS_SEGUIMIENTO_PROXIMO = 3;

let mapa, mostrarFicha, tituloLote;

// app.js llama esto una sola vez, antes de usar cualquier otra función de
// este módulo.
export function configurarCrm(deps) {
  ({ mapa, mostrarFicha, tituloLote } = deps);
}

// Un color por etapa (variables CSS nuevas, ver estilos.css) — pintan el
// borde de arriba de cada columna y el borde izquierdo de cada tarjeta,
// mismo lenguaje visual que cualquier CRM real (Pipedrive, HubSpot): se
// distingue la etapa de un vistazo, sin tener que leer el texto. Reusan
// colores que YA existen en la app para "visita"/"oferta"/"cerrado"/
// "perdido" porque significan casi lo mismo que ya significan ahí
// (oferta = decisión pendiente, como una reserva; cerrado = éxito, como
// un lote disponible; perdido = una pérdida, como un lote vendido a
// otro) — "nuevo"/"contactado" son los dos únicos tonos nuevos.
const ETAPAS = [
  { clave: "nuevo", etiqueta: "Nuevo", color: "var(--crm-nuevo)" },
  { clave: "contactado", etiqueta: "Contactado", color: "var(--crm-contactado)" },
  { clave: "visita", etiqueta: "Visita", color: "var(--crm-visita)" },
  { clave: "oferta", etiqueta: "Oferta", color: "var(--crm-oferta)" },
  { clave: "cerrado", etiqueta: "Cerrado", color: "var(--crm-cerrado)" },
  { clave: "perdido", etiqueta: "Perdido", color: "var(--crm-perdido)" }
];
const ETIQUETA_ETAPA = Object.fromEntries(ETAPAS.map((e) => [e.clave, e.etiqueta]));
const COLOR_ETAPA = Object.fromEntries(ETAPAS.map((e) => [e.clave, e.color]));

const ETIQUETA_ACTIVIDAD = {
  nota: "📝 Nota",
  llamada: "📞 Llamada",
  whatsapp: "💬 WhatsApp",
  visita: "🚗 Visita",
  email: "✉️ Email"
};

// Iniciales + color de avatar determinístico a partir del nombre —
// mismo criterio que Trello/Asana: cada persona tiene un color estable
// sin necesidad de guardarlo a mano por contacto.
const PALETA_AVATAR = ["#33523a", "#c1663f", "#4f7cac", "#8a6d3b", "#6b5b95", "#3f7a5c", "#a1477a", "#5c7f3f"];

function colorAvatar(texto) {
  let hash = 0;
  for (let i = 0; i < texto.length; i++) hash = (hash * 31 + texto.charCodeAt(i)) >>> 0;
  return PALETA_AVATAR[hash % PALETA_AVATAR.length];
}

function iniciales(nombre) {
  const partes = (nombre || "").trim().split(/\s+/).filter(Boolean);
  if (partes.length === 0) return "?";
  if (partes.length === 1) return partes[0].slice(0, 2).toUpperCase();
  return (partes[0][0] + partes[1][0]).toUpperCase();
}

// ---------------------------------------------------------------------------
// WhatsApp: heurística de mejor esfuerzo para armar un link wa.me a partir
// de un teléfono cargado a mano, sin ningún formato fijo (con o sin 0/15,
// con o sin código de área, con o sin "54"). No hay forma 100% confiable de
// adivinar esto sin pedirle el celular real al usuario — se prioriza que
// funcione para el caso común (número argentino tal cual lo escribe un
// corredor) antes que una validación estricta.
// ---------------------------------------------------------------------------

function normalizarTelefonoWhatsapp(telefono) {
  const soloDigitos = (telefono || "").replace(/\D/g, "");
  if (!soloDigitos) return null;
  if (soloDigitos.startsWith("54")) return soloDigitos;
  if (soloDigitos.startsWith("9")) return `54${soloDigitos}`;
  return `549${soloDigitos}`;
}

function linkWhatsapp(telefono) {
  const numero = normalizarTelefonoWhatsapp(telefono);
  return numero ? `https://wa.me/${numero}` : null;
}

function puedeVerTodosLosContactos() {
  return esRootActual() || tienePermiso("ver_todos_los_contactos");
}

function estaEstancado(contacto) {
  if (contacto.estado === "cerrado" || contacto.estado === "perdido") return false;
  const fecha = contacto.fecha_actualizacion || contacto.fecha_creacion;
  if (!fecha) return false;
  const dias = Math.floor((Date.now() - new Date(fecha).getTime()) / 86400000);
  return dias >= DIAS_ESTANCADO;
}

// ---------------------------------------------------------------------------
// Alta automática desde "Agregar interesado" (ficha del lote). Fire-and-
// forget, mismo criterio que registrarVistaDeLote/registrarAuditoria: si
// falla acá (sin conexión, etc.) el interesado ya se guardó en el lote de
// todas formas — esto solo alimenta el pipeline central, no reemplaza a
// aquel guardado ni bloquea el flujo si algo sale mal.
//
// Si ya existe un contacto con el mismo teléfono, no se crea uno nuevo: se
// le suma este lote a "lotes de interés" (si todavía no lo tenía) y queda
// una actividad automática registrando el interés nuevo — el mismo
// comprador preguntando por otro lote no debería aparecer duplicado en el
// pipeline, pero tampoco perderse sin dejar rastro. Sin teléfono no hay
// forma confiable de saber si es la misma persona, así que en ese caso
// siempre crea un contacto nuevo.
export async function crearContactoDesdeInteresado({ nombre, telefono, nota, feature }) {
  if (!auth.currentUser) return;
  try {
    const loteInteres = { id: feature.id, titulo: tituloLote(feature.properties) };
    const ahora = new Date().toISOString();
    const autorEmail = auth.currentUser.email || null;

    if (telefono) {
      const coincidencias = await getDocs(
        query(collection(db, COLECCION_CONTACTOS), where("telefono", "==", telefono))
      );
      if (!coincidencias.empty) {
        const docExistente = coincidencias.docs[0];
        const datos = docExistente.data();
        const yaLoTiene = (datos.lotes_interes || []).some((l) => l.id === loteInteres.id);
        if (!yaLoTiene) {
          const textoActividad = `También preguntó por ${loteInteres.titulo}.${nota ? ` "${nota}"` : ""}`;
          await updateDoc(doc(db, COLECCION_CONTACTOS, docExistente.id), {
            lotes_interes: [...(datos.lotes_interes || []), loteInteres],
            actividades: arrayUnion({ tipo: "nota", texto: textoActividad, fecha: ahora, autor_email: autorEmail }),
            fecha_actualizacion: ahora
          });
        }
        return;
      }
    }

    await addDoc(collection(db, COLECCION_CONTACTOS), {
      nombre,
      telefono: telefono || null,
      email: null,
      estado: "nuevo",
      motivo_perdido: null,
      proximo_seguimiento: null,
      lotes_interes: [loteInteres],
      actividades: [
        {
          tipo: "nota",
          texto: nota || `Interesado en ${loteInteres.titulo}.`,
          fecha: ahora,
          autor_email: autorEmail
        }
      ],
      asignado_a: auth.currentUser.uid,
      creado_por: auth.currentUser.uid,
      fecha_creacion: ahora,
      fecha_actualizacion: ahora
    });
  } catch {
    // Crear un contacto no depende del permiso "gestionar_contactos" (ver
    // firestore.rules) — si igual falla acá (sin conexión, la actualización
    // de un contacto ajeno sin ese permiso) no se avisa nada: el
    // interesado ya quedó guardado en el lote de todas formas.
  }
}

// ---------------------------------------------------------------------------
// Datos: qué contactos trae cargarContactos() depende del modo de vista
// ("mias" | "todas") — ver más abajo, junto al toggle de la barra de
// herramientas. Se ordena en el cliente por última actualización en vez de
// con orderBy() en la consulta a propósito: combinar where("asignado_a",...)
// con orderBy("fecha_actualizacion") pediría un índice compuesto, y este
// proyecto no tiene Firebase CLI para crearlo por código — solo a mano en
// la Consola. Ordenar acá evita esa dependencia sin perder la función.
// ---------------------------------------------------------------------------

let modoVista = "mias"; // se reinicia a "mias" cada vez que se abre el panel

export async function cargarContactos() {
  try {
    const verTodas = modoVista === "todas" && puedeVerTodosLosContactos();
    const base = collection(db, COLECCION_CONTACTOS);
    const consulta = verTodas
      ? query(base, limit(LIMITE_CONTACTOS))
      : query(base, where("asignado_a", "==", auth.currentUser?.uid || "__sin_sesion__"), limit(LIMITE_CONTACTOS));
    const snapshot = await getDocs(consulta);
    const contactos = snapshot.docs.map((d) => ({ id: d.id, ...d.data() }));
    contactos.sort((a, b) => (b.fecha_actualizacion || "").localeCompare(a.fecha_actualizacion || ""));
    setContactosActuales(contactos);
  } catch {
    // Si falla (reglas viejas, sin conexión, etc.) el panel queda vacío en
    // vez de romper — mismo criterio que cargarSectores/cargarBarrios.
    setContactosActuales([]);
  }
}

// Uid → email de cada corredor, para poder mostrar "de quién es" un
// contacto en la vista "Todos" — sin esto, "Todos" mezcla la cartera de
// todo el equipo sin forma de distinguir una tarjeta de otra más que por
// contenido. Se resuelve una sola vez por sesión (lazy, recién la primera
// vez que hace falta) y se cachea: la lista de corredores de una
// inmobiliaria chica cambia muy de vez en cuando, no vale la pena
// releerla en cada toggle. "usuarios" es de lectura abierta a cualquier
// logueado (ver firestore.rules), mismo permiso que ya usa admin.js para
// resolver el propio perfil.
let usuariosPorUid = null;

async function obtenerUsuariosPorUid() {
  if (usuariosPorUid) return usuariosPorUid;
  try {
    const snapshot = await getDocs(collection(db, "usuarios"));
    usuariosPorUid = Object.fromEntries(snapshot.docs.map((d) => [d.id, d.data().email || d.id]));
  } catch {
    usuariosPorUid = {};
  }
  return usuariosPorUid;
}

// "Vos" para lo propio, el email real para lo ajeno, o un texto genérico
// si por lo que sea no se pudo resolver (corredor borrado después, cache
// todavía sin poblar). Solo tiene sentido llamarlo con el cache ya
// poblado (ver cambiarModoVista) — sin eso, cualquier contacto ajeno
// mostraría el genérico hasta el próximo render.
function textoAsignado(contacto) {
  if (!contacto.asignado_a) return "Sin asignar";
  if (contacto.asignado_a === auth.currentUser?.uid) return "Vos";
  return usuariosPorUid?.[contacto.asignado_a] || "Otro corredor";
}

// ---------------------------------------------------------------------------
// Panel: métricas + seguimientos + barra de herramientas + kanban (vista
// principal), y el formulario de alta/edición (reemplaza al kanban, mismo
// patrón que catalogos.js/admin.js: la vista completa cambia, no un
// formulario que se abre encima).
// ---------------------------------------------------------------------------

const elPanel = document.getElementById("panel-crm");
const elBtnAbrir = document.getElementById("btn-abrir-crm");
const elVistaKanban = document.getElementById("crm-vista-kanban");
const elVistaForm = document.getElementById("crm-vista-form");
const elStats = document.getElementById("crm-stats");
const elSeguimientos = document.getElementById("crm-seguimientos");
const elSeguimientosVacio = document.getElementById("crm-seguimientos-vacio");
const elSeguimientosContador = document.getElementById("crm-seguimientos-contador");
const elBuscar = document.getElementById("crm-buscar");
const elFiltroVista = document.getElementById("crm-filtro-vista");
const elBtnVistaMias = document.getElementById("btn-crm-vista-mias");
const elBtnVistaTodas = document.getElementById("btn-crm-vista-todas");
const elKanban = document.getElementById("crm-kanban");
const elVacio = document.getElementById("crm-vacio");
const elSinResultados = document.getElementById("crm-sin-resultados");
const elBtnAgregarContacto = document.getElementById("btn-agregar-contacto");
const elBtnExportar = document.getElementById("btn-exportar-contactos");
const elVolver = document.getElementById("crm-volver");
const elFormTitulo = document.getElementById("crm-form-titulo");
const formulario = document.getElementById("formulario-contacto");
const elIdEditando = document.getElementById("contacto-id-editando");
const elNombre = document.getElementById("contacto-nombre");
const elTelefono = document.getElementById("contacto-telefono");
const elWhatsapp = document.getElementById("contacto-whatsapp");
const elEmail = document.getElementById("contacto-email");
const elEstado = document.getElementById("contacto-estado");
const elCampoMotivoPerdido = document.getElementById("crm-campo-motivo-perdido");
const elMotivoPerdido = document.getElementById("contacto-motivo-perdido");
const elCampoAsignado = document.getElementById("crm-campo-asignado");
const elSelectAsignado = document.getElementById("contacto-asignado");
const elSeguimientoInput = document.getElementById("contacto-seguimiento");
const elListaLotesInteres = document.getElementById("crm-lista-lotes-interes");
const elLotesInteresVacio = document.getElementById("crm-lotes-interes-vacio");
const elSelectLote = document.getElementById("crm-select-lote");
const elBtnAgregarLoteInteres = document.getElementById("btn-agregar-lote-interes");
const elListaActividades = document.getElementById("crm-lista-actividades");
const elActividadesVacio = document.getElementById("crm-actividades-vacio");
const elAgregarActividad = document.getElementById("crm-agregar-actividad");
const elActividadPrimeroGuardar = document.getElementById("crm-actividad-primero-guardar");
const elActividadTipo = document.getElementById("actividad-tipo");
const elActividadTexto = document.getElementById("actividad-texto");
const elBtnAgregarActividad = document.getElementById("btn-agregar-actividad");
const elBtnGuardarContacto = document.getElementById("contacto-guardar-btn");
const elBtnBorrarContacto = document.getElementById("btn-borrar-contacto");
const elError = document.getElementById("contacto-error");

// Lotes de interés del contacto que se está editando/creando en este
// momento — vive acá (no en Firestore) hasta que se guarda el formulario,
// mismo criterio que cualquier otro campo del form; evita un updateDoc
// por cada "+ Agregar"/"Quitar" mientras se completa el alta.
let lotesInteresEnEdicion = [];

// Filtro de texto de la barra de herramientas (nombre o teléfono) — se
// aplica en el cliente sobre lo ya cargado, no perfora Firestore de nuevo
// por cada letra tipeada.
let terminoBusqueda = "";

function textoHaceDias(fechaIso) {
  if (!fechaIso) return "";
  const dias = Math.max(0, Math.floor((Date.now() - new Date(fechaIso).getTime()) / 86400000));
  if (dias === 0) return "Hoy";
  if (dias === 1) return "Hace 1 día";
  return `Hace ${dias} días`;
}

function textoLotesResumen(lotes) {
  if (!lotes.length) return "Sin lote de interés";
  if (lotes.length === 1) return `📍 ${lotes[0].titulo}`;
  return `📍 ${lotes[0].titulo} +${lotes.length - 1} más`;
}

// Lleva directo al lote en el mapa desde un chip de "lotes de interés" —
// mismo criterio que irAFichaDesdeDashboard (dashboard.js): centra el
// mapa primero para que la ficha no se abra sobre un punto fuera de la
// vista actual. Si el lote ya no existe (se borró después) no hay nada
// que mostrar.
function irALoteDesdeCrm(loteId) {
  const feature = getLotesActuales().find((f) => f.id === loteId);
  if (!feature) {
    window.alert("Este lote ya no existe.");
    return;
  }
  elPanel.classList.add("oculto");
  const { lat, lon } = centroideDePoligono(feature.geometry.coordinates[0]);
  mapa.setView([lat, lon], 19);
  mostrarFicha(feature);
}

async function moverContacto(contacto, nuevoEstado) {
  if (nuevoEstado === contacto.estado) return;

  // Perder un contacto sin dejar registrado por qué es tirar a la basura
  // el único dato que después sirve para ver patrones reales (precio,
  // financiación, se lo llevó otra inmobiliaria...) — se pregunta acá,
  // en el momento, en vez de esperar a que alguien abra el contacto y
  // complete un campo aparte (que en la práctica nunca pasa).
  let motivoPerdido = contacto.motivo_perdido || null;
  if (nuevoEstado === "perdido") {
    const respuesta = window.prompt("¿Por qué se perdió este contacto? (opcional)", "");
    if (respuesta === null) {
      // Canceló: no se mueve. Se vuelve a pintar el kanban desde el
      // estado real (todavía sin tocar) para que el <select> no quede
      // mostrando "Perdido" sin haberse aplicado de verdad.
      renderKanban();
      return;
    }
    motivoPerdido = respuesta.trim() || null;
  }

  const estadoAnterior = contacto.estado;
  const motivoAnterior = contacto.motivo_perdido || null;
  // Optimista: se pinta ya, sin esperar el updateDoc — con conexión rural
  // lenta, esperar a Firestore antes de mover la tarjeta se siente
  // trabado. Si falla, se revierte más abajo.
  contacto.estado = nuevoEstado;
  contacto.motivo_perdido = motivoPerdido;
  contacto.fecha_actualizacion = new Date().toISOString();
  renderTodo();
  try {
    await updateDoc(doc(db, COLECCION_CONTACTOS, contacto.id), {
      estado: nuevoEstado,
      motivo_perdido: motivoPerdido,
      fecha_actualizacion: contacto.fecha_actualizacion
    });
    registrarAuditoria({
      accion: "mover_contacto",
      objetoId: contacto.id,
      objetoTitulo: contacto.nombre,
      detalle: `${ETIQUETA_ETAPA[estadoAnterior]} → ${ETIQUETA_ETAPA[nuevoEstado]}${motivoPerdido ? ` (${motivoPerdido})` : ""}`
    });
  } catch (error) {
    contacto.estado = estadoAnterior;
    contacto.motivo_perdido = motivoAnterior;
    renderTodo();
    window.alert(
      error.code === "permission-denied" ? "No tenés permiso para mover contactos." : "No se pudo mover el contacto."
    );
  }
}

function tarjetaContacto(contacto) {
  const tarjeta = document.createElement("div");
  tarjeta.className = "crm-tarjeta";
  tarjeta.dataset.testid = `crm-tarjeta-${contacto.id}`;
  // Borde izquierdo del color de la etapa actual — se lee de un vistazo
  // sin depender del texto del <select>, mismo lenguaje visual que
  // Pipedrive/HubSpot (ver COLOR_ETAPA más arriba).
  tarjeta.style.setProperty("--stage-color", COLOR_ETAPA[contacto.estado] || "var(--color-borde)");

  const cabecera = document.createElement("div");
  cabecera.className = "crm-tarjeta-cabecera";

  const avatar = document.createElement("span");
  avatar.className = "crm-avatar";
  avatar.textContent = iniciales(contacto.nombre);
  avatar.style.background = colorAvatar(contacto.nombre);
  cabecera.appendChild(avatar);

  const nombre = document.createElement("p");
  nombre.className = "crm-tarjeta-nombre";
  nombre.textContent = contacto.nombre;
  cabecera.appendChild(nombre);
  tarjeta.appendChild(cabecera);

  const lotes = document.createElement("p");
  lotes.className = "crm-tarjeta-lotes";
  lotes.textContent = textoLotesResumen(contacto.lotes_interes || []);
  tarjeta.appendChild(lotes);

  // Solo en "Todos": en "Mis contactos" siempre serías vos, no aporta
  // nada aclararlo tarjeta por tarjeta.
  if (modoVista === "todas") {
    const asignado = document.createElement("p");
    asignado.className = "crm-tarjeta-asignado";
    asignado.textContent = `👤 ${textoAsignado(contacto)}`;
    tarjeta.appendChild(asignado);
  }

  // "Sin novedades": mismo espíritu que las alertas del Dashboard, para
  // que un lead que se está enfriando no quede perdido entre el resto de
  // la columna sin que nadie lo note.
  if (estaEstancado(contacto)) {
    const badges = document.createElement("div");
    badges.className = "crm-tarjeta-badges";
    const badge = document.createElement("span");
    badge.className = "crm-badge-estancado";
    badge.textContent = `Sin novedades +${DIAS_ESTANCADO}d`;
    badges.appendChild(badge);
    tarjeta.appendChild(badges);
  }

  const pie = document.createElement("div");
  pie.className = "crm-tarjeta-pie";
  const fecha = document.createElement("span");
  fecha.className = "crm-tarjeta-fecha";
  fecha.textContent = textoHaceDias(contacto.fecha_actualizacion || contacto.fecha_creacion);
  pie.appendChild(fecha);
  tarjeta.appendChild(pie);

  // Selector de etapa directo en la tarjeta: mecanismo PRINCIPAL para
  // mover un contacto de estado (no drag-and-drop) — el drag-and-drop
  // nativo de HTML5 no funciona bien en pantallas táctiles, y esta app
  // está pensada para usarse desde el celular igual que desde escritorio.
  const selectMover = document.createElement("select");
  selectMover.className = "crm-tarjeta-mover";
  selectMover.dataset.testid = `crm-mover-${contacto.id}`;
  ETAPAS.forEach(({ clave, etiqueta }) => {
    const opcion = document.createElement("option");
    opcion.value = clave;
    opcion.textContent = etiqueta;
    if (clave === contacto.estado) opcion.selected = true;
    selectMover.appendChild(opcion);
  });
  // Evita que tocar el select también dispare el click de la tarjeta
  // (abriría el formulario de edición al mismo tiempo que se mueve de
  // etapa).
  selectMover.addEventListener("click", (evento) => evento.stopPropagation());
  selectMover.addEventListener("change", () => moverContacto(contacto, selectMover.value));
  tarjeta.appendChild(selectMover);

  tarjeta.addEventListener("click", () => mostrarForm(contacto));
  return tarjeta;
}

function contactosFiltrados() {
  const contactos = getContactosActuales();
  if (!terminoBusqueda) return contactos;
  return contactos.filter(
    (c) =>
      (c.nombre || "").toLowerCase().includes(terminoBusqueda) ||
      (c.telefono || "").toLowerCase().includes(terminoBusqueda)
  );
}

function renderKanban() {
  const contactos = getContactosActuales();
  const filtrados = contactosFiltrados();
  elVacio.classList.toggle("oculto", contactos.length > 0);
  elSinResultados.classList.toggle("oculto", contactos.length === 0 || filtrados.length > 0);
  elKanban.innerHTML = "";
  ETAPAS.forEach(({ clave, etiqueta, color }) => {
    const deEstaEtapa = filtrados.filter((c) => c.estado === clave);
    const columna = document.createElement("div");
    columna.className = "crm-columna";
    columna.dataset.testid = `crm-columna-${clave}`;
    columna.style.setProperty("--stage-color", color);

    const cabeceraColumna = document.createElement("div");
    cabeceraColumna.className = "crm-columna-cabecera";

    const titulo = document.createElement("p");
    titulo.className = "crm-columna-titulo";
    titulo.innerHTML = `<span class="crm-columna-dot"></span>${etiqueta} <span class="crm-columna-contador">${deEstaEtapa.length}</span>`;
    cabeceraColumna.appendChild(titulo);

    // Alta rápida directamente en esta columna (idea de Attio: un "+" en
    // cada cabecera de columna) — abre el mismo formulario de siempre,
    // solo que ya con el estado de esta columna preseleccionado.
    const btnAgregarAqui = document.createElement("button");
    btnAgregarAqui.type = "button";
    btnAgregarAqui.className = "crm-columna-agregar";
    btnAgregarAqui.textContent = "+";
    btnAgregarAqui.setAttribute("aria-label", `Nuevo contacto en ${etiqueta}`);
    btnAgregarAqui.addEventListener("click", () => mostrarForm(null, clave));
    cabeceraColumna.appendChild(btnAgregarAqui);

    columna.appendChild(cabeceraColumna);

    deEstaEtapa.forEach((contacto) => columna.appendChild(tarjetaContacto(contacto)));
    elKanban.appendChild(columna);
  });
}

// ---------------------------------------------------------------------------
// Métricas rápidas: de un vistazo, sin tener que contar tarjetas a mano.
// ---------------------------------------------------------------------------

function calcularMetricas(contactos) {
  const hace7Dias = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
  const total = contactos.length;
  const nuevosEstaSemana = contactos.filter((c) => (c.fecha_creacion || "").slice(0, 10) >= hace7Dias).length;
  const cerrados = contactos.filter((c) => c.estado === "cerrado").length;
  const tasaConversion = total > 0 ? Math.round((cerrados / total) * 100) : null;
  const estancados = contactos.filter(estaEstancado).length;
  return { total, nuevosEstaSemana, tasaConversion, estancados };
}

function renderStats() {
  const m = calcularMetricas(getContactosActuales());
  elStats.innerHTML = `
    <div class="crm-stat"><strong>${m.total}</strong><span>Contactos</span></div>
    <div class="crm-stat"><strong>${m.nuevosEstaSemana}</strong><span>Nuevos (7 días)</span></div>
    <div class="crm-stat"><strong>${m.tasaConversion == null ? "—" : `${m.tasaConversion}%`}</strong><span>Conversión a cerrado</span></div>
    <div class="crm-stat"><strong>${m.estancados}</strong><span>Estancados (+${DIAS_ESTANCADO}d)</span></div>
  `;
}

// ---------------------------------------------------------------------------
// Seguimientos: recordatorios vencidos o próximos, mismo lenguaje visual
// que "Reservas por vencer" del Dashboard (reusa .dashboard-lista/
// .dashboard-badge).
// ---------------------------------------------------------------------------

function contactosParaSeguimiento(contactos) {
  const limiteFuturo = new Date(Date.now() + DIAS_SEGUIMIENTO_PROXIMO * 86400000).toISOString().slice(0, 10);
  return contactos
    .filter(
      (c) => c.proximo_seguimiento && c.proximo_seguimiento <= limiteFuturo && c.estado !== "cerrado" && c.estado !== "perdido"
    )
    .sort((a, b) => a.proximo_seguimiento.localeCompare(b.proximo_seguimiento));
}

function actualizarContadorSeguimientos(cantidad) {
  elSeguimientosContador.textContent = cantidad;
  elSeguimientosContador.classList.toggle("oculto", cantidad === 0);
}

function renderSeguimientos() {
  const pendientes = contactosParaSeguimiento(getContactosActuales());
  const hoy = new Date().toISOString().slice(0, 10);
  elSeguimientos.innerHTML = "";
  pendientes.forEach((contacto) => {
    const dias = Math.round(
      (new Date(`${contacto.proximo_seguimiento}T00:00:00`) - new Date(`${hoy}T00:00:00`)) / 86400000
    );
    const vencido = dias < 0;
    const urgente = !vencido && dias <= 1;

    const li = document.createElement("li");
    const grupo = document.createElement("span");
    grupo.className = "dashboard-lote-titulo-grupo";
    const titulo = document.createElement("span");
    titulo.className = "dashboard-lote-titulo";
    titulo.textContent = contacto.nombre;
    grupo.appendChild(titulo);
    li.appendChild(grupo);

    const badge = document.createElement("span");
    badge.className = `dashboard-badge${vencido ? " vencida" : urgente ? " urgente" : ""}`;
    badge.textContent = vencido
      ? `vencido hace ${Math.abs(dias)} d.`
      : dias === 0
        ? "hoy"
        : dias === 1
          ? "mañana"
          : `en ${dias} d.`;
    li.appendChild(badge);

    li.addEventListener("click", () => mostrarForm(contacto));
    elSeguimientos.appendChild(li);
  });
  elSeguimientosVacio.classList.toggle("oculto", pendientes.length > 0);
  actualizarContadorSeguimientos(pendientes.length);
}

function renderTodo() {
  renderStats();
  renderSeguimientos();
  renderKanban();
}

function mostrarKanban() {
  elVistaForm.classList.add("oculto");
  elVistaKanban.classList.remove("oculto");
}

// ---------------------------------------------------------------------------
// Lotes de interés (dentro del formulario de alta/edición).
// ---------------------------------------------------------------------------

function renderListaLotesInteres() {
  elListaLotesInteres.innerHTML = "";
  lotesInteresEnEdicion.forEach((lote) => {
    const li = document.createElement("li");
    li.className = "crm-chip-lote";

    const botonTitulo = document.createElement("button");
    botonTitulo.type = "button";
    botonTitulo.className = "crm-chip-titulo";
    botonTitulo.textContent = lote.titulo;
    botonTitulo.addEventListener("click", () => irALoteDesdeCrm(lote.id));
    li.appendChild(botonTitulo);

    const botonQuitar = document.createElement("button");
    botonQuitar.type = "button";
    botonQuitar.className = "crm-chip-quitar";
    botonQuitar.textContent = "×";
    botonQuitar.setAttribute("aria-label", `Quitar ${lote.titulo} de lotes de interés`);
    botonQuitar.addEventListener("click", () => {
      lotesInteresEnEdicion = lotesInteresEnEdicion.filter((l) => l.id !== lote.id);
      renderListaLotesInteres();
    });
    li.appendChild(botonQuitar);

    elListaLotesInteres.appendChild(li);
  });
  elLotesInteresVacio.classList.toggle("oculto", lotesInteresEnEdicion.length > 0);
}

function poblarSelectLotes() {
  const lotes = getLotesActuales();
  elSelectLote.innerHTML = lotes.map((f) => `<option value="${f.id}">${tituloLote(f.properties)}</option>`).join("");
}

// "Asignado a" — reasignar es elegir otro corredor de la lista y guardar,
// nada más especial que eso. Solo tiene sentido con "ver_todos_los_
// contactos" (o root): sin ese permiso un corredor gestiona su propia
// cartera nomás, mostrarle este campo no tendría nada útil para elegir.
// valorActual puede apuntar a un uid que ya no está en el cache (un
// corredor borrado después) — mismo criterio que poblarSelectCatalogo
// (catalogos.js): se agrega como opción aparte en vez de perder el dato.
function poblarSelectAsignado(valorActual) {
  const puede = puedeVerTodosLosContactos();
  elCampoAsignado.classList.toggle("oculto", !puede);
  if (!puede) return;

  const usuarios = usuariosPorUid || {};
  const opciones = Object.entries(usuarios).sort((a, b) => a[1].localeCompare(b[1]));
  let html = opciones.map(([uid, email]) => `<option value="${uid}">${email}</option>`).join("");
  const valorFinal = valorActual || auth.currentUser?.uid;
  if (valorFinal && !usuarios[valorFinal]) {
    html += `<option value="${valorFinal}">${valorFinal} (usuario no encontrado)</option>`;
  }
  elSelectAsignado.innerHTML = html;
  elSelectAsignado.value = valorFinal;
}

elBtnAgregarLoteInteres.addEventListener("click", () => {
  const loteId = elSelectLote.value;
  if (!loteId || lotesInteresEnEdicion.some((l) => l.id === loteId)) return;
  const feature = getLotesActuales().find((f) => f.id === loteId);
  if (!feature) return;
  lotesInteresEnEdicion.push({ id: loteId, titulo: tituloLote(feature.properties) });
  renderListaLotesInteres();
});

// ---------------------------------------------------------------------------
// Actividad (historial de interacciones) — reemplaza a un campo de "nota"
// único: cada llamada/visita/whatsapp queda registrada con fecha y autor,
// no se pisa la anterior. Se agrega con su propio guardado inmediato (no
// espera al "Guardar" del resto del formulario) — mismo criterio que
// "Interesados" en la ficha de un lote. Solo disponible con el contacto ya
// guardado (hace falta un id de documento para poder sumarle algo).
// ---------------------------------------------------------------------------

function renderActividades(contacto) {
  const actividades = [...(contacto?.actividades || [])].sort((a, b) => (b.fecha || "").localeCompare(a.fecha || ""));
  elListaActividades.innerHTML = "";
  actividades.forEach((actividad) => {
    const li = document.createElement("li");
    li.className = "crm-actividad";

    const cabecera = document.createElement("div");
    cabecera.className = "crm-actividad-cabecera";
    const tipo = document.createElement("span");
    tipo.className = "crm-actividad-tipo";
    tipo.textContent = ETIQUETA_ACTIVIDAD[actividad.tipo] || actividad.tipo;
    cabecera.appendChild(tipo);
    const fecha = document.createElement("span");
    fecha.textContent = actividad.fecha
      ? new Date(actividad.fecha).toLocaleString("es-AR", {
          day: "2-digit",
          month: "2-digit",
          year: "numeric",
          hour: "2-digit",
          minute: "2-digit"
        })
      : "";
    cabecera.appendChild(fecha);
    li.appendChild(cabecera);

    if (actividad.texto) {
      const texto = document.createElement("p");
      texto.className = "crm-actividad-texto";
      texto.textContent = actividad.texto;
      li.appendChild(texto);
    }

    elListaActividades.appendChild(li);
  });
  elActividadesVacio.classList.toggle("oculto", actividades.length > 0);
}

elBtnAgregarActividad.addEventListener("click", async () => {
  const idEditando = elIdEditando.value;
  const texto = elActividadTexto.value.trim();
  if (!idEditando || !texto) return;

  const actividad = {
    tipo: elActividadTipo.value,
    texto,
    fecha: new Date().toISOString(),
    autor_email: auth.currentUser?.email || null
  };
  elBtnAgregarActividad.disabled = true;
  try {
    await updateDoc(doc(db, COLECCION_CONTACTOS, idEditando), {
      actividades: arrayUnion(actividad),
      fecha_actualizacion: actividad.fecha
    });
    const contactoLocal = getContactosActuales().find((c) => c.id === idEditando);
    if (contactoLocal) {
      contactoLocal.actividades = [...(contactoLocal.actividades || []), actividad];
      contactoLocal.fecha_actualizacion = actividad.fecha;
      renderActividades(contactoLocal);
    }
    elActividadTexto.value = "";
  } catch (error) {
    window.alert(
      error.code === "permission-denied" ? "No tenés permiso para agregar actividad." : "No se pudo guardar la actividad."
    );
  } finally {
    elBtnAgregarActividad.disabled = false;
  }
});

// ---------------------------------------------------------------------------
// WhatsApp directo y motivo de pérdida — reaccionan en vivo mientras se
// completa el formulario, no solo al precargar un contacto existente.
// ---------------------------------------------------------------------------

function actualizarBotonWhatsapp() {
  const link = linkWhatsapp(elTelefono.value);
  elWhatsapp.classList.toggle("oculto", !link);
  if (link) elWhatsapp.href = link;
}
elTelefono.addEventListener("input", actualizarBotonWhatsapp);

function actualizarVisibilidadMotivoPerdido() {
  elCampoMotivoPerdido.classList.toggle("oculto", elEstado.value !== "perdido");
}
elEstado.addEventListener("change", actualizarVisibilidadMotivoPerdido);

// contacto == null: alta de un contacto nuevo. Con un contacto, lo
// precarga para editarlo (mismo formulario, en modo edición) — mismo
// patrón que crearPanelCatalogo (catalogos.js).
// estadoInicial: solo se usa con contacto == null (alta rápida desde el
// "+" de una columna del kanban) — precarga el estado con el que se creó
// el contacto en vez de forzar siempre "Nuevo".
function mostrarForm(contacto, estadoInicial) {
  formulario.reset();
  elError.classList.add("oculto");
  poblarSelectLotes();
  lotesInteresEnEdicion = contacto ? [...(contacto.lotes_interes || [])] : [];
  renderListaLotesInteres();
  renderActividades(contacto);
  elAgregarActividad.classList.toggle("oculto", !contacto);
  elActividadPrimeroGuardar.classList.toggle("oculto", !!contacto);

  if (contacto) {
    elIdEditando.value = contacto.id;
    elFormTitulo.textContent = contacto.nombre;
    elNombre.value = contacto.nombre;
    elTelefono.value = contacto.telefono || "";
    elEmail.value = contacto.email || "";
    elEstado.value = contacto.estado;
    elMotivoPerdido.value = contacto.motivo_perdido || "";
    elSeguimientoInput.value = contacto.proximo_seguimiento || "";
    elBtnBorrarContacto.classList.remove("oculto");
  } else {
    elIdEditando.value = "";
    elFormTitulo.textContent = "Nuevo contacto";
    elEstado.value = estadoInicial || "nuevo";
    elMotivoPerdido.value = "";
    elSeguimientoInput.value = "";
    elBtnBorrarContacto.classList.add("oculto");
  }
  // Solo se llega a un contacto ajeno pasando por "Todos" primero (en
  // "Mis contactos" la propia consulta ya lo excluye), así que el cache
  // de usuarios ya está poblado a esta altura — ver cambiarModoVista y
  // elBtnAbrir.
  poblarSelectAsignado(contacto ? contacto.asignado_a : auth.currentUser?.uid);
  actualizarVisibilidadMotivoPerdido();
  actualizarBotonWhatsapp();

  elVistaKanban.classList.add("oculto");
  elVistaForm.classList.remove("oculto");
}

elBtnAgregarContacto.addEventListener("click", () => mostrarForm(null));
elVolver.addEventListener("click", mostrarKanban);

formulario.addEventListener("submit", async (evento) => {
  evento.preventDefault();
  elError.classList.add("oculto");
  const idEditando = elIdEditando.value;
  const estado = elEstado.value;
  const datos = {
    nombre: elNombre.value.trim(),
    telefono: elTelefono.value.trim() || null,
    email: elEmail.value.trim() || null,
    estado,
    motivo_perdido: estado === "perdido" ? elMotivoPerdido.value.trim() || null : null,
    proximo_seguimiento: elSeguimientoInput.value || null,
    lotes_interes: lotesInteresEnEdicion,
    fecha_actualizacion: new Date().toISOString()
  };
  // El <select> de reasignar solo existe con "ver_todos_los_contactos"
  // (o root) — sin el permiso, un contacto editado se queda con su dueño
  // actual tal cual, y uno nuevo queda asignado a quien lo está creando.
  if (puedeVerTodosLosContactos()) {
    datos.asignado_a = elSelectAsignado.value || auth.currentUser.uid;
  }

  elBtnGuardarContacto.disabled = true;
  try {
    if (idEditando) {
      const contactoPrevio = getContactosActuales().find((c) => c.id === idEditando);
      await updateDoc(doc(db, COLECCION_CONTACTOS, idEditando), datos);
      const reasignado = datos.asignado_a && contactoPrevio && datos.asignado_a !== contactoPrevio.asignado_a;
      registrarAuditoria({
        accion: "editar_contacto",
        objetoId: idEditando,
        objetoTitulo: datos.nombre,
        detalle: reasignado
          ? `Reasignado de ${textoAsignado(contactoPrevio)} a ${usuariosPorUid?.[datos.asignado_a] || datos.asignado_a}`
          : null
      });
    } else {
      datos.actividades = [];
      if (!datos.asignado_a) datos.asignado_a = auth.currentUser.uid;
      datos.creado_por = auth.currentUser.uid;
      datos.fecha_creacion = datos.fecha_actualizacion;
      const nuevoRef = await addDoc(collection(db, COLECCION_CONTACTOS), datos);
      registrarAuditoria({ accion: "crear_contacto", objetoId: nuevoRef.id, objetoTitulo: datos.nombre });
    }
    await cargarContactos();
    renderTodo();
    mostrarKanban();
  } catch (error) {
    elError.textContent =
      error.code === "permission-denied"
        ? "No tenés permiso para gestionar contactos."
        : "No se pudo guardar el contacto.";
    elError.classList.remove("oculto");
  } finally {
    elBtnGuardarContacto.disabled = false;
  }
});

elBtnBorrarContacto.addEventListener("click", async () => {
  const idEditando = elIdEditando.value;
  if (!idEditando) return;
  if (!window.confirm(`¿Borrar a "${elNombre.value}" del CRM? No se puede deshacer.`)) return;
  elBtnBorrarContacto.disabled = true;
  try {
    await deleteDoc(doc(db, COLECCION_CONTACTOS, idEditando));
    registrarAuditoria({ accion: "borrar_contacto", objetoId: idEditando, objetoTitulo: elNombre.value });
    await cargarContactos();
    renderTodo();
    mostrarKanban();
  } catch (error) {
    window.alert(
      error.code === "permission-denied" ? "No tenés permiso para borrar contactos." : "No se pudo borrar el contacto."
    );
  } finally {
    elBtnBorrarContacto.disabled = false;
  }
});

// ---------------------------------------------------------------------------
// Barra de herramientas: buscador + toggle "Mis contactos"/"Todos" +
// exportar CSV.
// ---------------------------------------------------------------------------

elBuscar.addEventListener("input", () => {
  terminoBusqueda = elBuscar.value.trim().toLowerCase();
  renderKanban();
});

async function cambiarModoVista(nuevoModo) {
  if (nuevoModo === modoVista) return;
  modoVista = nuevoModo;
  elBtnVistaMias.classList.toggle("activo", modoVista === "mias");
  elBtnVistaTodas.classList.toggle("activo", modoVista === "todas");
  // Se resuelve ANTES de renderizar (no en paralelo): renderKanban() ya
  // llama a textoAsignado() por cada tarjeta en "Todos", y sin el cache
  // poblado a tiempo todas mostrarían "Otro corredor" hasta el próximo
  // render.
  if (modoVista === "todas") await obtenerUsuariosPorUid();
  await cargarContactos();
  renderTodo();
}
elBtnVistaMias.addEventListener("click", () => cambiarModoVista("mias"));
elBtnVistaTodas.addEventListener("click", () => cambiarModoVista("todas"));

// CSV con BOM (﻿) para que Excel en Windows —lo que casi seguro usa
// una inmobiliaria chica, no una planilla de Google— detecte UTF-8 y no
// rompa los acentos/ñ.
function escaparCsv(valor) {
  const texto = String(valor ?? "");
  return /[",\n]/.test(texto) ? `"${texto.replace(/"/g, '""')}"` : texto;
}

function exportarCsv() {
  const filas = [["Nombre", "Teléfono", "Email", "Estado", "Próximo seguimiento", "Lotes de interés", "Última actualización"]];
  getContactosActuales().forEach((c) => {
    filas.push([
      c.nombre || "",
      c.telefono || "",
      c.email || "",
      ETIQUETA_ETAPA[c.estado] || c.estado || "",
      c.proximo_seguimiento || "",
      (c.lotes_interes || []).map((l) => l.titulo).join(" | "),
      c.fecha_actualizacion || ""
    ]);
  });
  const csv = filas.map((fila) => fila.map(escaparCsv).join(",")).join("\r\n");
  const blob = new Blob([`﻿${csv}`], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const enlace = document.createElement("a");
  enlace.href = url;
  enlace.download = `contactos-mojonapp-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(enlace);
  enlace.click();
  enlace.remove();
  URL.revokeObjectURL(url);
}
elBtnExportar.addEventListener("click", exportarCsv);

// ---------------------------------------------------------------------------
// Apertura/cierre del panel.
// ---------------------------------------------------------------------------

elBtnAbrir.addEventListener("click", async () => {
  document.getElementById("vista-lista").classList.add("oculto"); // no superponer con "Ver como lista"
  document.getElementById("btn-ver-lista").classList.remove("activo");
  document.getElementById("panel-admin").classList.add("oculto"); // ni con "Seguridad"
  document.getElementById("panel-sectores").classList.add("oculto"); // ni con "Zonas"
  document.getElementById("panel-barrios").classList.add("oculto"); // ni con "Barrios"
  document.getElementById("panel-dashboard").classList.add("oculto"); // ni con "Dashboard"
  document.getElementById("ficha-lote").classList.add("oculto");
  mostrarKanban();
  elPanel.classList.remove("oculto");

  // Siempre arranca en "Mis contactos" (default seguro, aunque tenga el
  // permiso de ver todos) — mismo criterio que cualquier vista con
  // alcance: el corredor ve primero lo suyo, y elige ampliar si hace falta.
  modoVista = "mias";
  elBtnVistaMias.classList.add("activo");
  elBtnVistaTodas.classList.remove("activo");
  elFiltroVista.classList.toggle("oculto", !puedeVerTodosLosContactos());
  elBuscar.value = "";
  terminoBusqueda = "";

  // Se precarga acá (no solo al pasar a "Todos") para que el <select>
  // "Asignado a" del formulario ya tenga los corredores listos aunque el
  // manager nunca haya tocado el toggle — reasignar un contacto propio
  // desde "Mis contactos" tiene que andar igual.
  if (puedeVerTodosLosContactos()) await obtenerUsuariosPorUid();

  await cargarContactos();
  renderTodo();
});

document.getElementById("cerrar-panel-crm").addEventListener("click", () => {
  elPanel.classList.add("oculto");
});

// Cualquier otra navegación desde el menú lateral (Dashboard, Ver como
// lista, Cargar lote, Seguridad, etc.) cierra el CRM primero — mismo
// criterio que dashboard.js: un solo listener delegado en vez de
// acordarse de agregarlo a mano en cada botón nuevo del drawer.
document.getElementById("drawer-menu").addEventListener("click", (evento) => {
  const boton = evento.target.closest(".drawer-item");
  if (boton && boton.id !== "btn-abrir-crm") {
    elPanel.classList.add("oculto");
  }
});
