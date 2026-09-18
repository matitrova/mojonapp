"""
Tests del encuadre inicial del mapa (js/encuadre-mapa.js).

QUÉ PROBLEMA CUBREN. El mapa encuadraba para que entraran todos los
lotes, sin piso de zoom. Con una cartera concentrada está bien, pero con
lotes en localidades distintas se alejaba tanto que cada lote quedaba del
tamaño de un punto: 17 polígonos dibujados en pantalla y ninguno visible.
El usuario lo reportó como "se rompió el mapa", y el mapa no estaba roto
— estaba mostrando la provincia entera.

Los primeros tests son de la decisión pura, sin Leaflet. El último es de
integración y afirma lo único que le importa a quien usa la app: que el
mapa nunca arranque tan lejos que no se vea nada.
"""

import re
import uuid

from playwright.sync_api import expect  # noqa: F401  (consistencia con el resto de la suite)

from conftest import borrar_lotes_de_prueba, crear_lote_de_prueba

# El zoom del que se sirven los tiles va en su propia URL
# (.../MapServer/tile/{z}/{y}/{x}), así que se puede leer el zoom real
# del mapa sin acceso al objeto de Leaflet.
TILE_CON_ZOOM = re.compile(r"/MapServer/tile/(\d+)/")

ZOOM_MINIMO_ESPERADO = 13


def _evaluar(page, base_url, expresion, *args):
    page.goto(base_url)
    return page.evaluate(
        "(args) => import('/js/encuadre-mapa.js').then((m) => (" + expresion + "))",
        list(args),
    )


def test_el_grupo_mas_numeroso_gana(page, base_url):
    """Dos grupos lejanos de tamaños distintos: se enfoca el más grande.

    Tres lotes juntos en un lado y uno solo a ~50 km: el centro devuelto
    tiene que caer sobre los tres, no en el medio de la nada entre ambos
    (que es lo que hacía el encuadre viejo).
    """
    centro = _evaluar(
        page,
        base_url,
        "m.centroDelGrupoMasNumeroso(args[0])",
        [
            {"lat": -33.100, "lng": -66.300},
            {"lat": -33.101, "lng": -66.301},
            {"lat": -33.102, "lng": -66.302},
            {"lat": -32.400, "lng": -65.000},
        ],
    )
    assert centro is not None
    assert -33.11 < centro[0] < -33.09, f"la latitud {centro[0]} no cayó sobre el grupo de tres"
    assert -66.31 < centro[1] < -66.29, f"la longitud {centro[1]} no cayó sobre el grupo de tres"


def test_lotes_cercanos_forman_un_solo_grupo(page, base_url):
    """Lotes a pocos cientos de metros son UN grupo, no varios.

    Es el caso normal de un loteo: manzanas contiguas. Si cada lote
    contara como su propio grupo, "el grupo más numeroso" sería siempre
    uno solo y el mapa enfocaría un lote al azar.
    """
    centro = _evaluar(
        page,
        base_url,
        "m.centroDelGrupoMasNumeroso(args[0])",
        [
            {"lat": -32.4100, "lng": -65.0800},
            {"lat": -32.4110, "lng": -65.0810},
            {"lat": -32.4120, "lng": -65.0820},
        ],
    )
    assert -32.413 < centro[0] < -32.409
    assert -65.083 < centro[1] < -65.079


def test_sin_lotes_no_hay_grupo(page, base_url):
    """Sin lotes devuelve null, y mapa.js cae al encuadre de siempre."""
    assert _evaluar(page, base_url, "m.centroDelGrupoMasNumeroso(args[0])", []) is None


def test_el_umbral_solo_se_activa_alejandose(page, base_url):
    """La rama nueva entra solo cuando hay que alejarse de más.

    Incluye el caso del contenedor sin tamaño: Leaflet ahí devuelve el
    maxZoom del mapa (24), y eso TIENE que caer en el encuadre de
    siempre, que es el que ya sabía convivir con ese caso.
    """
    resultados = _evaluar(
        page,
        base_url,
        "args[0].map((z) => m.convieneEnfocarUnGrupo(z))",
        [10, 12, 13, 14, 18, 24],
    )
    assert resultados == [True, True, False, False, False, False]


