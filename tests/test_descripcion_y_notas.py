"""
Test de Playwright para la separación entre descripción pública y notas
internas del lote (js/notas-internas.js, js/ficha.js, js/vista-lista.js).

Por qué existe este cambio: hasta acá el campo "observaciones" era las dos
cosas a la vez — la descripción que se publica y la libreta del corredor —
y se mostraba en la ficha sin ningún control de permisos. Como la
colección "lotes" es de lectura pública (ver firestore.rules), cualquier
visitante anónimo leía las notas de trabajo, tanto en la ficha como
pidiéndole el documento a la API.

El test que de verdad importa es el primero: un visitante SIN SESIÓN no
tiene que ver las notas por ningún lado. Ese es el criterio de éxito del
cambio entero.
"""

import uuid

import requests
from playwright.sync_api import expect

from conftest import (
    FIREBASE_PROJECT_ID,
    TEST_USER_EMAIL,
    TEST_USER_PASSWORD,
    _id_token_de_prueba,
    borrar_lote_de_prueba,
    crear_lote_de_prueba,
)

DESCRIPCION = "Terreno con vista despejada, apto para construir."
NOTA_INTERNA = "El dueño acepta 2000 menos. Cuesta encontrarlo: doblar en el molino."


def _lote(marcador):
    return {
        "manzana": f"DESC-{marcador}",
        "lote": "1",
        "nomenclatura": None,
        "superficie_m2": 700,
        "estado": "disponible",
        "precio_usd": 19000,
        "sector": "Zona Descripción",
        "servicios": {"luz": True, "agua": False, "gas": False, "cloaca": False},
        "descripcion": DESCRIPCION,
        "geometry": {
            "type": "Polygon",
            "coordinates": [
                {"lon": -65.085000, "lat": -32.415000},
                {"lon": -65.084780, "lat": -32.415000},
                {"lon": -65.084780, "lat": -32.415200},
                {"lon": -65.085000, "lat": -32.415200},
                {"lon": -65.085000, "lat": -32.415000},
            ],
        },
    }


def _url_notas(doc_id):
    return (
        f"https://firestore.googleapis.com/v1/projects/{FIREBASE_PROJECT_ID}"
        f"/databases/(default)/documents/lotes/{doc_id}/privado/notas"
    )


def _sembrar_nota(doc_id, texto):
    respuesta = requests.patch(
        _url_notas(doc_id),
        headers={"Authorization": f"Bearer {_id_token_de_prueba()}"},
        json={"fields": {"texto": {"stringValue": texto}}},
        timeout=15,
    )
    respuesta.raise_for_status()


def _loguearse(page, base_url):
    page.goto(base_url)
    page.locator("#btn-abrir-login").click()
    page.locator("#login-email").fill(TEST_USER_EMAIL)
    page.locator("#login-password").fill(TEST_USER_PASSWORD)
    page.locator("[data-testid='login-submit']").click()
    expect(page.locator("#sesion-activa")).to_be_visible()
    page.locator("#cerrar-panel-dashboard").click()


def test_un_visitante_sin_sesion_ve_la_descripcion_pero_nunca_las_notas(page, base_url):
    marcador = uuid.uuid4().hex[:8]
    doc_id = crear_lote_de_prueba(_lote(marcador))
    try:
        _sembrar_nota(doc_id, NOTA_INTERNA)

        # Sin login en ningún momento: así entra cualquiera al link de un lote.
        page.goto(f"{base_url}/?lote={doc_id}")
        expect(page.locator("#ficha-descripcion")).to_have_text(DESCRIPCION)

        expect(page.locator("#ficha-notas")).to_be_hidden()
        expect(page.locator("#ficha-notas-dt")).to_be_hidden()
        # Y no alcanza con que la fila esté oculta: el texto no tiene que
        # estar en ninguna parte del documento, ni escondido en el DOM.
        assert NOTA_INTERNA not in page.content()

        # La otra puerta de entrada, la que no pasa por la app: pedirle el
        # lote a la API de Firestore sin ninguna credencial.
        publico = requests.get(
            f"https://firestore.googleapis.com/v1/projects/{FIREBASE_PROJECT_ID}"
            f"/databases/(default)/documents/lotes/{doc_id}",
            timeout=15,
        )
        assert publico.status_code == 200, "el lote debería seguir siendo público"
        assert NOTA_INTERNA not in publico.text

        # Y la subcolección de notas, directamente, tiene que rechazarlo.
        sin_sesion = requests.get(_url_notas(doc_id), timeout=15)
        assert sin_sesion.status_code in (401, 403), f"esperaba rechazo, vino {sin_sesion.status_code}"
    finally:
        borrar_lote_de_prueba(doc_id)


def test_con_sesion_las_notas_se_ven_en_la_ficha(page, base_url):
    marcador = uuid.uuid4().hex[:8]
    doc_id = crear_lote_de_prueba(_lote(marcador))
    try:
        _sembrar_nota(doc_id, NOTA_INTERNA)
        _loguearse(page, base_url)
        page.goto(f"{base_url}/?lote={doc_id}")

        expect(page.locator("#ficha-notas")).to_have_text(NOTA_INTERNA)
        expect(page.locator("#ficha-descripcion")).to_have_text(DESCRIPCION)
    finally:
        borrar_lote_de_prueba(doc_id)


def test_editar_un_lote_guarda_cada_texto_en_su_lugar(page, base_url):
    marcador = uuid.uuid4().hex[:8]
    doc_id = crear_lote_de_prueba(_lote(marcador))
    nota_nueva = f"Nota editada {marcador}"
    try:
        _loguearse(page, base_url)
        page.goto(f"{base_url}/?lote={doc_id}")
        page.locator("#btn-editar-lote-completo").click()

        page.locator("#editar-lote-notas").fill(nota_nueva)
        page.locator("[data-testid='editar-lote-guardar']").click()

        # La nota tiene que haber ido a la subcolección, no al lote.
        guardada = requests.get(
            _url_notas(doc_id), headers={"Authorization": f"Bearer {_id_token_de_prueba()}"}, timeout=15
        )
        assert guardada.status_code == 200
        assert guardada.json()["fields"]["texto"]["stringValue"] == nota_nueva

        lote = requests.get(
            f"https://firestore.googleapis.com/v1/projects/{FIREBASE_PROJECT_ID}"
            f"/databases/(default)/documents/lotes/{doc_id}",
            timeout=15,
        )
        assert nota_nueva not in lote.text, "la nota interna no puede terminar en el documento público"
    finally:
        borrar_lote_de_prueba(doc_id)
