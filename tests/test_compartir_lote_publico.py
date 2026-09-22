"""Qué link reconoce la vista previa al compartir (functions/_middleware.js).

POR QUÉ IMPORTA. Ese middleware es lo que convierte un link pegado en
WhatsApp en una tarjeta con la superficie, el precio y el nombre de la
inmobiliaria. Corre en el servidor (el crawler de WhatsApp no ejecuta el
JS de la app), así que nada de lo que pasa en el navegador lo prueba.

EL BUG QUE ESTO CUBRE: el middleware solo miraba "?lote=<id>" en la
home. La página pública —"/lote/<id>", que es justamente el link que se
le manda a un comprador— caía en el "no hay nada que enriquecer" y se
compartía como "MojonApp" pelado.

Solo se prueba idDeLoteEnLaUrl, que es la decisión: el resto de la
función habla con Firestore y con HTMLRewriter (una API que solo existe
en Cloudflare) y se verifica contra el deploy, como catastro-proxy.js.
"""

import re
from pathlib import Path

import pytest

MODULO = "/functions/_middleware.js"


@pytest.fixture
def id_en(page, base_url):
    """Devuelve el id de lote que el middleware saca de una URL."""
    page.goto(base_url)

    def _correr(url):
        return page.evaluate(
            f"""(url) => import('{MODULO}').then((m) => m.idDeLoteEnLaUrl(new URL(url)))""",
            url,
        )

    return _correr


BASE = "https://mojonapp.com.ar"


# --- Las dos formas de link que un corredor comparte ---------------------


def test_reconoce_la_pagina_publica(id_en):
    """El link que se le manda al comprador. Antes NO se reconocía."""
    assert id_en(f"{BASE}/lote/abc123") == "abc123"


def test_reconoce_el_lote_en_la_home(id_en):
    """"Compartir este lote" desde la ficha del corredor."""
    assert id_en(f"{BASE}/?lote=abc123") == "abc123"


def test_la_pagina_publica_con_barra_final_tambien(id_en):
    assert id_en(f"{BASE}/lote/abc123/") == "abc123"


# --- Lo que tiene que dejar pasar sin tocar ------------------------------


def test_la_home_pelada_no_es_un_lote(id_en):
    """Si devolviera algo, CADA pedido a la app pagaría dos lecturas de
    Firestore de más."""
    assert id_en(f"{BASE}/") is None


def test_una_pantalla_de_la_app_no_es_un_lote(id_en):
    assert id_en(f"{BASE}/contactos") is None


def test_un_archivo_estatico_no_es_un_lote(id_en):
    assert id_en(f"{BASE}/js/app.js") is None


def test_lote_sin_id_no_es_un_lote(id_en):
    assert id_en(f"{BASE}/lote/") is None


def test_un_lote_en_otra_ruta_no_cuenta(id_en):
    """"?lote=" solo vale en la home: en /contactos el router lo borra de
    la URL, así que ahí no significa nada."""
    assert id_en(f"{BASE}/contactos?lote=abc123") is None


# --- Lo que manda cualquiera --------------------------------------------
#
# El id no lo elige la app: lo elige quien arma el link. Y termina pegado
# en la URL REST de Firestore, así que acá se decide qué entra.


def test_un_id_que_no_tiene_forma_de_id_se_rechaza(id_en):
    """Antes esto devolvía "abc 123" y lo mandaba a Firestore.

    Un id de Firestore son letras, números, guion y guion bajo. Cualquier
    otra cosa es alguien probando, no un lote.
    """
    assert id_en(f"{BASE}/lote/abc%20123") is None


def test_no_se_puede_salir_del_lugar_donde_viven_los_lotes(id_en):
    """EL AGUJERO QUE ESTO TAPA.

    El corte por "/" pasaba ANTES de decodificar, así que un %2F
    sobrevivía y después se volvía una barra de verdad. Pegado en
    `${base}/lotes/${id}`, el fetch resolvía los ".." solo: el preview
    leía un documento de OTRO proyecto y armaba la tarjeta de WhatsApp
    con datos ajenos — pero con el dominio real de la inmobiliaria y su
    nombre en og:site_name. Una tarjeta que parece de la inmobiliaria y
    no lo es.
    """
    assert id_en(f"{BASE}/lote/x%2F..%2F..%2Fprojects%2Fotro%2Fdocuments%2Flotes%2Ffalso") is None
    assert id_en(f"{BASE}/lote/..%2F..%2Fusuarios%2Falguien") is None
    # Y por el otro camino, el de "?lote=", que no pasa por decodeURIComponent.
    assert id_en(f"{BASE}/?lote=../../usuarios/alguien") is None


def test_un_escape_roto_no_tira(id_en):
    """Un "%" suelto hace que decodeURIComponent tire, y una excepción
    acá rompería la carga de la página entera para ese visitante."""
    assert id_en(f"{BASE}/lote/abc%ZZ") is None


def test_un_id_de_verdad_sigue_pasando(id_en):
    """El filtro no puede dejar afuera los ids que genera Firestore."""
    assert id_en(f"{BASE}/lote/A1b2C3d4E5f6G7h8I9j0") == "A1b2C3d4E5f6G7h8I9j0"
    assert id_en(f"{BASE}/lote/con-guion_y_bajo") == "con-guion_y_bajo"


# ---------------------------------------------------------------------------
# La imagen de la tarjeta
# ---------------------------------------------------------------------------
#
# POR QUÉ IMPORTA. Un comprador decide en un segundo si abre el link o
# sigue scrolleando, y lo que lo decide es la foto de la propiedad. La
# app declaraba un SVG como og:image — WhatsApp y Facebook DESCARTAN el
# SVG, así que la tarjeta salía sin ninguna imagen: justo lo que esa
# etiqueta venía a arreglar, y sin nada que fallara a la vista.


