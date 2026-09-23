// ---------------------------------------------------------------------------
// "Inteligencia Artificial" — la vidriera de lo que la app hace y va a
// hacer con IA. Nació cuando no había ninguna función prendida; hoy dos
// ya andan (js/ia-descripcion.js y js/ia-lead.js, cada una con su
// endpoint en functions/) y las otras tres siguen esperando la API de
// WhatsApp Business. El panel en sí sigue siendo 100% informativo:
// ningún botón de ACÁ llama a nada, las activas se usan desde la ficha
// y desde el CRM. Si se prende o se apaga una función, hay que tocar su
// insignia Y el párrafo de arriba del panel (index.html), que se
// escribió en términos de las insignias justamente para eso. Solo root la ve (mismo criterio que Auditoría:
// esRootActual() directo en app.js, ver actualizarUIPorPermisos).
// ---------------------------------------------------------------------------

const elPanel = document.getElementById("panel-ia");
const elBtnAbrir = document.getElementById("btn-abrir-ia");

// Esconder las otras pantallas y cerrar esta con el ← lo maneja
// js/router.js (ver el comentario allá).
elBtnAbrir.addEventListener("click", () => {
  elPanel.classList.remove("oculto");
});
