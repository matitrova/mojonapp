"""Que la app no vuelva a releer la cartera entera en cada carga.

EL PROBLEMA, MEDIDO EL 2026-09-25. Firestore cobra POR DOCUMENTO leído
del servidor: 50.000 por día en el plan gratuito. La app traía la
colección de lotes completa en cada carga de página, sin ninguna caché.
Con 180 lotes son 181 lecturas por carga, o sea 276 cargas al día para
TODA la agencia antes de que la app empiece a responder 429 — a la
inmobiliaria y a sus clientes por igual. Y desde que el catálogo y las
páginas de lote son públicas, cada comprador que abre un link también
las paga.

POR QUÉ HACE FALTA UN TEST Y NO ALCANZA CON HABERLO ARREGLADO. Esto
falla CALLADO: si alguien saca persistentLocalCache de
js/firebase-config.js, o vuelve a poner un getDocs en vez de la escucha,
la app se ve exactamente igual. El único síntoma aparece semanas después,
cuando la cuenta se agota a media mañana y nadie sabe por qué.

Se mide de dónde vino cada tanda de lotes: la app lo anota en
#mapa[data-lotes-de-la-cache] (ver cargarLotesDesdeFirestore en
js/mapa.js). Los documentos que salen de la caché son gratis; los que
vienen del servidor se cobran.
"""

import uuid

import pytest
from playwright.sync_api import expect

from conftest import borrar_lote_de_prueba, crear_lote_de_prueba

GEOMETRIA = {
    "type": "Polygon",
    "coordinates": [
        {"lon": -65.0900, "lat": -32.4300},
        {"lon": -65.0893, "lat": -32.4300},
        {"lon": -65.0893, "lat": -32.4307},
        {"lon": -65.0900, "lat": -32.4307},
        {"lon": -65.0900, "lat": -32.4300},
    ],
}


def _de_donde_vinieron(page):
    d = page.evaluate(
        """() => {
             const d = document.getElementById('mapa').dataset;
             return { cache: d.lotesDeLaCache, cambios: d.lotesCambiados };
           }"""
    )
    return d


def test_la_segunda_carga_no_le_pide_los_lotes_al_servidor(page, base_url):
    """EL TEST DEL AHORRO.

    La primera carga paga los N lotes; a partir de ahí, el SDK guarda un
    token y solo pide lo que cambió. Un corredor que abre la app veinte
    veces al día pasa de 20×N lecturas a N.
    """
    doc_id = crear_lote_de_prueba(
        {"manzana": f"CACHE-{uuid.uuid4().hex[:8]}", "lote": "1", "superficie_m2": 700,
         "estado": "disponible", "geometry": GEOMETRIA}
    )
    try:
        page.goto(base_url)
        page.wait_for_selector("#mapa[data-lotes-de-la-cache]", timeout=30000)
        page.wait_for_timeout(2500)
        primera = _de_donde_vinieron(page)
        assert primera["cache"] == "0", (
            "la PRIMERA carga tiene que venir del servidor: si ya viniera de la "
            "caché, este test no estaría probando nada"
        )

        page.reload()
        page.wait_for_selector("#mapa[data-lotes-de-la-cache]", timeout=30000)
        page.wait_for_timeout(2500)
        segunda = _de_donde_vinieron(page)
        assert segunda["cache"] == "1", (
            f"la segunda carga volvió a pedirle los lotes al servidor ({segunda}). "
            "Sin caché, cada carga de página cuesta un documento por lote."
        )
    finally:
        borrar_lote_de_prueba(doc_id)


def test_la_cache_persistente_esta_configurada():
    """GUARDIA SOBRE LOS DOS ARCHIVOS, no sobre el comportamiento.

    El de arriba prueba el efecto; este dice CUÁL es la pieza, para que
    el día que falle se sepa dónde mirar. Y cubre algo que el otro no
    puede: que el config que genera el servidor de tests tenga la misma
    caché que el real — si no la tuviera, los tests correrían contra un
    camino de datos distinto del que se despliega.
    """
    from pathlib import Path

    raiz = Path(__file__).resolve().parent.parent
    real = (raiz / "js" / "firebase-config.js").read_text(encoding="utf-8")
    generado = (raiz / "scripts" / "servidor_dev.py").read_text(encoding="utf-8")

    for nombre, texto in (("js/firebase-config.js", real), ("scripts/servidor_dev.py", generado)):
        # SE MIRA LA LLAMADA, NO EL IMPORT. La primera versión de este
        # guardia buscaba "persistentLocalCache" a secas y pasaba en
        # verde con la caché desactivada, porque el import seguía ahí.
        # Verificado mutando: con localCache en undefined, los dos tests
        # de comportamiento fallaban y este pasaba igual.
        assert "localCache:" in texto, f"{nombre} ya no le pasa una caché a Firestore"
        assert "persistentLocalCache(" in texto, (
            f"{nombre} perdió la caché persistente: sin ella, cada carga de página "
            "vuelve a leer la cartera entera del servidor"
        )
        assert "persistentMultipleTabManager(" in texto, (
            f"{nombre} perdió el manejo de varias pestañas: sin él, la segunda "
            "pestaña abierta no usa la caché y vuelve a pagar la cartera entera"
        )
        assert "getFirestore(app)" not in texto, (
            f"{nombre} volvió a getFirestore pelado, que no cachea nada"
        )


