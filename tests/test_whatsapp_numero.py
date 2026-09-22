"""El número al que se manda un WhatsApp (js/crm-metricas.js).

POR QUÉ IMPORTA Y POR QUÉ NO SE VEÍA. De acá sale el link wa.me de tres
botones: el del contacto en el CRM, el de las plantillas de mensaje, y
el "Consultar por WhatsApp" de la página pública de un lote, que es el
que aprieta un comprador.

Si el número sale mal, NADA falla a la vista: el botón abre WhatsApp, el
mensaje aparece escrito, y recién ahí WhatsApp dice que ese número no
existe — o peor, el mensaje se va a un número ajeno. Del lado de la
inmobiliaria no se ve nada: simplemente no llegan consultas.

LA FUNCIÓN SACABA MAL EL 0 Y EL 15, que es exactamente como escribe el
teléfono cualquier persona en Argentina. De ocho formatos reales, cinco
armaban un link roto.
"""

import pytest

MODULO = "/js/crm-metricas.js"

# El mismo número de Merlo (San Luis) escrito de todas las formas en que
# lo escribe alguien de verdad. Todas tienen que terminar en el mismo
# link, porque son el mismo teléfono.
ESPERADO_MERLO = "5492664558821"

COMO_SE_ESCRIBE = [
    ("2664558821", "los diez dígitos pelados"),
    ("266 4 55-8821", "con espacios y guion"),
    ("(2664) 55-8821", "con el código de área entre paréntesis"),
    ("0266 4 55-8821", "con el 0 de larga distancia"),
    ("0266 15 455-8821", "con el 0 y el 15, la forma más común"),
    ("266 15 455 8821", "con el 15 y sin el 0"),
    ("+54 9 266 455 8821", "en formato internacional, ya listo"),
    ("+54 266 15 455 8821", "internacional pero todavía con el 15"),
    ("0054 9 266 455 8821", "con 00 en vez de +"),
    ("54 9 2664558821", "internacional sin el +"),
]


@pytest.fixture
def numero(page, base_url):
    page.goto(base_url)

    def _correr(telefono):
        return page.evaluate(
            f"""(t) => import('{MODULO}').then((m) => m.normalizarTelefonoWhatsapp(t))""",
            telefono,
        )

    return _correr


@pytest.mark.parametrize("escrito,como", COMO_SE_ESCRIBE, ids=[c[1] for c in COMO_SE_ESCRIBE])
def test_el_mismo_telefono_escrito_de_cualquier_forma_da_el_mismo_numero(numero, escrito, como):
    assert numero(escrito) == ESPERADO_MERLO, f"falla {como}: {escrito}"


def test_un_numero_de_buenos_aires_tambien(numero):
    """El código de área mide 2 dígitos acá y 4 en Merlo: el 15 no está
    en la misma posición, y ahí es donde se rompía."""
    assert numero("011 15 3456-7890") == "5491134567890"
    assert numero("11 3456-7890") == "5491134567890"


def test_un_numero_de_san_luis_capital(numero):
    """Código de área de 3 dígitos: la tercera posición posible del 15."""
    assert numero("0266 15 442-1234") == "5492664421234"
    assert numero("02652 15 44-1234") is not None


def test_sin_telefono_no_hay_numero(numero):
    assert numero("") is None
    assert numero(None) is None
    assert numero("   ") is None


def test_un_texto_sin_digitos_no_es_un_telefono(numero):
    """"Llamar a la oficina" en el campo teléfono no puede terminar en
    un link de WhatsApp."""
    assert numero("llamar a la oficina") is None


def test_un_abonado_que_empieza_con_54_no_pierde_sus_primeros_digitos(numero):
    """Un número porteño de ocho dígitos puede empezar con 54
    ("5455-8821") y ESO NO ES el código de país. Sacárselo dejaría un
    número mutilado que igual arma un link con pinta de válido."""
    assert numero("5455-8821").endswith("54558821")


def test_el_link_completo_lleva_el_numero_corregido(page, base_url):
    """Cierre de verdad: lo que se abre es el link, no el número suelto."""
    page.goto(base_url)
    link = page.evaluate(
        f"""() => import('{MODULO}').then((m) => m.linkWhatsapp('0266 15 455-8821', 'hola'))"""
    )
    assert link.startswith(f"https://wa.me/{ESPERADO_MERLO}?text="), link
