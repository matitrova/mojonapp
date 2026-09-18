"""La app tiene que arrancar aunque los CDN ajenos no contesten.

POR QUÉ EXISTE ESTE ARCHIVO. El 2026-09-18, investigando otra cosa,
apareció en la consola `L is not defined` junto a un
`ERR_CONNECTION_RESET` de unpkg.com. Leaflet se cargaba desde ahí con un
<script> normal, y js/mapa.js hace L.map(...) al evaluarse. Cuando unpkg
fallaba:

  - mapa.js explotaba;
  - app.js lo importa, así que NO ARRANCABA NADA: ni el login, ni el
    CRM, ni el dashboard, ni la página pública de un lote;
  - y no se veía ningún error. Quedaba el encabezado (HTML estático) y
    el resto en blanco.

Pasó 3 de 6 recargas seguidas en una prueba, y era también la causa de
tests que fallaban "sin motivo": la página nunca terminaba de cargar
porque la app entera estaba muerta.

Leaflet ahora se sirve desde vendor/ (mismo origen que todo lo demás).
Estos tests son para que no vuelva: uno mira el HTML, el otro apaga el
dominio de verdad y comprueba que la app igual funciona.
"""

import re
from pathlib import Path

import pytest
from playwright.sync_api import expect

RAIZ = Path(__file__).resolve().parents[1]

# Dominios de terceros de los que la app NO puede depender para
# arrancar. No están todos los externos a propósito: las fuentes de
# Google (fonts.googleapis.com) se cargan con font-display:swap y si
# fallan solo cambia la tipografía, y Firebase viene de gstatic como
# módulo — eso es otra discusión, pero al menos no deja la pantalla en
# blanco sin avisar.
CDN_PROHIBIDOS = ["unpkg.com", "cdn.jsdelivr.net", "cdnjs.cloudflare.com", "code.jquery.com"]


def test_el_html_no_carga_scripts_ni_estilos_de_un_cdn():
    """Se mira el HTML y no el navegador: es la forma de que falle en el
    acto si alguien vuelve a pegar un <script src="https://cdn...">,
    sin depender de que el CDN esté caído justo cuando corre el test."""
    html = (RAIZ / "index.html").read_text()

    # Solo las etiquetas que BLOQUEAN el arranque: <script src> y
    # <link rel=stylesheet>. Una URL dentro de un comentario o de un
    # atributo de datos no rompe nada.
    etiquetas = re.findall(r"<(?:script|link)\b[^>]*>", html, flags=re.IGNORECASE)
    ofensores = [
        etiqueta
        for etiqueta in etiquetas
        for cdn in CDN_PROHIBIDOS
        if cdn in etiqueta
    ]
    assert not ofensores, (
        "index.html carga algo de un CDN ajeno. Si ese servidor no contesta, la app "
        "entera queda muerta sin ningún aviso (ver el comentario de este archivo).\n"
        + "\n".join(ofensores)
    )


def test_leaflet_esta_en_el_repo():
    """Si falta el archivo, el <script> de arriba apunta a la nada y es
    exactamente el mismo desastre, nada más que propio."""
    js = RAIZ / "vendor" / "leaflet" / "leaflet.js"
    css = RAIZ / "vendor" / "leaflet" / "leaflet.css"
    assert js.exists() and js.stat().st_size > 100_000, "falta vendor/leaflet/leaflet.js"
    assert css.exists() and css.stat().st_size > 10_000, "falta vendor/leaflet/leaflet.css"

    # Las imágenes las pide leaflet.css por ruta relativa. Sin ellas los
    # marcadores del dashboard salen roscos.
    imagenes = RAIZ / "vendor" / "leaflet" / "images"
    for nombre in ("marker-icon.png", "marker-icon-2x.png", "marker-shadow.png"):
        assert (imagenes / nombre).exists(), f"falta vendor/leaflet/images/{nombre}"


def test_la_app_arranca_con_los_cdn_caidos(page, base_url):
    """La prueba de verdad: se apagan los dominios y se usa la app.

    No alcanza con que no haya errores en la consola — se comprueba que
    se pueda HACER algo, porque el síntoma original era justamente una
    pantalla que se veía casi bien y donde ningún botón respondía.
    """
    errores = []
    page.on("pageerror", lambda e: errores.append(str(e)))
    for dominio in CDN_PROHIBIDOS:
        page.route(f"**://{dominio}/**", lambda ruta: ruta.abort())

    page.goto(base_url)

    # 1. Leaflet está y el mapa se dibujó.
    page.wait_for_function("() => typeof L !== 'undefined'", timeout=20000)
    expect(page.locator("#mapa .leaflet-tile").first).to_be_visible(timeout=20000)

    # 2. Los handlers de app.js corrieron: el login abre de verdad.
    page.click("#btn-abrir-login")
    expect(page.locator("#login-email")).to_be_visible()

    assert not errores, f"la app tiró errores con los CDN caídos: {errores}"
