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

// "Control de tiempos de atención" (idea propia, investigada en las
// funcionalidades de Tokko Broker antes de armarla — ver
// feedback_buscar_inspiracion_real: "Módulo de oportunidades... te
// permite... controlar los tiempos de atención"). Distinto de
// "estancado" (que mide silencio DESPUÉS de haber arrancado la
// gestión): esto mide el momento más crítico de todos — un lead nuevo
// que todavía NADIE llamó ni escribió. Deja de contar en cuanto tiene
// una primera actividad registrada, sea cual sea.
const HORAS_SIN_ATENDER = 24;

function estaSinAtender(contacto) {
  if (contacto.estado !== "nuevo") return false;
  if ((contacto.actividades || []).length > 0) return false;
  if (!contacto.fecha_creacion) return false;
  const horas = (Date.now() - new Date(contacto.fecha_creacion).getTime()) / 3600000;
  return horas >= HORAS_SIN_ATENDER;
}

// Última actividad, para el resumen de una línea en la tarjeta del
// kanban (mismo criterio que Pipedrive/HubSpot: ver de un vistazo qué
// fue lo último que pasó, sin tener que abrir el contacto).
function ultimaActividad(contacto) {
  const actividades = contacto.actividades || [];
  if (actividades.length === 0) return null;
  return [...actividades].sort((a, b) => (b.fecha || "").localeCompare(a.fecha || ""))[0];
}

