// ---------------------------------------------------------------------------
// "Pegar mail de portal" — el corredor pega la consulta que le llegó por
// mail desde ZonaProp/MercadoLibre/Argenprop y sale un contacto del CRM
// con los datos ya cargados, listo para revisar y guardar.
//
// El mail NO entra solo (ver el comentario largo en
// functions/ia-lead.js: la entrada automática necesita un Email Worker,
// CLI de por medio y tocar los MX del dominio). La etiqueta de la app y
// del panel de IA dicen "pegar el mail", no "automático", a propósito:
// en una demo, prometer de más se paga caro.
//
// Igual que ia-descripcion.js, acá no hay ninguna API key ni ninguna
// llamada a un proveedor: solo un fetch a nuestro propio endpoint, que
// exige un token de sesión válido.
//
// Este módulo no guarda nada: le pasa los datos al formulario de
// contacto (mostrarFormConLead en crm-formulario.js) y ahí sigue el
// mismo flujo de siempre — revisar, completar el lote de interés,
// Guardar. Un contacto creado por IA sin que nadie lo mire sería la
// forma rápida de llenar el pipeline de basura.
// ---------------------------------------------------------------------------

import { auth } from "./firebase-config.js";
import { mostrarFormConLead } from "./crm-formulario.js";

const elBtnAbrir = document.getElementById("btn-pegar-mail");
const elBloque = document.getElementById("crm-pegar-mail");
const elTexto = document.getElementById("crm-pegar-mail-texto");
const elBtnConvertir = document.getElementById("btn-convertir-mail");
const elBtnCancelar = document.getElementById("btn-cancelar-pegar-mail");
const elMensaje = document.getElementById("crm-pegar-mail-mensaje");

function mostrarMensaje(texto) {
  elMensaje.textContent = texto;
  elMensaje.classList.remove("oculto");
}

function cerrarBloque() {
  elBloque.classList.add("oculto");
  elTexto.value = "";
  elMensaje.classList.add("oculto");
}

elBtnAbrir.addEventListener("click", () => {
  elMensaje.classList.add("oculto");
  elBloque.classList.remove("oculto");
  elTexto.focus();
});

elBtnCancelar.addEventListener("click", cerrarBloque);

elBtnConvertir.addEventListener("click", async () => {
  const mail = elTexto.value.trim();
  if (!mail) {
    mostrarMensaje("Pegá el texto del mail primero.");
    return;
  }

  if (!auth.currentUser) {
    mostrarMensaje("Tenés que iniciar sesión para usar esto.");
    return;
  }

  // Mismo criterio que "Redactar con IA": mientras dura la llamada el
  // botón queda deshabilitado y lo dice, para que nadie la dispare tres
  // veces creyendo que no pasó nada.
  const textoOriginal = elBtnConvertir.textContent;
  elBtnConvertir.disabled = true;
  elBtnConvertir.textContent = "Leyendo…";
  elMensaje.classList.add("oculto");

  try {
    const idToken = await auth.currentUser.getIdToken();
    const respuesta = await fetch("/ia-lead", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ idToken, mail })
    });
    const datos = await respuesta.json();

    if (!respuesta.ok) {
      mostrarMensaje(datos.error || "No se pudo leer el mail.");
      return;
    }

    // El bloque se cierra recién con el formulario ya abierto: si algo
    // fallara en el medio, el texto pegado seguiría ahí en vez de
    // perderse y tener que ir a buscar el mail de nuevo.
    mostrarFormConLead(datos.lead);
    cerrarBloque();
  } catch {
    mostrarMensaje("No se pudo leer el mail. Revisá la conexión.");
  } finally {
    elBtnConvertir.disabled = false;
    elBtnConvertir.textContent = textoOriginal;
  }
});
