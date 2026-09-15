// ---------------------------------------------------------------------------
// CRM — capa de datos: todo lo que habla con Firestore para el pipeline
// de contactos (cargar, dar de alta desde "Agregar interesado", caché de
// usuarios, a quién asignar un interesado nuevo). Nada de DOM acá.
//
// Segunda etapa de la modularización de crm.js (ver el plan en curso,
// mismo criterio que la primera con crm-metricas.js) — separar la lectura/
// escritura de Firestore de la UI que la usa, para que cada una se pueda
// entender (y probar) sin la otra.
// ---------------------------------------------------------------------------

import { db, auth } from "./firebase-config.js";
import {
  collection,
  doc,
  getDocs,
  addDoc,
  updateDoc,
  arrayUnion,
  query,
  where,
  limit
} from "https://www.gstatic.com/firebasejs/12.18.0/firebase-firestore.js";
import { setContactosActuales, getModoVista } from "./estado.js";
import { esRootActual, tienePermiso } from "./permisos.js";
import { elegirMenosCargado } from "./crm-metricas.js";

export const COLECCION_CONTACTOS = "contactos";

// Techo de lo que se le pide a Firestore de una sola vez: una consulta sin
// límite crece en costo (y en tiempo de carga) al mismo ritmo que la
// cartera — con esto, aunque la agencia llegue a tener miles de contactos
// algún día, abrir el CRM sigue siendo una sola lectura acotada. 500
// contactos activos es un techo cómodo para una inmobiliaria chica/mediana
// durante años, no un límite real del día a día.
const LIMITE_CONTACTOS = 500;

export function puedeVerTodosLosContactos() {
  return esRootActual() || tienePermiso("ver_todos_los_contactos");
}

// `tituloLote` lo recibe este módulo por parámetro en vez de importar
// ficha.js/mapa.js directo, igual criterio que crm.js con `configurarCrm`
// — evita cualquier riesgo de ciclo entre esta capa de datos y la UI.
let tituloLote;
export function configurarDatosCrm(deps) {
  ({ tituloLote } = deps);
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
      // creado_por siempre es quien realmente está cargando el
      // interesado (lo exige firestore.rules) — asignado_a es lo que
      // reparte el round-robin, puede terminar siendo otro corredor.
      asignado_a: (await siguienteAsignado()) || auth.currentUser.uid,
      creado_por: auth.currentUser.uid,
      // "Origen del lead" (idea propia — versión gratis de la
      // "centralización de leads" de Tokko, sin canales pagos: saber si
      // un contacto salió de mirar un lote puntual o de un alta manual
      // en el CRM ya dice algo real sobre qué genera consultas). Se fija
      // solo, nunca se le pide nada a nadie.
      origen: "ficha",
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
// ("mias" | "todas", en estado.js — lo necesita también la UI, ver
// getModoVista/setModoVista). Se ordena en el cliente por última
// actualización en vez de con orderBy() en la consulta a propósito:
// combinar where("asignado_a",...) con orderBy("fecha_actualizacion")
// pediría un índice compuesto, y este proyecto no tiene Firebase CLI para
// crearlo por código — solo a mano en la Consola. Ordenar acá evita esa
// dependencia sin perder la función.
// ---------------------------------------------------------------------------

export async function cargarContactos() {
  try {
    const verTodas = getModoVista() === "todas" && puedeVerTodosLosContactos();
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

export async function obtenerUsuariosPorUid() {
  if (usuariosPorUid) return usuariosPorUid;
  try {
    const snapshot = await getDocs(collection(db, "usuarios"));
    usuariosPorUid = Object.fromEntries(snapshot.docs.map((d) => [d.id, d.data().email || d.id]));
  } catch {
    usuariosPorUid = {};
  }
  return usuariosPorUid;
}

// Lectura sincrónica del cache ya resuelto, para la UI que necesita el
// mapa completo (no solo el email de un contacto puntual como
// textoAsignado) y solo tiene sentido llamarla con el cache ya poblado
// (ver obtenerUsuariosPorUid más arriba) — devuelve {} si todavía no se
// pobló, nunca null, para no obligar a cada consumidor a chequearlo.
export function obtenerUsuariosPorUidCache() {
  return usuariosPorUid || {};
}

// Reparto automático de interesados nuevos entre el equipo (idea de
// Tokko: "asignación automática de consultas") — SOLO para
// crearContactoDesdeInteresado (un interesado nuevo agregado desde la
// ficha de un lote), no para "+ Nuevo contacto" del CRM (esa es una
// carga deliberada de quien la hace, tiene sentido que quede asignada a
// esa persona). Reparte por CARGA actual (a quien menos contactos
// activos tiene ahora mismo) en vez de una cola estricta con puntero
// guardado aparte — no necesita una colección/regla nueva en
// firestore.rules (que habría que pegar a mano en la Consola, ver
// mojonapp_estado_proyecto), se auto-corrige solo si alguien está de
// licencia, y con 1-2 corredores el resultado es el mismo de sentido
// común: le toca al que tiene menos en danza. `elegirMenosCargado` (la
// parte que realmente importa que ande bien) vive en crm-metricas.js,
// sin Firestore.
async function siguienteAsignado() {
  const usuarios = await obtenerUsuariosPorUid();
  const uids = Object.keys(usuarios);
  if (uids.length <= 1) return auth.currentUser?.uid || null;

  const snapshot = await getDocs(collection(db, COLECCION_CONTACTOS));
  const cargaPorUid = Object.fromEntries(uids.map((uid) => [uid, 0]));
  snapshot.docs.forEach((d) => {
    const datos = d.data();
    if (datos.estado === "cerrado" || datos.estado === "perdido") return;
    if (cargaPorUid[datos.asignado_a] != null) cargaPorUid[datos.asignado_a]++;
  });
  return elegirMenosCargado(cargaPorUid);
}

// "Vos" para lo propio, el email real para lo ajeno, o un texto genérico
// si por lo que sea no se pudo resolver (corredor borrado después, cache
// todavía sin poblar). Solo tiene sentido llamarlo con el cache ya
// poblado (ver cambiarModoVista en crm.js) — sin eso, cualquier contacto
// ajeno mostraría el genérico hasta el próximo render.
export function textoAsignado(contacto) {
  if (!contacto.asignado_a) return "Sin asignar";
  if (contacto.asignado_a === auth.currentUser?.uid) return "Vos";
  return usuariosPorUid?.[contacto.asignado_a] || "Otro corredor";
}
