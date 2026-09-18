"""¿Hay foto satelital de verdad en el zoom que la app le pide a Esri?

POR QUÉ ESTE TEST EXISTE. El 2026-09-18 el usuario reportó "se rompe el
mapa cuando haces mucho zoom". No era el zoom: era que en Potrero de los
Funes, Villa Mercedes y San Luis capital, Esri no tiene foto en zoom 18
—el zoom con el que arranca la app— y devuelve un cartel gris que dice
"Map data not yet available". El código pedía hasta 18 porque la
verificación original se había hecho en Carpintería/Merlo, donde sí hay.

LO QUE HACE ESTE BUG INVISIBLE, y por eso hace falta un test raro: el
cartel viene con HTTP 200. Para Leaflet es un tile que cargó bien. No
hay error en la consola, no falla ninguna petición, y ningún test de
navegador que mire el DOM lo puede distinguir de una foto. La ÚNICA
señal es el tamaño del archivo: el cartel pesa siempre 2521 bytes; una
foto de verdad, entre 13 y 22 KB.

ESTE TEST SALE A INTERNET, a propósito y a diferencia del resto de la
suite. No hay forma de verificar la cobertura de un servicio ajeno sin
preguntarle. Si Esri está caído, el test se saltea en vez de fallar: la
pregunta que contesta es "¿elegimos bien el nivel?", no "¿Esri está
respondiendo ahora?".
"""

import math
import re
from pathlib import Path

import pytest

requests = pytest.importorskip("requests")

RAIZ = Path(__file__).resolve().parents[1]
BASE = "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile"

# El cartel de "Map data not yet available" pesa exactamente esto. Se
# compara con holgura porque no hace falta clavarlo: una foto real pesa
# un orden de magnitud más.
PESO_MAXIMO_DEL_CARTEL = 4000

# Dónde vende esta inmobiliaria. Si alguna vez se suma otra zona, va acá:
# es la lista que define hasta dónde se puede pedir.
ZONAS = {
    "Potrero de los Funes": (-33.2170, -66.2400),
    "Villa Mercedes": (-33.6757, -65.4578),
    "San Luis capital": (-33.3017, -66.3378),
    "Carpintería / Merlo": (-32.4101, -65.0799),
}


def _tile_xy(lat, lon, z):
    n = 2**z
    x = int((lon + 180.0) / 360.0 * n)
    y = int((1.0 - math.asinh(math.tan(math.radians(lat))) / math.pi) / 2.0 * n)
    return x, y


def _max_native_zoom_del_codigo():
    """Lee el valor del código en vez de repetirlo acá.

    Si estuviera escrito en el test, el día que alguien suba
    maxNativeZoom el test seguiría probando el valor viejo y pasaría en
    verde mientras el mapa se rompe.
    """
    fuente = (RAIZ / "js" / "mapa.js").read_text()
    valores = [int(v) for v in re.findall(r"maxNativeZoom:\s*(\d+)", fuente)]
    # El primero es el de la capa satelital; las de referencia (calles,
    # localidades) van después y son overlays transparentes, que no
    # tienen este problema.
    assert valores, "no se encontró ningún maxNativeZoom en js/mapa.js"
    return valores[0]


def _bajar_tile(lat, lon, z):
    x, y = _tile_xy(lat, lon, z)
    try:
        respuesta = requests.get(f"{BASE}/{z}/{y}/{x}", timeout=30)
    except requests.RequestException as error:
        pytest.skip(f"no se pudo contactar a Esri: {error}")
    if respuesta.status_code != 200:
        pytest.skip(f"Esri respondió {respuesta.status_code}")
    return respuesta.content


@pytest.mark.parametrize("zona", sorted(ZONAS))
def test_hay_foto_real_en_el_zoom_que_pide_la_app(zona):
    """En TODAS las zonas donde se vende, no solo en la que se midió."""
    z = _max_native_zoom_del_codigo()
    contenido = _bajar_tile(*ZONAS[zona], z)
    assert len(contenido) > PESO_MAXIMO_DEL_CARTEL, (
        f"en {zona}, Esri no tiene foto en zoom {z}: devolvió {len(contenido)} bytes, "
        f"que es el cartel de 'Map data not yet available' y no una imagen. "
        f"Hay que bajar maxNativeZoom en js/mapa.js (y en js/lote-publico.js)."
    )


def test_el_mapa_chico_de_la_pagina_publica_usa_el_mismo_nivel():
    """Son dos mapas distintos y el bug se arregló en los dos.

    Si alguien toca uno y se olvida del otro, la página que ve el
    comprador queda mostrando el cartel gris — que es justo donde peor
    se ve.

    Se saltea si no existe la página pública: este archivo también vive
    en la rama de arreglos para producción (arreglos-mapa-produccion),
    donde esa pantalla todavía no está. Con un solo mapa no hay nada que
    comparar.
    """
    pagina_publica = RAIZ / "js" / "lote-publico.js"
    if not pagina_publica.exists():
        pytest.skip("esta rama no tiene la página pública del lote (js/lote-publico.js)")

    principal = _max_native_zoom_del_codigo()
    fuente = pagina_publica.read_text()
    valores = [int(v) for v in re.findall(r"maxNativeZoom:\s*(\d+)", fuente)]
    assert valores, "no se encontró maxNativeZoom en js/lote-publico.js"
    assert valores[0] == principal, (
        f"el mapa de la página pública pide zoom {valores[0]} y el principal {principal}: "
        f"tienen que ir juntos"
    )
