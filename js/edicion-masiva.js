// ---------------------------------------------------------------------------
// Qué escribir cuando se aplica un cambio a varios lotes a la vez.
//
// PARA QUÉ EXISTE ESTO. Cargar una cartera traída del catastro es
// repetir el mismo dato decenas de veces: una manzana entera comparte
// zona, barrio y servicios. Medido sobre la cartera real que había en
// producción: 108 lotes con superficie y geometría, pero 3 con zona y 8
// con servicios. El formulario de edición ya tenía todos los campos —
// lo que faltaba era no abrirlo 108 veces.
//
// POR QUÉ ESTÁ SEPARADO DEL DOM. Acá vive la única parte con reglas de
// verdad: distinguir "no cambiar este campo" de "cambiarlo a vacío". Son
// dos cosas distintas y confundirlas borra datos buenos en masa, que es
// el peor error posible en una pantalla como esta. Aislado y sin
// efectos, se puede testear cada combinación sin tocar Firestore ni
// abrir la app.
//
// EL ESTADO DEL LOTE NO SE PUEDE CAMBIAR EN MASA, A PROPÓSITO.
// "Reservado" pide una fecha de vencimiento y "vendido" pide un
// comprador, y los dos son distintos para cada lote (ver el guardado de
// js/vista-lista.js, que los limpia solo cuando el estado deja de
// corresponder). Aplicarlos en masa dejaría lotes marcados como vendidos
// sin comprador: datos a medias, que es justo lo que esta pantalla
// existe para evitar.
// ---------------------------------------------------------------------------

// Valor de los selects que significa "a este campo no lo toques".
// Es string vacío porque es el value natural de un <option> sin valor,
// así el formulario arranca sin cambios sin necesidad de inicializarlo.
export const SIN_CAMBIO = "";

// "Vaciar el campo" es una opción explícita y separada de SIN_CAMBIO:
// sirve para corregir en masa una zona mal asignada.
export const VACIAR = "__vaciar__";

export const SERVICIOS = ["luz", "agua", "gas", "cloaca"];

const ETIQUETA_SERVICIO = { luz: "Luz", agua: "Agua", gas: "Gas", cloaca: "Cloaca" };

/**
 * Traduce los valores del formulario a los campos que hay que escribir.
 *
 * @param valores {sector, barrio, precio, luz, agua, gas, cloaca}
 *        Cada uno puede ser SIN_CAMBIO. sector/barrio aceptan VACIAR.
 *        precio es el texto crudo del input.
 *        Los servicios son "si" / "no" / SIN_CAMBIO.
 * @returns {cambios, resumen, error}
 *        cambios: objeto listo para updateDoc (vacío si no hay nada que hacer)
 *        resumen: líneas en castellano para confirmarle al usuario qué va a pasar
 *        error: motivo por el que no se puede aplicar, o null
 */
export function armarCambios(valores = {}) {
  const cambios = {};
  const resumen = [];

  if (valores.sector !== SIN_CAMBIO && valores.sector !== undefined) {
    cambios.sector = valores.sector === VACIAR ? null : valores.sector;
    resumen.push(valores.sector === VACIAR ? "Zona: vaciar" : `Zona: ${valores.sector}`);
  }

  if (valores.barrio !== SIN_CAMBIO && valores.barrio !== undefined) {
    cambios.barrio = valores.barrio === VACIAR ? null : valores.barrio;
    resumen.push(valores.barrio === VACIAR ? "Barrio: vaciar" : `Barrio: ${valores.barrio}`);
  }

  // El precio se escribe solo si hay algo escrito. Un input en blanco es
  // "no cambiar", NO "poner en cero": un lote con precio 0 se publicaría
  // como si se regalara.
  const precioCrudo = (valores.precio ?? "").toString().trim();
  if (precioCrudo !== "") {
    const precio = Number(precioCrudo);
    if (!Number.isFinite(precio) || precio <= 0) {
      return { cambios: {}, resumen: [], error: "El precio tiene que ser un número mayor que cero." };
    }
    cambios.precio_usd = precio;
    resumen.push(`Precio: USD ${precio.toLocaleString("es-AR")}`);
  }

  // Los servicios se escriben con ruta con punto ("servicios.luz") y no
  // reemplazando el objeto entero. Si se mandara { servicios: { luz: true } }
  // se borrarían agua, gas y cloaca de todos los lotes seleccionados —
  // una pérdida de datos silenciosa y en masa.
  for (const servicio of SERVICIOS) {
    const valor = valores[servicio];
    if (valor === SIN_CAMBIO || valor === undefined) continue;
    cambios[`servicios.${servicio}`] = valor === "si";
    resumen.push(`${ETIQUETA_SERVICIO[servicio]}: ${valor === "si" ? "sí tiene" : "no tiene"}`);
  }

  if (Object.keys(cambios).length === 0) {
    return { cambios: {}, resumen: [], error: "No elegiste ningún cambio para aplicar." };
  }

  return { cambios, resumen, error: null };
}

/**
 * Texto de confirmación, con la cantidad de lotes adentro.
 *
 * Se arma acá y no en el HTML para que el plural y el conteo estén
 * testeados: es la última pantalla que ve el usuario antes de una
 * escritura sobre muchos documentos, y tiene que decir exactamente
 * cuántos toca.
 */
export function textoDeConfirmacion(cantidad, resumen) {
  const lotes = cantidad === 1 ? "1 lote" : `${cantidad} lotes`;
  return `Se va a aplicar a ${lotes}: ${resumen.join(" · ")}`;
}

/**
 * Cómo queda el detalle del evento de auditoría.
 *
 * Se registra UN evento por operación, no uno por lote (ver la edición en
 * masa en js/vista-lista.js): 40 filas iguales taparían todo lo demás del
 * día, y además fue una sola acción de una sola persona. El detalle es el
 * que tiene que alcanzar para entender después qué pasó, así que lleva la
 * cantidad y los cambios aplicados.
 */
export function detalleParaAuditoria(cantidad, resumen) {
  return `En masa (${cantidad}): ${resumen.join(" · ")}`;
}
