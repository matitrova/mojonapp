"""Convierte og-imagen.svg en og-imagen.png.

POR QUÉ HACE FALTA. og-imagen.svg era lo que la app declaraba como
og:image, y WhatsApp y Facebook NO renderizan SVG: descartan la imagen
y muestran la tarjeta pelada. O sea que el link que un corredor manda
diez veces por día se veía sin foto, contra cualquier portal que sí
arma una tarjeta con imagen.

Se renderiza con Chromium (vía Playwright, que ya está para los tests)
en vez de con una librería nueva: no hace falta instalar nada, y el
resultado es exactamente lo que se ve en un navegador.

Esta imagen es solo la RESERVA: cuando el lote tiene fotos, la tarjeta
lleva la foto de la propiedad (ver functions/_middleware.js).

    python scripts/generar_og_imagen.py

El PNG se versiona: se genera una vez y se sirve como archivo estático.
"""

import sys
from pathlib import Path

from playwright.sync_api import sync_playwright

RAIZ = Path(__file__).resolve().parent.parent
SVG = RAIZ / "og-imagen.svg"
PNG = RAIZ / "og-imagen.png"

# Las medidas que piden Facebook y WhatsApp para una tarjeta grande.
ANCHO, ALTO = 1200, 630


def main():
    if not SVG.exists():
        sys.exit(f"No está {SVG}")

    with sync_playwright() as p:
        navegador = p.chromium.launch()
        pagina = navegador.new_page(
            viewport={"width": ANCHO, "height": ALTO}, device_scale_factor=1
        )
        pagina.goto(SVG.as_uri())
        # Sin esto el screenshot puede salir antes de que el navegador
        # haya pintado el degradado y la trama.
        pagina.wait_for_timeout(800)
        pagina.screenshot(path=str(PNG))
        navegador.close()

    tam = PNG.stat().st_size
    print(f"{PNG.name}: {ANCHO}x{ALTO}, {tam // 1024} KB")
    # Facebook descarta imágenes de más de 8 MB. Un PNG de esto pesa
    # decenas de KB, así que si se pasa es que algo salió muy mal.
    if tam > 8 * 1024 * 1024:
        sys.exit("El PNG pesa más de 8 MB: Facebook lo va a descartar.")


if __name__ == "__main__":
    main()
