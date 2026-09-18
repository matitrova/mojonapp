// ---------------------------------------------------------------------------
// A qué proyecto Firebase le corresponde cada dominio.
//
// Este módulo es SOLO la decisión, sin efectos: no inicializa nada, no
// toca la red. La inicialización vive en js/firebase-config.js, que lo
// importa. Están separados por dos motivos:
//
//   1. Es la pieza de código que decide si la app escribe en los datos
//      del cliente o en una base desechable. Aislada y pura, se puede
//      testear con cualquier dominio sin levantar la app entera —
//      incluidos los .pages.dev, que un navegador fuerza a HTTPS (.dev
//      es un TLD con HSTS preload) y por eso no se pueden simular contra
//      un servidor local.
//   2. scripts/servidor_dev.py reemplaza firebase-config.js para fijarle
//      un proyecto a la suite de tests. Al estar la decisión acá, ese
//      reemplazo no la tapa y sigue siendo verificable.
//
// Nada de lo que hay acá es secreto: estos valores viajan en el
// JavaScript que cualquiera puede leer desde el navegador. La seguridad
// real la dan las reglas de Firestore/Auth (ver firestore.rules).
// ---------------------------------------------------------------------------

export const CONFIG_PRODUCCION = {
  apiKey: "AIzaSyCR9w0fwXixk4CZV051-srq9PsTvmp5lGQ",
  authDomain: "mojonapp.firebaseapp.com",
  projectId: "mojonapp",
  storageBucket: "mojonapp.firebasestorage.app",
  messagingSenderId: "429408050490",
  appId: "1:429408050490:web:0d977ce145c87264958403"
};

export const CONFIG_PRUEBAS = {
  apiKey: "AIzaSyB__xAdgt7BR38JLCRS_E8Zy_JoZYbdeVs",
  authDomain: "mojonapptest.firebaseapp.com",
  projectId: "mojonapptest",
  storageBucket: "mojonapptest.firebasestorage.app",
  messagingSenderId: "282976322865",
  appId: "1:282976322865:web:ce4be37265b343391edc10"
};

// LA LISTA ES DE PRODUCCIÓN, NO DE LAS VISTAS PREVIAS, Y ESO ES A
// PROPÓSITO. Si la regla fuera "si el dominio parece una vista previa usá
// pruebas, si no producción", cualquier dominio inesperado —uno nuevo, un
// typo, una IP— se conectaría EN SILENCIO a los datos del cliente. Al
// revés, un dominio inesperado cae en pruebas y la app se ve vacía: un
// error a la vista en lugar de una corrupción callada.
//
// "mojonapp.pages.dev" es el alias que Cloudflare Pages le da a la rama
// de producción, así que cuenta como producción. Las vistas previas usan
// otros subdominios del mismo dominio ("preview.mojonapp.pages.dev", y
// uno por cada deploy con el hash del commit), y esos NO están acá.
//
// SI AGREGÁS UN DOMINIO NUEVO de producción, tenés que sumarlo acá o ese
// dominio va a mostrar la base de pruebas.
export const DOMINIOS_DE_PRODUCCION = [
  "mojonapp.com.ar",
  "www.mojonapp.com.ar",
  "mojonapp.pages.dev"
];

export function esDominioDeProduccion(hostname) {
  return DOMINIOS_DE_PRODUCCION.includes(hostname);
}

export function configPara(hostname) {
  return esDominioDeProduccion(hostname) ? CONFIG_PRODUCCION : CONFIG_PRUEBAS;
}
