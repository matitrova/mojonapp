"""
Tests del criterio con el que se decide qué es "dato de prueba" y se
borra de Firestore (ver la fixture `limpiar_sobrantes_al_arrancar` en
conftest.py).

Por qué tiene tests propios: es la única parte del proyecto que BORRA
datos de producción. Si el patrón matcheara un nombre real, la limpieza
le borraría contactos a una inmobiliaria. Estos tests son la red que
evita eso, y corren sin red ni Firestore (es lógica pura).
"""

from datetime import datetime, timedelta, timezone

from conftest import (
    MINUTOS_PARA_CONSIDERAR_SOBRANTE,
    PATRON_DATO_DE_PRUEBA,
    _antiguedad_en_minutos,
)

# Nombres tal cual los generan los tests: f"PREFIJO-{uuid4().hex[:8]}".
NOMBRES_DE_PRUEBA = [
    "DASH-TEST-097a7047",
    "TABLA-1a2b3c4d",
    "TABLA-FILA-deadbeef",
    "CRMINT-0011223a",
    "ETQ-CON-abcdef01",
    "DEMANDA-PERDIDO-9988776f",
    "MOTIVO-1234567e",
    "AUTO-ESTANCADO-0a1b2c3d",
]

# Nombres que un corredor podría cargar de verdad. NINGUNO puede matchear.
NOMBRES_REALES = [
    "Juan Pérez",
    "María González",
    "Inmobiliaria Container Propiedades",
    "Merlo",
    "Villa de Merlo",
    "MERLO",                      # todo mayúsculas, pero sin marcador
    "LOTE-15",                    # mayúsculas con guion y número
    "MANZANA-A",
    "Carlos Gómez-Fernández",
    "00-06-44-05-000118-000008",  # nomenclatura catastral real
    # 8 dígitos son hexadecimal válido: este nombre matcheaba la primera
    # versión del patrón y habría sido borrado. Por eso el patrón exige
    # al menos una letra a-f en el marcador.
    "PARCELA-12345678",
    "LOTE-00000000",
    "Lote 3 - Barrio El Mirador",
    "",
]


def test_reconoce_los_nombres_que_generan_los_tests():
    for nombre in NOMBRES_DE_PRUEBA:
        assert PATRON_DATO_DE_PRUEBA.match(nombre), f"{nombre!r} debería contar como de prueba"


def test_no_toca_nombres_que_podrian_ser_reales():
    for nombre in NOMBRES_REALES:
        assert not PATRON_DATO_DE_PRUEBA.match(nombre), (
            f"PELIGRO: {nombre!r} matchea el patrón de borrado y podría ser un dato real"
        )


def test_un_marcador_tiene_que_medir_exactamente_ocho():
    # Siete o nueve caracteres no es un uuid4().hex[:8], así que no se toca.
    assert not PATRON_DATO_DE_PRUEBA.match("TEST-0a1b2c3")
    assert not PATRON_DATO_DE_PRUEBA.match("TEST-0a1b2c3d4")
    assert PATRON_DATO_DE_PRUEBA.match("TEST-0a1b2c3d")


def test_el_marcador_va_en_minusculas():
    """uuid4().hex devuelve hexadecimal en minúsculas. Un "ABCDEF01" en
    mayúsculas es más probable que sea un código real del corredor."""
    assert not PATRON_DATO_DE_PRUEBA.match("TEST-ABCDEF01")


def test_el_marcador_necesita_al_menos_una_letra():
    """La concesión deliberada del patrón: un marcador todo numérico no
    se borra, aunque sea de un test. Es el precio de no borrarle nunca
    un "PARCELA-12345678" real a un corredor — a esos los barre a mano
    scripts/limpiar_datos_de_prueba.py, con la lista a la vista."""
    assert not PATRON_DATO_DE_PRUEBA.match("TEST-12345678")
    assert PATRON_DATO_DE_PRUEBA.match("TEST-1234567a")
    assert PATRON_DATO_DE_PRUEBA.match("TEST-a1234567")


def _doc_creado_hace(minutos):
    creado = datetime.now(timezone.utc) - timedelta(minutes=minutos)
    return {"createTime": creado.isoformat().replace("+00:00", "Z")}


def test_la_antiguedad_protege_lo_que_se_acaba_de_crear():
    """La guarda contra borrarle los datos a una corrida en curso: lo que
    un test sembró hace un instante nunca puede entrar en la limpieza."""
    assert _antiguedad_en_minutos(_doc_creado_hace(0)) < MINUTOS_PARA_CONSIDERAR_SOBRANTE
    assert _antiguedad_en_minutos(_doc_creado_hace(5)) < MINUTOS_PARA_CONSIDERAR_SOBRANTE
    assert _antiguedad_en_minutos(_doc_creado_hace(120)) > MINUTOS_PARA_CONSIDERAR_SOBRANTE


def test_la_antiguedad_aguanta_el_formato_de_firestore():
    """Firestore manda RFC3339 con "Z" y hasta 9 decimales; fromisoformat
    no acepta más de 6, así que hay que recortarlos."""
    assert _antiguedad_en_minutos({"createTime": "2026-09-16T05:12:33.123456789Z"}) > 0
    assert _antiguedad_en_minutos({"createTime": "2026-09-16T05:12:33.123456Z"}) > 0
    assert _antiguedad_en_minutos({"createTime": "2026-09-16T05:12:33Z"}) > 0
    # Sin fecha se trata como recién creado, o sea NO se borra: ante la
    # duda, no tocar.
    assert _antiguedad_en_minutos({}) == 0
