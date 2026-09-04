"""
Test de Playwright para "Dibujar área" en el mapa (js/dibujar-area.js):
marcar un área a mano tiene que dejar bien visibles los lotes que caen
adentro y tenues los que quedan afuera, y "Quitar filtro" tiene que
devolver todo a como estaba.

Los clicks sobre el mapa se simulan disparando el evento "click" de
Leaflet directo con una latlng conocida (`mapa.fire("click", ...)`) en
vez de clicks de mouse a coordenadas de píxel — mismo criterio ya usado
en esta sesión para posicionar el mapa en pruebas: es determinístico y
no depende de a qué zoom/centro haya quedado el mapa.
"""

import uuid

from playwright.sync_api import expect

from conftest import borrar_lote_de_prueba, crear_lote_de_prueba

# Área que se va a dibujar en el test: un cuadrado chico bien alejado de
# cualquier otro dato real, para no depender de qué lotes reales haya
# cargados hoy.
LAT_MIN, LAT_MAX = -32.400, -32.398
LON_MIN, LON_MAX = -65.100, -65.098


def _datos_lote(manzana, lote, lat, lon):
    offset = 0.00005  # lado de ~5m, no importa el tamaño real para este test
    return {
        "manzana": manzana,
        "lote": lote,
        "nomenclatura": None,
        "superficie_m2": 500,
        "estado": "disponible",
        "sector": None,
        "geometry": {
            "type": "Polygon",
            "coordinates": [
                {"lon": lon, "lat": lat},
                {"lon": lon + offset, "lat": lat},
                {"lon": lon + offset, "lat": lat + offset},
                {"lon": lon, "lat": lat + offset},
                {"lon": lon, "lat": lat},
            ],
        },
    }


def _dibujar_cuadrado(page):
    page.evaluate(
        """
        (async () => {
          const { mapa } = await import('/js/mapa.js');
          const puntos = [
            [%f, %f],
            [%f, %f],
            [%f, %f],
            [%f, %f]
          ];
          for (const [lat, lon] of puntos) {
            mapa.fire('click', { latlng: L.latLng(lat, lon) });
          }
        })()
        """
        % (LAT_MIN - 0.0005, LON_MIN - 0.0005, LAT_MIN - 0.0005, LON_MAX + 0.0005,
           LAT_MAX + 0.0005, LON_MAX + 0.0005, LAT_MAX + 0.0005, LON_MIN - 0.0005)
    )


def test_dibujar_area_deja_tenues_los_lotes_de_afuera(page, base_url):
    marcador = uuid.uuid4().hex[:8]
    adentro = crear_lote_de_prueba(_datos_lote(f"DA-DENTRO-{marcador}", "1", LAT_MIN + 0.001, LON_MIN + 0.001))
    afuera = crear_lote_de_prueba(_datos_lote(f"DA-FUERA-{marcador}", "1", LAT_MIN + 0.001, LON_MIN + 1))
    try:
        page.goto(base_url)
        # El fitBounds() del arranque encuadra TODOS los lotes cargados —
        # con datos reales de por medio, este par de lotes de 5m queda
        # tan lejos que termina en un zoom donde cualquier polígono chico
        # se ve como un punto sin área (path degenerado, "hidden" para
        # Playwright aunque el fill-opacity esté bien puesto). Centrar el
        # mapa a mano en el área del test, mismo criterio que otras
        # pruebas de esta sesión (ver mojonapp_estado_proyecto.md) —
        # esperando primero a que el polígono exista en el DOM, para no
        # pisar el setView a mano con el fitBounds() de la carga inicial
        # (que corre después, de forma async).
        page.wait_for_selector(f".lote-{adentro}", state="attached")
        page.evaluate(
            """
            (async () => {
              const { mapa } = await import('/js/mapa.js');
              mapa.setView([%f, %f], 18, { animate: false });
            })()
            """
            % ((LAT_MIN + LAT_MAX) / 2, (LON_MIN + LON_MAX) / 2)
        )
        expect(page.locator(f".lote-{adentro}")).to_be_visible()

        page.locator("#btn-menu").click()
        page.locator("#btn-dibujar-area").click()
        expect(page.locator("#panel-dibujar-area")).to_be_visible()

        _dibujar_cuadrado(page)
        expect(page.locator("#dibujar-area-contador")).to_contain_text("4 puntos")

        page.locator("#btn-dibujar-area-aplicar").click()
        expect(page.locator("#chip-filtro-area")).to_be_visible()
        expect(page.locator("#panel-dibujar-area")).to_be_hidden()

        expect(page.locator(f".lote-{adentro}")).to_have_attribute("fill-opacity", "0.55")
        expect(page.locator(f".lote-{afuera}")).to_have_attribute("fill-opacity", "0.05")

        page.locator("#btn-quitar-filtro-area").click()
        expect(page.locator("#chip-filtro-area")).to_be_hidden()
        expect(page.locator(f".lote-{afuera}")).to_have_attribute("fill-opacity", "0.55")
    finally:
        borrar_lote_de_prueba(adentro)
        borrar_lote_de_prueba(afuera)


def test_cancelar_dibujo_de_area_no_deja_filtro_puesto(page, base_url):
    page.goto(base_url)
    page.locator("#btn-menu").click()
    page.locator("#btn-dibujar-area").click()
    expect(page.locator("#panel-dibujar-area")).to_be_visible()

    page.evaluate(
        """
        (async () => {
          const { mapa } = await import('/js/mapa.js');
          mapa.fire('click', { latlng: L.latLng(%f, %f) });
        })()
        """
        % (LAT_MIN, LON_MIN)
    )
    expect(page.locator("#dibujar-area-contador")).to_contain_text("1 punto")

    page.locator("#cerrar-dibujar-area").click()
    expect(page.locator("#panel-dibujar-area")).to_be_hidden()
    expect(page.locator("#chip-filtro-area")).to_be_hidden()


def test_aplicar_con_menos_de_3_puntos_muestra_error(page, base_url):
    page.goto(base_url)
    page.locator("#btn-menu").click()
    page.locator("#btn-dibujar-area").click()

    page.evaluate(
        """
        (async () => {
          const { mapa } = await import('/js/mapa.js');
          mapa.fire('click', { latlng: L.latLng(%f, %f) });
          mapa.fire('click', { latlng: L.latLng(%f, %f) });
        })()
        """
        % (LAT_MIN, LON_MIN, LAT_MIN, LON_MAX)
    )
    page.locator("#btn-dibujar-area-aplicar").click()
    expect(page.locator("#dibujar-area-error")).to_be_visible()
    expect(page.locator("#dibujar-area-error")).to_contain_text("al menos 3 puntos")