def test_el_mapa_nunca_arranca_mas_lejos_que_el_minimo(page, base_url):
    """Integración: abrir la app con lotes dispersos y mirar el zoom real.

    Crea dos lotes a unos 80 km uno del otro, que con el encuadre viejo
    forzaban un zoom cerca de 9. La afirmación es robusta a los datos que
    ya haya en la base: sumar lotes propios solo puede dispersar más la
    cartera, nunca concentrarla, así que el piso tiene que aguantar.

    El zoom se lee de la URL de los tiles y no del objeto de Leaflet,
    que no está expuesto en window.
    """
    marcador = uuid.uuid4().hex[:8]
    lejanos = [
        crear_lote_de_prueba(
            {
                "manzana": f"ENCUADRE-A-{marcador}",
                "lote": "1",
                "nomenclatura": None,
                "superficie_m2": 1000,
                "estado": "disponible",
                "precio_usd": 20000,
                "sector": f"ENCUADRE-NORTE-{marcador}",
                "geometry": {
                    "type": "Polygon",
                    "coordinates": [
                        {"lon": -65.0800, "lat": -32.4100},
                        {"lon": -65.0798, "lat": -32.4100},
                        {"lon": -65.0798, "lat": -32.4102},
                        {"lon": -65.0800, "lat": -32.4102},
                        {"lon": -65.0800, "lat": -32.4100},
                    ],
                },
            }
        ),
        crear_lote_de_prueba(
            {
                "manzana": f"ENCUADRE-B-{marcador}",
                "lote": "1",
                "nomenclatura": None,
                "superficie_m2": 1000,
                "estado": "disponible",
                "precio_usd": 20000,
                "sector": f"ENCUADRE-SUR-{marcador}",
                "geometry": {
                    "type": "Polygon",
                    "coordinates": [
                        {"lon": -66.3000, "lat": -33.1000},
                        {"lon": -66.2998, "lat": -33.1000},
                        {"lon": -66.2998, "lat": -33.1002},
                        {"lon": -66.3000, "lat": -33.1002},
                        {"lon": -66.3000, "lat": -33.1000},
                    ],
                },
            }
        ),
    ]
    try:
        page.goto(base_url)
        # Primero se espera a que el encuadre HAYA CORRIDO: mapa.js
        # escribe en data-encuadre cuál de las dos ramas usó, recién
        # después de que contestó Firestore. Sin esta espera el test
        # mediría el zoom del setView inicial y pasaría sin probar nada.
        page.wait_for_selector("#mapa[data-encuadre]")
        assert page.locator("#mapa").get_attribute("data-encuadre") == "grupo-mas-numeroso", (
            "con dos lotes a 80 km el encuadre tendría que haber enfocado un grupo; "
            "encuadró para que entraran todos"
        )
        page.wait_for_selector("#mapa img.leaflet-tile")
        zooms = [
            int(m.group(1))
            for m in (
                TILE_CON_ZOOM.search(src)
                for src in page.eval_on_selector_all(
                    "#mapa img.leaflet-tile", "tiles => tiles.map((t) => t.src)"
                )
            )
            if m
        ]
        assert zooms, "no se pudo leer el zoom de ningún tile"
        assert min(zooms) >= ZOOM_MINIMO_ESPERADO, (
            f"el mapa arrancó en zoom {min(zooms)}, más lejos que el mínimo "
            f"{ZOOM_MINIMO_ESPERADO}: con lotes dispersos se ve vacío"
        )
    finally:
        borrar_lotes_de_prueba(lejanos)


def test_el_mapa_se_corre_cuando_una_hoja_lo_tapa(page, base_url):
    """La ficha y los formularios tapan hasta el 70% de la pantalla.

    Centrar en el medio del contenedor deja el lote DETRÁS de la hoja, y
    lo poco de mapa que queda a la vista se ve todo corrido hacia arriba.
    Reportado por el usuario: "eso hace perderte mucho".
    """
    # 800 de alto, 560 tapados (70%): la franja visible mide 240 y su
    # centro está en 120; el punto está en 400, así que sube 280.
    assert _evaluar(page, base_url, "m.desplazamientoPorHojaAbierta(560, 800)") == 280


def test_sin_hoja_abierta_no_se_corre_nada(page, base_url):
    assert _evaluar(page, base_url, "m.desplazamientoPorHojaAbierta(0, 800)") == 0


def test_si_la_hoja_tapa_todo_no_se_mueve(page, base_url):
    """Sin franja visible, mover el mapa no arregla nada y encima dejaría
    el punto fuera de la pantalla."""
    assert _evaluar(page, base_url, "m.desplazamientoPorHojaAbierta(800, 800)") == 0
    assert _evaluar(page, base_url, "m.desplazamientoPorHojaAbierta(900, 800)") == 0
