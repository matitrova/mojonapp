// ---------------------------------------------------------------------------
// Modo "Estoy yendo": geolocalización en vivo + flecha tipo brújula.
// ---------------------------------------------------------------------------

import { puntoDentroDePoligono, centroideDePoligono, distanciaMetros, rumboInicial } from "./geometria.js";
import {
  getLoteSeleccionado,
  getWatchId,
  setWatchId,
  getListenerOrientacion,
  setListenerOrientacion
} from "./estado.js";

const elPanelNav = document.getElementById("panel-navegacion");
const elFlecha = document.getElementById("brujula-flecha");
const elNavMensaje = document.getElementById("nav-mensaje");

let rumboHaciaLote = 0;
let rumboDispositivo = null; // null = sin brújula del dispositivo disponible

function actualizarFlecha() {
  // Si hay brújula del dispositivo, la flecha apunta al lote en relación a
  // hacia dónde está mirando el teléfono. Si no, apunta al rumbo absoluto
  // (asumiendo el teléfono "hacia arriba" = norte).
  const rotacion = rumboDispositivo === null ? rumboHaciaLote : rumboHaciaLote - rumboDispositivo;
  elFlecha.style.transform = `rotate(${rotacion}deg)`;
}

function manejarPosicion(posicion) {
  if (!getLoteSeleccionado()) return;
  const { latitude: latUsuario, longitude: lonUsuario } = posicion.coords;
  const anillo = getLoteSeleccionado().geometry.coordinates[0];

  if (puntoDentroDePoligono(latUsuario, lonUsuario, anillo)) {
    elNavMensaje.textContent = "Estás dentro del lote.";
    elFlecha.style.transform = "rotate(0deg)";
    return;
  }

  const { lat: latLote, lon: lonLote } = centroideDePoligono(anillo);
  const distancia = distanciaMetros(latUsuario, lonUsuario, latLote, lonLote);
  rumboHaciaLote = rumboInicial(latUsuario, lonUsuario, latLote, lonLote);

  elNavMensaje.textContent = `${Math.round(distancia)} m hasta el lote`;
  actualizarFlecha();
}

function manejarErrorGeolocalizacion(error) {
  if (error.code === error.PERMISSION_DENIED) {
    elNavMensaje.textContent =
      "No pudimos acceder a tu ubicación. Habilitá el permiso de ubicación del navegador e intentá de nuevo.";
  } else {
    elNavMensaje.textContent = "No se pudo obtener tu ubicación en este momento.";
  }
}

function manejarOrientacion(evento) {
  // iOS Safari expone el rumbo real (grados desde el norte) en webkitCompassHeading.
  // El resto de los navegadores da "alpha", que crece en sentido antihorario desde
  // el eje del dispositivo: 360 - alpha lo aproxima a un rumbo brújula estándar
  // cuando el evento es "absolute" (referenciado al mundo, no al estado inicial).
  if (typeof evento.webkitCompassHeading === "number") {
    rumboDispositivo = evento.webkitCompassHeading;
  } else if (evento.absolute && evento.alpha !== null) {
    rumboDispositivo = (360 - evento.alpha) % 360;
  } else {
    return;
  }
  actualizarFlecha();
}

function iniciarBrujulaDispositivo() {
  const EventoOrientacion = window.DeviceOrientationEvent;
  if (!EventoOrientacion) return;

  setListenerOrientacion(manejarOrientacion);

  if (typeof EventoOrientacion.requestPermission === "function") {
    // iOS 13+: pedir permiso explícito, solo se puede llamar desde un gesto del usuario.
    EventoOrientacion.requestPermission()
      .then((estado) => {
        if (estado === "granted") {
          window.addEventListener("deviceorientation", getListenerOrientacion());
        }
      })
      .catch(() => {
        // Sin brújula del dispositivo: la flecha sigue funcionando con rumbo absoluto.
      });
  } else {
    window.addEventListener("deviceorientationabsolute", getListenerOrientacion());
    window.addEventListener("deviceorientation", getListenerOrientacion());
  }
}

function iniciarModoEstoyYendo() {
  if (!getLoteSeleccionado()) return;

  elPanelNav.classList.remove("oculto");
  elNavMensaje.textContent = "Buscando tu ubicación…";
  rumboDispositivo = null;

  if (!navigator.geolocation) {
    elNavMensaje.textContent = "Este navegador no soporta geolocalización.";
    return;
  }

  setWatchId(
    navigator.geolocation.watchPosition(manejarPosicion, manejarErrorGeolocalizacion, {
      enableHighAccuracy: true,
      maximumAge: 2000,
      timeout: 10000
    })
  );

  iniciarBrujulaDispositivo();
}

function detenerModoEstoyYendo() {
  elPanelNav.classList.add("oculto");
  if (getWatchId() !== null) {
    navigator.geolocation.clearWatch(getWatchId());
    setWatchId(null);
  }
  if (getListenerOrientacion()) {
    window.removeEventListener("deviceorientation", getListenerOrientacion());
    window.removeEventListener("deviceorientationabsolute", getListenerOrientacion());
    setListenerOrientacion(null);
  }
}

// Cablea los botones de "Estoy yendo" — se llama una vez desde app.js al
// arrancar la app (mismo patrón que el resto de los módulos de UI).
export function iniciarEstoyYendo() {
  document.getElementById("btn-estoy-yendo").addEventListener("click", iniciarModoEstoyYendo);
  document.getElementById("cerrar-navegacion").addEventListener("click", detenerModoEstoyYendo);
}
