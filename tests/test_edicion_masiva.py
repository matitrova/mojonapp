"""
Tests de la edición en masa de lotes.

POR QUÉ ESTA PANTALLA TIENE TESTS ASÍ DE INSISTENTES. Es la única que
escribe sobre decenas de documentos con un click. El error que importa no
es que no guarde: es que guarde DE MÁS. Dos formas concretas, las dos
cubiertas acá:

  - confundir "no cambiar este campo" con "poner el campo en vacío", que
    borraría en masa datos que estaban bien;
  - escribir el objeto de servicios completo en vez del servicio elegido,
    que borraría los otros tres servicios de cada lote seleccionado.

Los primeros tests son de la decisión pura (js/edicion-masiva.js), sin
navegador ni Firestore. Los últimos son de integración: crean lotes de
prueba, los editan desde la pantalla y verifican contra la base.
"""

import uuid

import pytest
import requests
from playwright.sync_api import expect

from conftest import (
    FIREBASE_PROJECT_ID,
    _id_token_de_prueba,
    borrar_lote_de_prueba,
    borrar_lotes_de_prueba,
    crear_lote_de_prueba,
    crear_lotes_de_prueba,
    soltar_el_mouse,
)

GEOMETRIA = {
    "type": "Polygon",
    "coordinates": [
        {"lon": -65.080000, "lat": -32.410000},
        {"lon": -65.079780, "lat": -32.410000},
        {"lon": -65.079780, "lat": -32.410200},
        {"lon": -65.080000, "lat": -32.410200},
        {"lon": -65.080000, "lat": -32.410000},
    ],
}


def _lote(manzana, numero, **extra):
    datos = {
        "manzana": manzana,
        "lote": numero,
        "nomenclatura": None,
        "superficie_m2": 1000,
        "estado": "disponible",
        "precio_usd": None,
        "sector": None,
        "barrio": None,
        "geometry": GEOMETRIA,
    }
    datos.update(extra)
    return datos


def _leer_lote(doc_id):
    url = (
        f"https://firestore.googleapis.com/v1/projects/{FIREBASE_PROJECT_ID}"
        f"/databases/(default)/documents/lotes/{doc_id}"
    )
    respuesta = requests.get(url, headers={"Authorization": f"Bearer {_id_token_de_prueba()}"}, timeout=20)
    respuesta.raise_for_status()
    return respuesta.json().get("fields", {})


def _servicios_de(campos):
    """Los servicios llegan como un mapValue de Firestore."""
    crudos = campos.get("servicios", {}).get("mapValue", {}).get("fields", {})
    return {clave: valor.get("booleanValue") for clave, valor in crudos.items()}


def _armar(page, base_url, valores):
    page.goto(base_url)
    return page.evaluate(
        "(valores) => import('/js/edicion-masiva.js').then((m) => m.armarCambios(valores))",
        valores,
    )


# ---------------------------------------------------------------------------
# La decisión pura
# ---------------------------------------------------------------------------


def test_lo_que_no_se_elige_no_se_escribe(page, base_url):
    """Un formulario en blanco no produce ninguna escritura.

    Es el caso que protege los datos: si "no cambiar" se colara como un
    valor, este formulario vacío vaciaría zona, barrio, precio y los
    cuatro servicios de cada lote seleccionado.
    """
    resultado = _armar(page, base_url, {"sector": "", "barrio": "", "precio": "", "luz": "", "agua": "", "gas": "", "cloaca": ""})
    assert resultado["cambios"] == {}
    assert resultado["error"] == "No elegiste ningún cambio para aplicar."


def test_un_servicio_no_pisa_a_los_otros_tres(page, base_url):
    """Se escribe "servicios.luz", no el objeto "servicios" entero.

    Con el objeto entero, marcar luz borraría agua, gas y cloaca en todos
    los lotes seleccionados: pérdida de datos silenciosa y en masa.
    """
    resultado = _armar(page, base_url, {"sector": "", "barrio": "", "precio": "", "luz": "si", "agua": "", "gas": "", "cloaca": ""})
    assert resultado["cambios"] == {"servicios.luz": True}
    assert "servicios" not in resultado["cambios"]


