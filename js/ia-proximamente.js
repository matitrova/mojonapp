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

elBtnAbrir.addEventListener("click", () => {
  document.getElementById("vista-lista").classList.add("oculto"); // no superponer con "Ver como lista"
  document.getElementById("btn-ver-lista").classList.remove("activo");
  document.getElementById("panel-admin").classList.add("oculto");
  document.getElementById("panel-sectores").classList.add("oculto");
  document.getElementById("panel-barrios").classList.add("oculto");
  document.getElementById("panel-dashboard").classList.add("oculto");
  document.getElementById("panel-auditoria").classList.add("oculto");
  elPanel.classList.remove("oculto");
});

document.getElementById("cerrar-panel-ia").addEventListener("click", () => {
  elPanel.classList.add("oculto");
});
