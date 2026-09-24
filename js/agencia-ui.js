// ---------------------------------------------------------------------------
// Quién publica, dibujado igual en todas las pantallas que ve un
// comprador.
//
// POR QUÉ EXISTE. Lo usan la página de un lote (/lote/<id>) y el
// catálogo público (/propiedades). Al escribir la segunda, lo primero
// que apareció fue la tentación de copiar la primera — y una copia es
// exactamente cómo termina pasando que el teléfono se actualice en una
// pantalla y en la otra no.
//
// Recibe los elementos por parámetro en vez de buscarlos por id: los
// dos paneles tienen ids distintos, y así este módulo no sabe nada de
// ninguno de los dos.
// ---------------------------------------------------------------------------

import { comoUbicarla } from "./inmobiliaria-datos.js";

/**
 * La banda de arriba: logo, nombre y dónde queda.
 *
 * Devuelve si había algo que mostrar, para que quien llama decida si
 * esconde el bloque entero. Una banda vacía se ve peor que ninguna.
 */
export function pintarBanda({ contenedor, logo, nombre, donde }, inmobiliaria) {
  contenedor.classList.toggle("oculto", !inmobiliaria);
  if (!inmobiliaria) return false;

  nombre.textContent = inmobiliaria.nombre;

  const ubicacion = comoUbicarla(inmobiliaria);
  donde.textContent = ubicacion || "";
  donde.classList.toggle("oculto", !ubicacion);

  // Si la URL del logo ya no carga (se borró de Cloudinary, se pegó
  // mal), el <img> queda con el ícono de imagen rota arriba de todo en
  // la pantalla de un comprador. Mejor sin logo que con un cuadrito
  // roto: es la primera impresión de la inmobiliaria.
  const hayLogo = !!inmobiliaria.logo_url;
  if (hayLogo) {
    logo.onerror = () => logo.classList.add("oculto");
    logo.src = inmobiliaria.logo_url;
    logo.alt = inmobiliaria.nombre;
  }
  logo.classList.toggle("oculto", !hayLogo);
  return true;
}

/**
 * El pie: cómo ubicar a la inmobiliaria por fuera del formulario.
 *
 * Mucha gente no deja sus datos en un formulario pero sí llama, y la
 * matrícula es lo que distingue a una inmobiliaria registrada de un
 * aviso suelto.
 */
export function pintarPie({ contenedor, nombre, datos, matricula }, inmobiliaria) {
  contenedor.classList.toggle("oculto", !inmobiliaria);
  if (!inmobiliaria) return false;

  nombre.textContent = inmobiliaria.nombre;

  // Cada línea aparece solo si hay qué poner. El teléfono y la web son
  // links y no texto: en un teléfono, que el número se toque y llame es
  // la diferencia entre una consulta y ninguna.
  datos.innerHTML = "";
  const lineas = [
    { texto: comoUbicarla(inmobiliaria) },
    { texto: inmobiliaria.horario },
    { texto: inmobiliaria.telefono, href: `tel:${inmobiliaria.telefono}` },
    { texto: inmobiliaria.email, href: `mailto:${inmobiliaria.email}` },
    { texto: inmobiliaria.web, href: inmobiliaria.web, afuera: true }
  ];
  for (const linea of lineas) {
    if (!linea.texto) continue;
    const li = document.createElement("li");
    if (linea.href) {
      const a = document.createElement("a");
      a.href = linea.href;
      a.textContent = linea.texto;
      // Solo la web sale de la página; tel: y mailto: abren una app y
      // no tiene sentido mandarlos a otra pestaña.
      if (linea.afuera) {
        a.target = "_blank";
        a.rel = "noopener noreferrer";
      }
      li.appendChild(a);
    } else {
      li.textContent = linea.texto;
    }
    datos.appendChild(li);
  }

  const texto = inmobiliaria.matricula ? `Matrícula ${inmobiliaria.matricula}` : "";
  matricula.textContent = texto;
  matricula.classList.toggle("oculto", !texto);
  return true;
}