def test_vaciar_es_distinto_de_no_cambiar(page, base_url):
    """"Vaciar el campo" sí escribe null; "no cambiar" no escribe nada."""
    vaciado = _armar(page, base_url, {"sector": "__vaciar__", "barrio": "", "precio": "", "luz": "", "agua": "", "gas": "", "cloaca": ""})
    assert vaciado["cambios"] == {"sector": None}
    assert "Zona: vaciar" in vaciado["resumen"]

    sin_tocar = _armar(page, base_url, {"sector": "", "barrio": "", "precio": "", "luz": "", "agua": "", "gas": "", "cloaca": ""})
    assert "sector" not in sin_tocar["cambios"]


def test_precio_en_blanco_no_es_precio_cero(page, base_url):
    """Un precio vacío es "no cambiar", no "regalado".

    Escribir 0 publicaría el lote como si no costara nada.
    """
    resultado = _armar(page, base_url, {"sector": "", "barrio": "", "precio": "", "luz": "", "agua": "", "gas": "", "cloaca": ""})
    assert "precio_usd" not in resultado["cambios"]


@pytest.mark.parametrize("precio_invalido", ["0", "-5000", "abc"])
def test_precio_invalido_no_se_aplica(page, base_url, precio_invalido):
    resultado = _armar(
        page, base_url, {"sector": "", "barrio": "", "precio": precio_invalido, "luz": "", "agua": "", "gas": "", "cloaca": ""}
    )
    assert resultado["cambios"] == {}
    assert "número mayor que cero" in resultado["error"]


def test_el_resumen_dice_cuantos_lotes(page, base_url):
    """El texto de confirmación tiene que nombrar la cantidad exacta.

    Es la última frase que se lee antes de escribir sobre muchos
    documentos: si dice de menos, se aplica a más lotes de los que el
    usuario cree.
    """
    page.goto(base_url)
    textos = page.evaluate(
        """() => import('/js/edicion-masiva.js').then((m) => [
             m.textoDeConfirmacion(1, ['Zona: Potrero']),
             m.textoDeConfirmacion(12, ['Zona: Potrero', 'Luz: sí tiene'])
           ])"""
    )
    assert textos[0] == "Se va a aplicar a 1 lote: Zona: Potrero"
    assert textos[1] == "Se va a aplicar a 12 lotes: Zona: Potrero · Luz: sí tiene"


# ---------------------------------------------------------------------------
# Integración: la pantalla contra la base
# ---------------------------------------------------------------------------


def _abrir_lista_filtrada_por(page, base_url, termino, filas):
    """Abre la lista filtrada y ESPERA a que la tabla ya esté redibujada.

    La espera no es de adorno. Escribir en el filtro dispara el
    redibujado, y si se tilda "seleccionar la página" antes de que
    termine, se seleccionan los lotes que estaban antes (los de demo) en
    vez de los filtrados; después el redibujado deja el tilde en falso y
    Playwright avisa que "el click no cambió el estado". Pasó de verdad:
    el test fallaba solo al correr la suite completa, donde la base tiene
    los lotes de demo, y pasaba al correrlo suelto.
    """
    page.goto(base_url)
    page.locator("#btn-menu").click()
    page.locator("#btn-ver-lista").click()
    soltar_el_mouse(page)
    page.locator("#filtro-cantidad").select_option("0")
    page.locator("#filtro-buscar").fill(termino)
    expect(page.locator("#tabla-lotes-cuerpo tr")).to_have_count(filas)
    # Y esperar los TILDES, no solo las filas. Los tildes dependen de
    # puedeEditarLote, que depende del perfil, que llega de una lectura a
    # Firestore: la tabla puede estar dibujada y todavía no tener tildes.
    # Sin esta espera el test falla una de cada tres corridas de la suite
    # completa —donde el perfil tarda más— y pasa siempre corriendo solo.
    expect(page.locator("#tabla-lotes-cuerpo .tilde-lote")).to_have_count(filas)


