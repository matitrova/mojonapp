// ---------------------------------------------------------------------------
// Permisos: quién puede qué. Todo lo que decide acá es solo para mostrar
// u ocultar botones — el permiso real lo hacen cumplir las reglas de
// Firestore (firestore.rules), que repiten esta misma lógica del lado
// del servidor. Si algo queda mal escondido acá, Firestore igual lo
// rechaza.
//
// Módulo chico y sin acoplamiento (solo depende de getMiPerfil() y de
// `auth`, dos leaf dependencies), pero lo usan Mapa, Ficha, Vista en
// lista y la sección de sesión — por eso se separó de app.js en vez de
// quedar enterrado adentro de cualquiera de esos módulos.
// ---------------------------------------------------------------------------

import { auth } from "./firebase-config.js";
import { getMiPerfil } from "./estado.js";

export function esRootActual() {
  const perfil = getMiPerfil();
  return !!perfil && perfil.es_root === true;
}

export function tienePermiso(clave) {
  const perfil = getMiPerfil();
  if (!perfil) return false;
  if (perfil.es_root) return true;
  return perfil.permisos?.[clave] === true;
}

export function esDuenoDelLote(feature) {
  return !!auth.currentUser && feature.properties.creado_por === auth.currentUser.uid;
}

export function puedeEditarLote(feature) {
  if (esRootActual()) return true;
  return esDuenoDelLote(feature) ? tienePermiso("editar_lote_propio") : tienePermiso("editar_lote_ajeno");
}

export function puedeBorrarLote(feature) {
  if (esRootActual()) return true;
  return esDuenoDelLote(feature) ? tienePermiso("borrar_lote_propio") : tienePermiso("borrar_lote_ajeno");
}