// Calificación de contactos (idea propia — módulo #2 del listado para
// competir con Tokko, investigado en KiteProp/otros comparativas de
// CRM inmobiliario antes de armarla: "calificación automática de
// contactos" aparece como una funcionalidad que ni Tokko ofrece hoy).
// Un puntaje simple de 5 señales, sin nada de IA — cuántas más de estas
// cosas ciertas tenga el contacto, más "caliente" está:
//   1) tiene teléfono cargado (se lo puede contactar de verdad)
//   2) tiene alguna actividad registrada (ya se lo atendió una vez)
//   3) esa actividad fue hace 3 días o menos (sigue fresco)
//   4) tiene 2 o más lotes de interés (está comparando en serio)
//   5) no está ni "estancado" ni "sin atender" (la gestión va sana)
// No tiene sentido calificar un contacto ya resuelto (cerrado/perdido)
// — la calificación es para decidir A QUIÉN LLAMAR primero, no para
// evaluar el pasado.
function calificacionContacto(contacto) {
  if (contacto.estado === "cerrado" || contacto.estado === "perdido") return null;

  let puntos = 0;
  if (contacto.telefono) puntos++;
  const ultima = ultimaActividad(contacto);
  if (ultima) {
    puntos++;
    const diasUltima = Math.floor((Date.now() - new Date(ultima.fecha).getTime()) / 86400000);
    if (diasUltima <= 3) puntos++;
  }
  if ((contacto.lotes_interes || []).length >= 2) puntos++;
  if (!estaEstancado(contacto) && !estaSinAtender(contacto)) puntos++;

  if (puntos >= 4) return { nivel: "caliente", etiqueta: "🔥 Caliente" };
  if (puntos >= 2) return { nivel: "tibio", etiqueta: "🌤️ Tibio" };
  return { nivel: "frio", etiqueta: "❄️ Frío" };
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
const elAutomatizacion = document.getElementById("crm-automatizacion");
const elAutomatizacionTexto = document.getElementById("crm-automatizacion-texto");
const elBtnCerrarEstancados = document.getElementById("btn-cerrar-estancados");
const elRendimientoSeccion = document.getElementById("crm-rendimiento-seccion");
const elRendimientoCuerpo = document.getElementById("crm-rendimiento-cuerpo");
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
const elListaEtiquetas = document.getElementById("crm-lista-etiquetas");
const elEtiquetasVacio = document.getElementById("crm-etiquetas-vacio");
const elInputEtiqueta = document.getElementById("crm-input-etiqueta");
const elBtnAgregarEtiqueta = document.getElementById("btn-agregar-etiqueta");
const elFiltroCalificacion = document.getElementById("crm-filtro-calificacion");
const elFiltroEtiqueta = document.getElementById("crm-filtro-etiqueta");
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
const elCrmFusionar = document.getElementById("crm-fusionar");
const elBtnFusionarContacto = document.getElementById("btn-fusionar-contacto");
const elCrmFusionarPanel = document.getElementById("crm-fusionar-panel");
const elCrmFusionarSelect = document.getElementById("crm-fusionar-select");
const elBtnFusionarConfirmar = document.getElementById("btn-fusionar-confirmar");
const elBtnFusionarCancelar = document.getElementById("btn-fusionar-cancelar");

// Lotes de interés del contacto que se está editando/creando en este
// momento — vive acá (no en Firestore) hasta que se guarda el formulario,
// mismo criterio que cualquier otro campo del form; evita un updateDoc
// por cada "+ Agregar"/"Quitar" mientras se completa el alta.
let lotesInteresEnEdicion = [];

// Etiquetas libres del contacto en edición — mismo criterio que
// lotesInteresEnEdicion (vive acá hasta guardar el formulario).
let etiquetasEnEdicion = [];

// Filtro de texto de la barra de herramientas (nombre o teléfono) — se
// aplica en el cliente sobre lo ya cargado, no perfora Firestore de nuevo
// por cada letra tipeada. filtroCalificacion/filtroEtiqueta son
// combinables con el texto y entre sí (ver contactosFiltrados).
let terminoBusqueda = "";
let filtroCalificacion = "";
let filtroEtiqueta = "";

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

  // Calificación (idea propia, ver calificacionContacto más arriba) —
  // en su propia línea, no adentro de la cabecera: un nombre largo no
  // tiene que competir por espacio con esto para no quedar cortado.
  const calificacion = calificacionContacto(contacto);
  if (calificacion) {
    const chip = document.createElement("p");
    chip.className = `crm-calificacion crm-calificacion-${calificacion.nivel}`;
    chip.textContent = calificacion.etiqueta;
    tarjeta.appendChild(chip);
  }

  const lotes = document.createElement("p");
  lotes.className = "crm-tarjeta-lotes";
  lotes.textContent = textoLotesResumen(contacto.lotes_interes || []);
  tarjeta.appendChild(lotes);

  // Etiquetas libres, como chips chicos — mismo criterio que Trello: se
  // leen de un vistazo sin tener que abrir el contacto.
  if ((contacto.etiquetas || []).length > 0) {
    const etiquetasEl = document.createElement("div");
    etiquetasEl.className = "crm-tarjeta-etiquetas";
    contacto.etiquetas.forEach((etiqueta) => {
      const chip = document.createElement("span");
      chip.className = "crm-tarjeta-etiqueta";
      chip.textContent = etiqueta;
      etiquetasEl.appendChild(chip);
    });
    tarjeta.appendChild(etiquetasEl);
  }

  // Última actividad en una línea (idea propia, mismo criterio que
  // Pipedrive/HubSpot: se lee de un vistazo qué fue lo último que pasó,
  // sin tener que abrir el contacto). Sin actividad todavía, no se
  // muestra nada acá — "Sin atender" (más abajo) ya cubre ese caso.
  const ultima = ultimaActividad(contacto);
  if (ultima) {
    const actividad = document.createElement("p");
    actividad.className = "crm-tarjeta-ultima-actividad";
    const textoCorto = ultima.texto && ultima.texto.length > 42 ? `${ultima.texto.slice(0, 42)}…` : ultima.texto;
    actividad.textContent = `${ETIQUETA_ACTIVIDAD[ultima.tipo] || ultima.tipo}${textoCorto ? `: ${textoCorto}` : ""}`;
    tarjeta.appendChild(actividad);
  }

  // Solo en "Todos": en "Mis contactos" siempre serías vos, no aporta
  // nada aclararlo tarjeta por tarjeta.
  if (modoVista === "todas") {
    const asignado = document.createElement("p");
    asignado.className = "crm-tarjeta-asignado";
    asignado.textContent = `👤 ${textoAsignado(contacto)}`;
    tarjeta.appendChild(asignado);
  }

  // "Sin atender" (rojo, más urgente) y "Sin novedades" (acento, más
  // suave) — investigado en Tokko Broker antes de armarlo ("controlar
  // los tiempos de atención"), ver comentario en estaSinAtender. Los dos
  // pueden convivir en teoría, pero en la práctica no: "sin atender"
  // exige actividades.length === 0 y estado "nuevo", "estancado" mide
  // silencio DESPUÉS de la primera gestión — se muestran igual como dos
  // chips independientes por si algún día cambia el criterio de alguno.
  const badgesUrgencia = [];
  if (estaSinAtender(contacto)) {
    badgesUrgencia.push({ clase: "crm-badge-sin-atender", texto: `Sin atender +${HORAS_SIN_ATENDER}h` });
  }
  if (estaEstancado(contacto)) {
    badgesUrgencia.push({ clase: "crm-badge-estancado", texto: `Sin novedades +${DIAS_ESTANCADO}d` });
  }
  if (badgesUrgencia.length > 0) {
    const badges = document.createElement("div");
    badges.className = "crm-tarjeta-badges";
    badgesUrgencia.forEach(({ clase, texto }) => {
      const badge = document.createElement("span");
      badge.className = clase;
      badge.textContent = texto;
      badges.appendChild(badge);
    });
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
  return contactos.filter((c) => {
    if (terminoBusqueda) {
      const coincideTexto =
        (c.nombre || "").toLowerCase().includes(terminoBusqueda) ||
        (c.telefono || "").toLowerCase().includes(terminoBusqueda);
      if (!coincideTexto) return false;
    }
    if (filtroCalificacion) {
      const calificacion = calificacionContacto(c);
      if (!calificacion || calificacion.nivel !== filtroCalificacion) return false;
    }
    if (filtroEtiqueta) {
      if (!(c.etiquetas || []).includes(filtroEtiqueta)) return false;
    }
    return true;
  });
}

// Opciones del filtro de etiquetas: la unión de todas las etiquetas que
// aparecen en los contactos ya cargados, ordenadas — se rearma cada vez
// que cambia la lista visible (no hace falta una colección aparte para
// "catálogo de etiquetas", son libres). Conserva la selección actual si
// sigue existiendo.
function poblarSelectFiltroEtiqueta() {
  const etiquetas = new Set();
  getContactosActuales().forEach((c) => (c.etiquetas || []).forEach((e) => etiquetas.add(e)));
  const opciones = [...etiquetas].sort((a, b) => a.localeCompare(b));
  elFiltroEtiqueta.innerHTML =
    `<option value="">Toda etiqueta</option>` + opciones.map((e) => `<option value="${e}">${e}</option>`).join("");
  elFiltroEtiqueta.value = opciones.includes(filtroEtiqueta) ? filtroEtiqueta : "";
  if (!opciones.includes(filtroEtiqueta)) filtroEtiqueta = "";
}

// Valor potencial de un contacto (idea propia, mismo lenguaje que
// Pipedrive/HubSpot: cada columna del pipeline muestra cuánto dinero
// representa, no solo cuántas tarjetas hay — "3 contactos" dice mucho
// menos que "3 contactos, USD 90.000"). Se suma el precio de cada lote
// de interés (los que tengan precio cargado; sin precio no aporta nada,
// no se inventa un valor). Puede sumar el mismo lote más de una vez
// entre distintos contactos — a propósito: cada uno es una oportunidad
// de venta independiente, no una reserva real todavía.
function valorPotencialContacto(contacto) {
  const lotesPorId = new Map(getLotesActuales().map((f) => [f.id, f.properties]));
  return (contacto.lotes_interes || []).reduce((total, l) => {
    const precio = lotesPorId.get(l.id)?.precio_usd;
    return total + (precio || 0);
  }, 0);
}

function formatoUsdCompacto(valor) {
  return valor > 0 ? `USD ${Math.round(valor).toLocaleString("es-AR")}` : null;
}

function renderKanban() {
  const contactos = getContactosActuales();
  const filtrados = contactosFiltrados();
  elVacio.classList.toggle("oculto", contactos.length > 0);
  elSinResultados.classList.toggle("oculto", contactos.length === 0 || filtrados.length > 0);
  elKanban.innerHTML = "";
  ETAPAS.forEach(({ clave, etiqueta, color }) => {
    const deEstaEtapa = filtrados.filter((c) => c.estado === clave);
    const valorColumna = deEstaEtapa.reduce((total, c) => total + valorPotencialContacto(c), 0);
    const columna = document.createElement("div");
    columna.className = "crm-columna";
    columna.dataset.testid = `crm-columna-${clave}`;
    columna.style.setProperty("--stage-color", color);

    const cabeceraColumna = document.createElement("div");
    cabeceraColumna.className = "crm-columna-cabecera";

    // Título + valor apilados en su propio grupo — así "space-between"
    // en la cabecera reparte contra el botón "+" nomás, no contra el
    // valor (que si no quedaría empujado lejos del título al que
    // pertenece).
    const grupoTitulo = document.createElement("div");
    grupoTitulo.className = "crm-columna-titulo-grupo";

    const titulo = document.createElement("p");
    titulo.className = "crm-columna-titulo";
    titulo.innerHTML = `<span class="crm-columna-dot"></span>${etiqueta} <span class="crm-columna-contador">${deEstaEtapa.length}</span>`;
    grupoTitulo.appendChild(titulo);

    const valorTexto = formatoUsdCompacto(valorColumna);
    if (valorTexto) {
      const valorEl = document.createElement("p");
      valorEl.className = "crm-columna-valor";
      valorEl.dataset.testid = `crm-columna-valor-${clave}`;
      valorEl.textContent = valorTexto;
      grupoTitulo.appendChild(valorEl);
    }
    cabeceraColumna.appendChild(grupoTitulo);

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
  const sinAtender = contactos.filter(estaSinAtender).length;
  // Solo lo que sigue en juego — cerrado ya se ganó, perdido ya se
  // perdió, ninguno de los dos es "pipeline" en el sentido de "todavía
  // por definir".
  const valorPipelineActivo = contactos
    .filter((c) => c.estado !== "cerrado" && c.estado !== "perdido")
    .reduce((total, c) => total + valorPotencialContacto(c), 0);
  return { total, nuevosEstaSemana, tasaConversion, estancados, sinAtender, valorPipelineActivo };
}

function renderStats() {
  const m = calcularMetricas(getContactosActuales());
  elStats.innerHTML = `
    <div class="crm-stat"><strong>${m.total}</strong><span>Contactos</span></div>
    <div class="crm-stat"><strong>${m.nuevosEstaSemana}</strong><span>Nuevos (7 días)</span></div>
    <div class="crm-stat"><strong>${m.tasaConversion == null ? "—" : `${m.tasaConversion}%`}</strong><span>Conversión a cerrado</span></div>
    <div class="crm-stat crm-stat-urgente"><strong>${m.sinAtender}</strong><span>Sin atender (+${HORAS_SIN_ATENDER}h)</span></div>
    <div class="crm-stat"><strong>${m.estancados}</strong><span>Estancados (+${DIAS_ESTANCADO}d)</span></div>
    <div class="crm-stat crm-stat-valor"><strong>${formatoUsdCompacto(m.valorPipelineActivo) || "—"}</strong><span>Valor en pipeline</span></div>
  `;
}

// "Automatización configurable" (idea propia — Tokko recién ofrece esto
// desde el plan Equipo, $252.320/mes): en vez de abrir cada contacto
// estancado uno por uno para marcarlo "perdido" a mano, un solo clic
// cierra a todos los que llevan +DIAS_ESTANCADO días sin novedades. Solo
// actúa sobre lo que el usuario ya puede ver (getContactosActuales() ya
// viene filtrado por "mias"/"todas", y firestore.rules igual rechazaría
// cualquier escritura sin permiso real) — no es una automatización
// server-side ("cron"), es un atajo manual configurable en el sentido de
// que el umbral (DIAS_ESTANCADO) es un solo número fácil de ajustar.
const MOTIVO_PERDIDO_AUTOMATICO = "Sin actividad reciente (cierre en bloque)";

function renderAutomatizacion() {
  const estancados = getContactosActuales().filter(estaEstancado);
  elAutomatizacion.classList.toggle("oculto", estancados.length === 0);
  if (estancados.length === 0) return;
  elAutomatizacionTexto.textContent =
    estancados.length === 1
      ? "1 contacto lleva más de una semana sin novedades."
      : `${estancados.length} contactos llevan más de una semana sin novedades.`;
}

async function marcarEstancadosComoPerdidos() {
  const estancados = getContactosActuales().filter(estaEstancado);
  if (estancados.length === 0) return;
  const confirmado = window.confirm(
    `¿Marcar ${estancados.length === 1 ? "el contacto estancado" : `los ${estancados.length} contactos estancados`} como perdidos? No se puede deshacer.`
  );
  if (!confirmado) return;

  const ahora = new Date().toISOString();
  let fallidos = 0;
  for (const contacto of estancados) {
    const estadoAnterior = contacto.estado;
    try {
      await updateDoc(doc(db, COLECCION_CONTACTOS, contacto.id), {
        estado: "perdido",
        motivo_perdido: MOTIVO_PERDIDO_AUTOMATICO,
        fecha_actualizacion: ahora
      });
      contacto.estado = "perdido";
      contacto.motivo_perdido = MOTIVO_PERDIDO_AUTOMATICO;
      contacto.fecha_actualizacion = ahora;
      registrarAuditoria({
        accion: "mover_contacto",
        objetoId: contacto.id,
        objetoTitulo: contacto.nombre,
        detalle: `${ETIQUETA_ETAPA[estadoAnterior] || estadoAnterior} → ${ETIQUETA_ETAPA.perdido} (${MOTIVO_PERDIDO_AUTOMATICO})`
      });
    } catch {
      // Uno fallando (permiso, red) no debe frenar al resto — se cuenta
      // y se avisa al final, mismo criterio que moverContacto pero sin
      // revertir nada acá: los que sí se aplicaron quedan aplicados.
      fallidos++;
    }
  }
  renderTodo();
  if (fallidos > 0) {
    window.alert(`Se marcaron ${estancados.length - fallidos} de ${estancados.length}. ${fallidos} no se pudieron actualizar.`);
  }
}

// "Rendimiento por corredor" (idea propia, investigada en Tokko Broker
// antes de armarla — "Métricas de negocio... performance de tu
// equipo"). Solo tiene sentido en "Todos": en "Mis contactos" ya es
// obvio de quién son (las tarjetas de arriba alcanzan), comparar contra
// nadie no aporta nada.
function renderRendimientoPorCorredor() {
  const enTodas = modoVista === "todas";
  elRendimientoSeccion.classList.toggle("oculto", !enTodas);
  if (!enTodas) return;

  const contactos = getContactosActuales();
  const porUid = new Map();
  contactos.forEach((c) => {
    const uid = c.asignado_a || "__sin_asignar__";
    if (!porUid.has(uid)) porUid.set(uid, []);
    porUid.get(uid).push(c);
  });

  const filas = [...porUid.entries()]
    .map(([uid, propios]) => {
      const cerrados = propios.filter((c) => c.estado === "cerrado").length;
      const sinAtender = propios.filter(estaSinAtender).length;
      const tasa = propios.length > 0 ? Math.round((cerrados / propios.length) * 100) : 0;
      const nombreCorredor =
        uid === "__sin_asignar__" ? "Sin asignar" : uid === auth.currentUser?.uid ? "Vos" : usuariosPorUid?.[uid] || uid;
      return { nombreCorredor, total: propios.length, cerrados, tasa, sinAtender };
    })
    .sort((a, b) => b.total - a.total);

  elRendimientoCuerpo.innerHTML = filas
    .map(
      (f) =>
        `<tr><td>${f.nombreCorredor}</td><td>${f.total}</td><td>${f.cerrados}</td><td>${f.tasa}%</td><td>${f.sinAtender > 0 ? `<span class="crm-badge-sin-atender">${f.sinAtender}</span>` : "0"}</td></tr>`
    )
    .join("");
}

// ---------------------------------------------------------------------------
// Seguimientos: recordatorios vencidos o próximos, mismo lenguaje visual
// que "Reservas por vencer" del Dashboard (reusa .dashboard-lista/
// .dashboard-badge).
// ---------------------------------------------------------------------------

// Exportada: dashboard.js reusa exactamente el mismo criterio de "qué
// cuenta como pendiente" para su resumen — evita que las dos pantallas
// se desincronicen si el criterio cambia (por ejemplo, el techo de
// DIAS_SEGUIMIENTO_PROXIMO) y una queda vieja.
export function contactosParaSeguimiento(contactos) {
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
  renderAutomatizacion();
  renderRendimientoPorCorredor();
  renderSeguimientos();
  poblarSelectFiltroEtiqueta();
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
// Etiquetas libres (dentro del formulario de alta/edición) — mismo
// patrón visual que "Lotes de interés" (chip + quitar), pero de texto
// libre en vez de un <select> con catálogo fijo.
// ---------------------------------------------------------------------------

function renderListaEtiquetas() {
  elListaEtiquetas.innerHTML = "";
  etiquetasEnEdicion.forEach((etiqueta) => {
    const li = document.createElement("li");
    li.className = "crm-chip-lote";

    const texto = document.createElement("span");
    texto.className = "crm-chip-etiqueta-texto";
    texto.textContent = etiqueta;
    li.appendChild(texto);

    const botonQuitar = document.createElement("button");
    botonQuitar.type = "button";
    botonQuitar.className = "crm-chip-quitar";
    botonQuitar.textContent = "×";
    botonQuitar.setAttribute("aria-label", `Quitar etiqueta ${etiqueta}`);
    botonQuitar.addEventListener("click", () => {
      etiquetasEnEdicion = etiquetasEnEdicion.filter((e) => e !== etiqueta);
      renderListaEtiquetas();
    });
    li.appendChild(botonQuitar);

    elListaEtiquetas.appendChild(li);
  });
  elEtiquetasVacio.classList.toggle("oculto", etiquetasEnEdicion.length > 0);
}

function agregarEtiquetaDesdeInput() {
  const valor = elInputEtiqueta.value.trim();
  if (!valor) return;
  // Comparación sin mayúsculas/minúsculas para no juntar "Urgente" y
  // "urgente" como dos etiquetas distintas — se guarda tal cual se
  // escribió la primera vez.
  const yaExiste = etiquetasEnEdicion.some((e) => e.toLowerCase() === valor.toLowerCase());
  if (!yaExiste) {
    etiquetasEnEdicion.push(valor);
    renderListaEtiquetas();
  }
  elInputEtiqueta.value = "";
  elInputEtiqueta.focus();
}

elBtnAgregarEtiqueta.addEventListener("click", agregarEtiquetaDesdeInput);
elInputEtiqueta.addEventListener("keydown", (evento) => {
  // Enter agrega la etiqueta en vez de mandar el formulario entero —
  // mismo criterio que cualquier campo de "chips" (Gmail, Notion, etc.).
  if (evento.key === "Enter") {
    evento.preventDefault();
    agregarEtiquetaDesdeInput();
  }
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
  etiquetasEnEdicion = contacto ? [...(contacto.etiquetas || [])] : [];
  renderListaEtiquetas();
  elInputEtiqueta.value = "";
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
    elCrmFusionar.classList.remove("oculto");
  } else {
    elIdEditando.value = "";
    elFormTitulo.textContent = "Nuevo contacto";
    elEstado.value = estadoInicial || "nuevo";
    elMotivoPerdido.value = "";
    elSeguimientoInput.value = "";
    elBtnBorrarContacto.classList.add("oculto");
    elCrmFusionar.classList.add("oculto");
  }
  elCrmFusionarPanel.classList.add("oculto"); // por si había quedado abierto del contacto anterior
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
    etiquetas: etiquetasEnEdicion,
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

// "Fusionar con otro contacto" — cubre el hueco de deduplicación manual
// (hoy solo hay dedupe automático por teléfono EXACTO al crear desde
// "Agregar interesado" en la ficha; esto es para el resto de los casos:
// alguien cargado dos veces a mano, con el teléfono escrito distinto,
// etc.). El contacto que se está editando ("este") es el que queda; el
// elegido en el <select> se combina adentro y se borra — no al revés,
// para que sea obvio cuál sobrevive sin tener que leer dos veces.
elBtnFusionarContacto.addEventListener("click", () => {
  const idEditando = elIdEditando.value;
  if (!idEditando) return;
  const opciones = getContactosActuales()
    .filter((c) => c.id !== idEditando)
    .sort((a, b) => a.nombre.localeCompare(b.nombre));
  if (opciones.length === 0) {
    window.alert("No hay otro contacto para fusionar acá.");
    return;
  }
  elCrmFusionarSelect.innerHTML = opciones.map((c) => `<option value="${c.id}">${c.nombre}</option>`).join("");
  elCrmFusionarPanel.classList.remove("oculto");
});

elBtnFusionarCancelar.addEventListener("click", () => {
  elCrmFusionarPanel.classList.add("oculto");
});

elBtnFusionarConfirmar.addEventListener("click", async () => {
  const idEditando = elIdEditando.value;
  const idDuplicado = elCrmFusionarSelect.value;
  if (!idEditando || !idDuplicado) return;
  const actual = getContactosActuales().find((c) => c.id === idEditando);
  const duplicado = getContactosActuales().find((c) => c.id === idDuplicado);
  if (!actual || !duplicado) return;
  if (
    !window.confirm(
      `¿Fusionar "${duplicado.nombre}" dentro de "${actual.nombre}"? Se combina el interés y la actividad de los dos, y "${duplicado.nombre}" se borra. No se puede deshacer.`
    )
  )
    return;

  elBtnFusionarConfirmar.disabled = true;
  try {
    const lotesFusionados = [...(actual.lotes_interes || [])];
    (duplicado.lotes_interes || []).forEach((l) => {
      if (!lotesFusionados.some((existente) => existente.id === l.id)) lotesFusionados.push(l);
    });
    const etiquetasFusionadas = [...(actual.etiquetas || [])];
    (duplicado.etiquetas || []).forEach((e) => {
      if (!etiquetasFusionadas.some((existente) => existente.toLowerCase() === e.toLowerCase())) {
        etiquetasFusionadas.push(e);
      }
    });
    const ahora = new Date().toISOString();
    const actividadFusion = {
      tipo: "nota",
      texto: `Fusionado con "${duplicado.nombre}"${duplicado.telefono ? ` (tel. ${duplicado.telefono})` : ""}.`,
      fecha: ahora,
      autor_email: auth.currentUser?.email || null
    };
    const datos = {
      telefono: actual.telefono || duplicado.telefono || null,
      email: actual.email || duplicado.email || null,
      // La más próxima de las dos, no la del contacto que sobrevive porque
      // sí — un seguimiento ya agendado en el duplicado no debería
      // perderse solo por estar del lado que se borra.
      proximo_seguimiento:
        [actual.proximo_seguimiento, duplicado.proximo_seguimiento].filter(Boolean).sort()[0] || null,
      lotes_interes: lotesFusionados,
      etiquetas: etiquetasFusionadas,
      actividades: [...(actual.actividades || []), ...(duplicado.actividades || []), actividadFusion],
      fecha_creacion: [actual.fecha_creacion, duplicado.fecha_creacion].filter(Boolean).sort()[0] || actual.fecha_creacion,
      fecha_actualizacion: ahora
    };
    await updateDoc(doc(db, COLECCION_CONTACTOS, idEditando), datos);
    await deleteDoc(doc(db, COLECCION_CONTACTOS, idDuplicado));
    registrarAuditoria({
      accion: "editar_contacto",
      objetoId: idEditando,
      objetoTitulo: actual.nombre,
      detalle: `Fusionado con "${duplicado.nombre}"`
    });
    await cargarContactos();
    renderTodo();
    const fusionado = getContactosActuales().find((c) => c.id === idEditando);
    mostrarForm(fusionado || null);
  } catch (error) {
    window.alert(
      error.code === "permission-denied" ? "No tenés permiso para editar estos contactos." : "No se pudo fusionar."
    );
  } finally {
    elBtnFusionarConfirmar.disabled = false;
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

elFiltroCalificacion.addEventListener("change", () => {
  filtroCalificacion = elFiltroCalificacion.value;
  renderKanban();
});

elFiltroEtiqueta.addEventListener("change", () => {
  filtroEtiqueta = elFiltroEtiqueta.value;
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
elBtnCerrarEstancados.addEventListener("click", marcarEstancadosComoPerdidos);

// ---------------------------------------------------------------------------
// Apertura/cierre del panel.
// ---------------------------------------------------------------------------

// Factoreado del click de "CRM" en el drawer para poder abrir el panel
// también desde otro lado (dashboard.js, "Seguimientos pendientes") sin
// duplicar el cierre de los otros paneles + reset a "Mis contactos".
async function abrirPanelCrm() {
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
  elFiltroCalificacion.value = "";
  filtroCalificacion = "";
  filtroEtiqueta = ""; // el <select> se repuebla en renderTodo() más abajo

  // Se precarga acá (no solo al pasar a "Todos") para que el <select>
  // "Asignado a" del formulario ya tenga los corredores listos aunque el
  // manager nunca haya tocado el toggle — reasignar un contacto propio
  // desde "Mis contactos" tiene que andar igual.
  if (puedeVerTodosLosContactos()) await obtenerUsuariosPorUid();

  await cargarContactos();
  renderTodo();
}

elBtnAbrir.addEventListener("click", abrirPanelCrm);

// dashboard.js llama esto al tocar una fila de "Seguimientos pendientes"
// — abre el CRM directo en el formulario de ESE contacto, en vez de
// dejar que lo busque a mano en el kanban. Si el contacto ya no está en
// el modo de vista actual ("Mis contactos" pero es de otro corredor, por
// ejemplo un caso raro de reasignación reciente) se abre igual el panel,
// sin el formulario — mejor eso que romper.
export async function abrirContactoEnCrm(contactoId) {
  await abrirPanelCrm();
  const contacto = getContactosActuales().find((c) => c.id === contactoId);
  if (contacto) mostrarForm(contacto);
}

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