@pytest.mark.con_sesion
def test_aplicar_a_varios_escribe_en_todos_los_seleccionados(page, base_url):
    """El caso que motivó la pantalla: una manzana entera, un solo cambio."""
    marcador = uuid.uuid4().hex[:8]
    manzana = f"MASIVA-{marcador}"
    ids = crear_lotes_de_prueba([_lote(manzana, str(n)) for n in (1, 2, 3)])
    try:
        _abrir_lista_filtrada_por(page, base_url, manzana, filas=3)

        page.locator("#seleccionar-pagina").check()
        expect(page.locator("#seleccion-cuenta")).to_have_text("3 lotes seleccionados")

        page.locator("#btn-aplicar-a-varios").click()
        page.locator("#masiva-precio").fill("18000")
        page.locator("#masiva-luz").select_option("si")
        expect(page.locator("#masiva-confirmacion")).to_contain_text("Se va a aplicar a 3 lotes")
        page.locator("#masiva-aplicar").click()

        expect(page.locator("#seleccion-barra")).to_be_hidden()

        for doc_id in ids:
            campos = _leer_lote(doc_id)
            assert campos["precio_usd"]["integerValue"] == "18000", f"{doc_id} no quedó con el precio"
            assert _servicios_de(campos)["luz"] is True, f"{doc_id} no quedó con luz"
    finally:
        borrar_lotes_de_prueba(ids)


@pytest.mark.con_sesion
def test_no_se_toca_lo_que_no_se_eligio(page, base_url):
    """El test que justifica todo el módulo aparte.

    Un lote que ya tenía agua y un precio cargado: se le aplica SOLO luz,
    y hay que confirmar que conserva el agua (no se pisó el objeto de
    servicios) y el precio (no se vació por no estar en el formulario).
    """
    marcador = uuid.uuid4().hex[:8]
    manzana = f"CONSERVA-{marcador}"
    doc_id = crear_lote_de_prueba(
        _lote(
            manzana,
            "1",
            precio_usd=25000,
            sector=f"ZONA-{marcador}",
            servicios={"luz": False, "agua": True, "gas": False, "cloaca": False},
        )
    )
    try:
        _abrir_lista_filtrada_por(page, base_url, manzana, filas=1)
        page.locator("#seleccionar-pagina").check()
        page.locator("#btn-aplicar-a-varios").click()
        page.locator("#masiva-luz").select_option("si")
        page.locator("#masiva-aplicar").click()
        expect(page.locator("#seleccion-barra")).to_be_hidden()

        campos = _leer_lote(doc_id)
        servicios = _servicios_de(campos)
        assert servicios["luz"] is True, "no aplicó el cambio pedido"
        assert servicios["agua"] is True, "PISÓ el agua al escribir solo luz"
        assert campos["precio_usd"]["integerValue"] == "25000", "vació el precio sin que nadie lo pidiera"
        assert campos["sector"]["stringValue"] == f"ZONA-{marcador}", "vació la zona sin que nadie lo pidiera"
    finally:
        borrar_lote_de_prueba(doc_id)


@pytest.mark.con_sesion
def test_cambiar_el_filtro_limpia_la_seleccion(page, base_url):
    """Si no, se le aplicaría un cambio a lotes que no están en pantalla."""
    marcador = uuid.uuid4().hex[:8]
    manzana = f"FILTRO-{marcador}"
    ids = crear_lotes_de_prueba([_lote(manzana, str(n)) for n in (1, 2)])
    try:
        _abrir_lista_filtrada_por(page, base_url, manzana, filas=2)
        page.locator("#seleccionar-pagina").check()
        expect(page.locator("#seleccion-barra")).to_be_visible()

        page.locator("#filtro-buscar").fill(f"NADA-{marcador}")
        expect(page.locator("#seleccion-barra")).to_be_hidden()
    finally:
        borrar_lotes_de_prueba(ids)


@pytest.mark.con_sesion
def test_sin_elegir_nada_no_se_puede_aplicar(page, base_url):
    """El botón arranca deshabilitado: no hay forma de escribir sin querer."""
    marcador = uuid.uuid4().hex[:8]
    manzana = f"NADA-{marcador}"
    doc_id = crear_lote_de_prueba(_lote(manzana, "1"))
    try:
        _abrir_lista_filtrada_por(page, base_url, manzana, filas=1)
        page.locator("#seleccionar-pagina").check()
        page.locator("#btn-aplicar-a-varios").click()
        expect(page.locator("#masiva-aplicar")).to_be_disabled()
        expect(page.locator("#masiva-confirmacion")).to_be_hidden()
    finally:
        borrar_lote_de_prueba(doc_id)