@pytest.fixture
def foto_de(page, base_url):
    page.goto(base_url)

    def _correr(campos):
        return page.evaluate(
            f"""(c) => import('{MODULO}').then((m) => m.fotoParaLaTarjeta(c))""",
            campos,
        )

    return _correr


def _campos_con_fotos(*urls):
    """La forma en que Firestore devuelve un array de mapas por REST."""
    return {
        "fotos": {
            "arrayValue": {
                "values": [
                    {"mapValue": {"fields": {"url": {"stringValue": u}, "id": {"stringValue": "x"}}}}
                    for u in urls
                ]
            }
        }
    }


CLOUDINARY = "https://res.cloudinary.com/demo/image/upload/v1699/lotes/frente.jpg"


def test_la_tarjeta_lleva_la_primera_foto_del_lote(foto_de):
    r = foto_de(_campos_con_fotos(CLOUDINARY, "https://res.cloudinary.com/demo/image/upload/otra.jpg"))
    assert r is not None
    assert "lotes/frente.jpg" in r


def test_la_foto_se_pide_del_tamaño_de_la_tarjeta(foto_de):
    """La foto original puede pesar varios megas y Facebook descarta las
    de más de 8 MB. Cloudinary recorta con una transformación en la
    URL, así que se le pide el tamaño exacto."""
    r = foto_de(_campos_con_fotos(CLOUDINARY))
    assert "w_1200,h_630" in r
    assert r.startswith("https://res.cloudinary.com/demo/image/upload/")
    # Y no se pierde la parte de la URL que identifica a la imagen.
    assert r.endswith("v1699/lotes/frente.jpg")


def test_un_lote_sin_fotos_no_tiene_foto_para_la_tarjeta(foto_de):
    """Ahí queda la imagen de reserva que ya viene en el HTML."""
    assert foto_de({}) is None
    assert foto_de({"fotos": {"arrayValue": {}}}) is None
    assert foto_de(None) is None


def test_una_foto_que_no_es_de_cloudinary_se_manda_tal_cual(foto_de):
    """No se le puede pedir un recorte a un servidor cualquiera, pero
    una foto sin recortar es mejor que ninguna."""
    otra = "https://ejemplo.com/foto.jpg"
    assert foto_de(_campos_con_fotos(otra)) == otra


def test_una_entrada_con_forma_rara_no_tira(foto_de):
    """Lo que hay en Firestore lo pudo haber editado alguien a mano."""
    assert foto_de({"fotos": {"stringValue": "no soy un array"}}) is None
    assert foto_de({"fotos": {"arrayValue": {"values": [{"mapValue": {"fields": {}}}]}}}) is None


def test_ninguna_metaetiqueta_de_imagen_apunta_a_un_svg():
    """GUARDIA. Esto ya pasó una vez y nadie lo vio.

    og:image apuntaba a un .svg. WhatsApp y Facebook lo descartan sin
    decir nada, así que la tarjeta salía sin imagen — y del lado de
    quien comparte no hay forma de darse cuenta salvo mandándose el
    link a uno mismo. Se lee el HTML fuente: es lo único que no puede
    "pasar por otro motivo".
    """
    raiz = Path(__file__).resolve().parent.parent
    html = (raiz / "index.html").read_text(encoding="utf-8")

    etiquetas = re.findall(r'<meta[^>]*(?:og:image|twitter:image)[^>]*>', html)
    assert etiquetas, "no quedó ninguna metaetiqueta de imagen"
    for etiqueta in etiquetas:
        assert ".svg" not in etiqueta, f"apunta a un SVG, que WhatsApp descarta: {etiqueta}"

    # Y el archivo que declara tiene que existir de verdad: una etiqueta
    # apuntando a un 404 se ve igual de vacía que una a un SVG.
    assert (raiz / "og-imagen.png").exists(), (
        "falta og-imagen.png — generalo con scripts/generar_og_imagen.py"
    )


@pytest.fixture
def imagen_de(page, base_url):
    page.goto(base_url)

    def _correr(datos, origen):
        return page.evaluate(
            f"""(a) => import('{MODULO}').then((m) => m.imagenDeLaTarjeta(a[0], a[1]))""",
            [datos, origen],
        )

    return _correr


def test_con_foto_la_tarjeta_lleva_la_foto(imagen_de):
    r = imagen_de({"foto": "https://res.cloudinary.com/demo/image/upload/x.jpg"}, "https://mojonapp.com.ar")
    assert r["url"].endswith("x.jpg")
    assert r["tipo"] == "image/jpeg"


def test_sin_foto_la_reserva_sale_del_dominio_que_esta_sirviendo(imagen_de):
    """EL BUG QUE ESTO TAPA, encontrado al publicar.

    index.html declara la imagen con el dominio de producción escrito a
    mano. Desde la vista previa ese archivo no existe — y Cloudflare
    Pages no devuelve 404 sino el index.html con HTTP 200, así que
    "parece" que está y en realidad es una página HTML. WhatsApp la
    descarta y la tarjeta sale sin imagen.

    O sea que lo único que no se podía verificar antes de publicar era,
    justamente, el arreglo de que la tarjeta tuviera imagen.
    """
    r = imagen_de({"foto": None}, "https://preview.mojonapp.pages.dev")
    assert r["url"] == "https://preview.mojonapp.pages.dev/og-imagen.png"
    assert r["tipo"] == "image/png"


def test_sin_datos_igual_devuelve_una_imagen(imagen_de):
    r = imagen_de(None, "https://mojonapp.com.ar")
    assert r["url"] == "https://mojonapp.com.ar/og-imagen.png"