def test_la_pagina_de_un_lote_no_lee_la_cartera_entera():
    """GUARDIA SOBRE EL CÓDIGO de la página pública.

    Un comprador que abre /lote/<id> tiene que pagar ESE lote, no los
    180 de la cartera. Cien personas abriendo el mismo link en un grupo
    de WhatsApp eran 18.100 lecturas y la app en 429.

    Se lee el fuente porque el efecto no se puede medir desde afuera: la
    página se ve igual en los dos casos.
    """
    from pathlib import Path

    fuente = (Path(__file__).resolve().parent.parent / "js" / "lote-publico.js").read_text(encoding="utf-8")
    assert "traerUnLote" in fuente, "se perdió la lectura de un solo lote"
    assert "getDoc(doc(db," in fuente, (
        "la página del lote dejó de pedir un documento puntual"
    )


@pytest.mark.con_sesion
def test_un_lote_nuevo_aparece_sin_recargar(page, base_url):
    """EL REGALO DE LA ESCUCHA VIVA, y también su riesgo.

    Con onSnapshot, lo que carga un corredor aparece solo en la pantalla
    del otro. Se prueba acá porque es la contracara del ahorro: si
    alguien volviera a un getDocs, el ahorro se pierde Y esto deja de
    andar, y este test lo dice con todas las letras.
    """
    page.goto(base_url)
    page.wait_for_selector("#mapa[data-lotes-de-la-cache]", timeout=30000)
    page.wait_for_timeout(3000)

    doc_id = crear_lote_de_prueba(
        {"manzana": f"VIVO-{uuid.uuid4().hex[:8]}", "lote": "9", "superficie_m2": 800,
         "estado": "disponible", "geometry": GEOMETRIA}
    )
    try:
        # Sin recargar: lo tiene que traer la escucha.
        expect(page.locator(f".lote-{doc_id}")).to_have_count(1, timeout=25000)
    finally:
        borrar_lote_de_prueba(doc_id)


def test_el_mapa_no_se_reencuadra_solo_cuando_cambia_un_lote(page, base_url):
    """Con la escucha viva, un cambio de OTRO corredor no puede moverte
    el mapa de abajo del mouse. Encuadrar es una decisión de arranque
    ("mostrame la cartera"), no algo que haya que rehacer porque cambió
    un precio."""
    page.goto(base_url)
    page.wait_for_selector("#mapa[data-encuadre]", timeout=30000)
    page.wait_for_timeout(3000)

    antes = page.evaluate(
        """() => import('/js/mapa.js').then((m) => ({
             c: m.mapa.getCenter(), z: m.mapa.getZoom() }))"""
    )
    doc_id = crear_lote_de_prueba(
        {"manzana": f"QUIETO-{uuid.uuid4().hex[:8]}", "lote": "2", "superficie_m2": 900,
         "estado": "disponible",
         "geometry": {"type": "Polygon", "coordinates": [
             {"lon": -66.4000, "lat": -33.7000}, {"lon": -66.3993, "lat": -33.7000},
             {"lon": -66.3993, "lat": -33.7007}, {"lon": -66.4000, "lat": -33.7007},
             {"lon": -66.4000, "lat": -33.7000}]}}
    )
    try:
        page.wait_for_timeout(6000)
        despues = page.evaluate(
            """() => import('/js/mapa.js').then((m) => ({
                 c: m.mapa.getCenter(), z: m.mapa.getZoom() }))"""
        )
        assert despues["z"] == antes["z"], (
            f"el zoom cambió solo, de {antes['z']} a {despues['z']}: el mapa se "
            "reencuadró por un lote que cargó otro"
        )
        assert abs(despues["c"]["lat"] - antes["c"]["lat"]) < 0.0005, (
            f"el mapa se movió solo: de {antes['c']} a {despues['c']}"
        )
    finally:
        borrar_lote_de_prueba(doc_id)
