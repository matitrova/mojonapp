// ---------------------------------------------------------------------------
// "Inteligencia Artificial" — vidriera de funciones ya diseñadas pero
// TODAVÍA NO conectadas a ningún servicio pago (OpenAI, WhatsApp Business
// API). Pedido explícito: dejar la estructura lista para el día que se
// quieran prender de verdad, sin activar nada ahora ni asumir ningún
// costo — ningún botón de este panel llama a una API paga, es 100%
// informativo. Solo root la ve (mismo criterio que Auditoría:
// esRootActual() directo en app.js, ver actualizarUIPorPermisos).
// ---------------------------------------------------------------------------

const elPanel = document.getElementById("panel-ia");
const elBtnAbrir = document.getElementById("btn-abrir-ia");

// Esconder las otras pantallas y cerrar esta con el ← lo maneja
// js/router.js (ver el comentario allá).
elBtnAbrir.addEventListener("click", () => {
  elPanel.classList.remove("oculto");
});
