"""El número correlativo de cada contacto (js/numeracion.js).

PARA QUÉ EXISTE. Todo documento de Firestore ya tiene un id, pero es un
código de 20 caracteres (db8IRHh6GDfIsuU6rmX6) que no se puede decir por
teléfono ni anotar en un papel, y que no aparecía en ninguna pantalla ni
en el CSV. Con dos contactos que se llaman igual no había nada que los
distinguiera. Pedido del dueño del producto el 2026-09-24.

Acá se prueba la parte que se puede probar sin escribir en Firestore: el
texto que se muestra. La reserva del número es una transacción contra la
base y se verifica en tests/test_crm.py, dando de alta contactos de
verdad.
"""

import pytest

MODULO = "/js/numeracion.js"


@pytest.fixture
def evaluar(page, base_url):
    page.goto(base_url)

    def _correr(expresion, *args):
        return page.evaluate(
            f"""(args) => import('{MODULO}').then((m) => {{ const f = {expresion}; return f(m, ...args); }})""",
            list(args),
        )

    return _correr


def test_un_contacto_numerado_se_muestra_con_numeral(evaluar):
    assert evaluar("(m, c) => m.numeroParaMostrar(c)", {"numero": 42}) == "#42"


def test_el_primer_contacto_es_el_uno(evaluar):
    """Y no el cero: nadie dice "el contacto cero"."""
    assert evaluar("(m, c) => m.numeroParaMostrar(c)", {"numero": 1}) == "#1"


@pytest.mark.parametrize(
    "contacto",
    [{}, {"numero": None}, {"numero": 0}, {"numero": "42"}, {"numero": -3}],
    ids=["sin campo", "null", "cero", "texto", "negativo"],
)
def test_lo_que_no_es_un_numero_no_muestra_nada(evaluar, contacto):
    """Los contactos de antes de que esto existiera no tienen número, y
    uno creado sin conexión tampoco. Mostrar "#" o "#null" es peor que no
    mostrar nada: parece un dato roto en vez de un dato que falta."""
    assert evaluar("(m, c) => m.numeroParaMostrar(c)", contacto) == ""


def test_sin_contacto_no_tira(evaluar):
    assert evaluar("(m) => m.numeroParaMostrar(null)") == ""
    assert evaluar("(m) => m.numeroParaMostrar(undefined)") == ""


def test_el_contador_vive_en_su_propia_coleccion(evaluar):
    """Se afirma acá para que un renombre no pase desapercibido: el
    nombre de la colección está también en firestore.rules (match
    /contadores/{nombre}) y en scripts/numerar_contactos.py, y los tres
    tienen que decir lo mismo o la numeración deja de funcionar sin que
    falle nada visible."""
    assert evaluar("(m) => m.COLECCION_CONTADORES") == "contadores"
    assert evaluar("(m) => m.CONTADOR_CONTACTOS") == "contactos"


def test_la_regla_de_firestore_solo_deja_sumar_uno():
    """GUARDIA SOBRE EL ARCHIVO DE REGLAS, no sobre el código.

    El contador lo puede mover cualquier logueado (es quien da de alta un
    contacto). Si la regla fuera "cualquier logueado escribe lo que
    quiera", alguien podría dejarlo en 9.999.999 y la numeración quedaría
    inservible para siempre. La regla tiene que dejar hacer UNA sola
    cosa: llevarlo de N a N+1.
    """
    from pathlib import Path

    reglas = (Path(__file__).resolve().parent.parent / "firestore.rules").read_text(encoding="utf-8")
    assert "match /contadores/{nombre}" in reglas, "falta la regla del contador"
    assert "soloSumaUno()" in reglas, "el contador no está acotado a sumar uno"
    # Y que no se haya aflojado a un write libre.
    bloque = reglas[reglas.index("match /contadores/{nombre}") :][:400]
    assert "allow write: if request.auth != null && soloSumaUno();" in bloque, (
        f"la regla del contador dejó de exigir soloSumaUno: {bloque[:200]}"
    )
