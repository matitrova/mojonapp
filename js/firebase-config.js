// ---------------------------------------------------------------------------
// Inicializa Firebase con el proyecto que corresponde al dominio desde el
// que se sirvió la app. Qué proyecto le toca a cada dominio lo decide
// js/firebase-proyecto.js — acá solo se inicializa.
//
//   mojonapp.com.ar            -> producción (datos del cliente)
//   preview.mojonapp.pages.dev -> pruebas (desechable)
//   localhost                  -> pruebas
//
// POR QUÉ EXISTE ESTA SEPARACIÓN. Cloudflare Pages publica una vista
// previa por cada rama, que sirve exactamente los archivos del repo. Con
// un solo proyecto fijo, esa vista previa escribía en la base de
// PRODUCCIÓN: servía para mirar cómo quedó un cambio, pero entrar y crear
// un contacto tocaba los datos reales del cliente. Justo lo que no se
// espera de una URL de test, y encima invita a tocar. Lo mismo pasaba
// abriendo la app en local.
// ---------------------------------------------------------------------------

import { initializeApp } from "https://www.gstatic.com/firebasejs/12.18.0/firebase-app.js";
import {
  initializeFirestore,
  persistentLocalCache,
  persistentMultipleTabManager
} from "https://www.gstatic.com/firebasejs/12.18.0/firebase-firestore.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/12.18.0/firebase-auth.js";
import { configPara, esDominioDeProduccion } from "./firebase-proyecto.js";

const firebaseConfig = configPara(location.hostname);

// Queda dicho en la consola del navegador a qué base se conectó. Es la
// forma de confirmar de un vistazo, desde una vista previa, que no está
// tocando los datos del cliente.
console.info(
  `MojonApp: Firebase "${firebaseConfig.projectId}"` +
    (esDominioDeProduccion(location.hostname)
      ? " (PRODUCCIÓN: datos reales)"
      : " (base de pruebas: se puede romper)")
);

// LA CACHÉ NO ES UNA OPTIMIZACIÓN, ES LO QUE EVITA EL 429. Firestore
// cobra POR DOCUMENTO leído del servidor, 50.000 por día en el plan
// gratuito, y la app trae la cartera entera en cada carga de página.
// Medido el 2026-09-25: 9 lecturas con 8 lotes, pero con 180 son 181 por
// carga — o sea 276 cargas al día para TODA la agencia antes de que la
// app empiece a responder 429 a los clientes. Y desde que el catálogo y
// las páginas de lote son públicas, cada comprador que abre un link
// también las paga: un link que circula por un grupo de WhatsApp puede
// dejar la app caída.
//
// Con caché persistente y escucha viva (ver cargarLotesDesdeFirestore en
// js/mapa.js), la primera carga paga los N lotes y las siguientes solo
// pagan lo que CAMBIÓ: el SDK guarda un token y le pide al servidor
// nada más que las novedades.
//
// persistentMultipleTabManager porque un corredor tiene la app abierta
// en varias pestañas: sin esto, la segunda pestaña no puede usar la
// caché y vuelve a pagar todo.
const app = initializeApp(firebaseConfig);
export const db = initializeFirestore(app, {
  localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() })
});
export const auth = getAuth(app);
// Se reexporta el config para el panel de administración: dar de alta un
// corredor nuevo levanta una segunda instancia de Firebase App/Auth en
// memoria (initializeApp(firebaseConfig, "alta-...")) para que crear esa
// cuenta no pise la sesión de quien la está creando.
export { firebaseConfig };
