"""Las reglas de qué es una consulta válida (js/consulta-lote.js).

Se prueban SIN Firestore y SIN navegador de verdad, importando el módulo
suelto: son decisiones puras y así se pueden probar todos los bordes
rápido.

POR QUÉ IMPORTA QUE ESTO ESTÉ BIEN. Estas reglas las aplica un endpoint
PÚBLICO (functions/consulta-lote.js): no hay sesión que filtre nada, así
que son lo único que separa el CRM de cualquiera con el link. Y del otro
lado, si son demasiado estrictas, se pierde una consulta real — que para
una inmobiliaria es peor que un poco de spam.
"""

import json

import pytest

MODULO = "/js/consulta-lote.js"


@pytest.fixture
def evaluar(page, base_url):
    """Corre una función del módulo en el navegador y devuelve el resultado."""
    page.goto(base_url)

    def _correr(expresion, *args):
        return page.evaluate(
            f"""(args) => import('{MODULO}').then((m) => {{ const f = {expresion}; return f(m, ...args); }})""",
            list(args),
        )

    return _correr


# --- Lo que tiene que entrar ---------------------------------------------


def test_una_consulta_normal_pasa(evaluar):
    r = evaluar(
        "(m, d) => m.validarConsulta(d)",
        {"loteId": "abc123", "nombre": "Ana Pérez", "telefono": "266 4123456",
         "email": "ana@ejemplo.com", "mensaje": "¿Está disponible?"},
    )
    assert r["ok"] is True
    assert r["consulta"]["nombre"] == "Ana Pérez"


def test_el_email_es_opcional(evaluar):
    """El teléfono alcanza: pedir mail de más pierde consultas."""
    r = evaluar(
        "(m, d) => m.validarConsulta(d)",
        {"loteId": "abc123", "nombre": "Ana", "telefono": "2664123456"},
    )
    assert r["ok"] is True
    assert r["consulta"]["email"] == ""


def test_el_mensaje_es_opcional(evaluar):
    """Mucha gente deja solo el teléfono para que la llamen."""
    r = evaluar(
        "(m, d) => m.validarConsulta(d)",
        {"loteId": "abc123", "nombre": "Ana", "telefono": "2664123456"},
    )
    assert r["ok"] is True


@pytest.mark.parametrize(
    "telefono",
    ["+54 9 266 412-3456", "0266 15 4123456", "2664123456", "266-412-3456"],
)
def test_acepta_los_formatos_de_telefono_que_se_usan_de_verdad(evaluar, telefono):
    """En Argentina conviven todos estos. Exigir uno solo es la forma
    segura de perder consultas reales."""
    r = evaluar(
        "(m, d) => m.validarConsulta(d)",
        {"loteId": "abc123", "nombre": "Ana", "telefono": telefono},
    )
    assert r["ok"] is True, f"rechazó un teléfono válido: {telefono}"


def test_recorta_los_espacios_de_los_bordes(evaluar):
    r = evaluar(
        "(m, d) => m.validarConsulta(d)",
        {"loteId": "abc123", "nombre": "  Ana  ", "telefono": " 2664123456 "},
    )
    assert r["consulta"]["nombre"] == "Ana"
    assert r["consulta"]["telefono"] == "2664123456"


# --- Lo que tiene que rebotar --------------------------------------------


def test_sin_nombre_no_entra(evaluar):
    r = evaluar("(m, d) => m.validarConsulta(d)", {"loteId": "abc", "telefono": "2664123456"})
    assert r["ok"] is False
    assert "nombre" in r["error"].lower()


def test_sin_telefono_no_entra(evaluar):
    """Un lead sin forma de contactarlo no es un lead."""
    r = evaluar("(m, d) => m.validarConsulta(d)", {"loteId": "abc", "nombre": "Ana"})
    assert r["ok"] is False
    assert "teléfono" in r["error"].lower()


def test_un_telefono_sin_ningun_numero_no_entra(evaluar):
    r = evaluar(
        "(m, d) => m.validarConsulta(d)",
        {"loteId": "abc", "nombre": "Ana", "telefono": "llamame"},
    )
    assert r["ok"] is False


def test_sin_lote_no_entra(evaluar):
    """Una consulta que no dice por qué propiedad es no sirve para nada."""
    r = evaluar("(m, d) => m.validarConsulta(d)", {"nombre": "Ana", "telefono": "2664123456"})
    assert r["ok"] is False


def test_un_lote_con_forma_rara_no_entra(evaluar):
    """El id va a una URL de Firestore: barras y puntos no pueden pasar."""
    r = evaluar(
        "(m, d) => m.validarConsulta(d)",
        {"loteId": "../../otra-coleccion/doc", "nombre": "Ana", "telefono": "2664123456"},
    )
    assert r["ok"] is False


def test_un_email_mal_escrito_no_entra(evaluar):
    r = evaluar(
        "(m, d) => m.validarConsulta(d)",
        {"loteId": "abc", "nombre": "Ana", "telefono": "2664123456", "email": "ana arroba ejemplo"},
    )
    assert r["ok"] is False
    assert "email" in r["error"].lower()


def test_un_mensaje_enorme_no_entra(evaluar):
    """Sin tope, el tamaño de lo que se guarda en la base lo decide
    quien postea."""
    r = evaluar(
        "(m, d) => m.validarConsulta(d)",
        {"loteId": "abc", "nombre": "Ana", "telefono": "2664123456", "mensaje": "x" * 501},
    )
    assert r["ok"] is False


def test_un_nombre_enorme_no_entra(evaluar):
    r = evaluar(
        "(m, d) => m.validarConsulta(d)",
        {"loteId": "abc", "nombre": "A" * 81, "telefono": "2664123456"},
    )
    assert r["ok"] is False


def test_no_se_rompe_con_cualquier_cosa(evaluar):
    """El endpoint es público: le puede llegar literalmente cualquier
    cosa, y tiene que contestar 'no', no explotar."""
    for basura in [None, {}, {"loteId": 5, "nombre": [], "telefono": {}}]:
        r = evaluar("(m, d) => m.validarConsulta(d)", basura)
        assert r["ok"] is False


# --- El campo trampa ------------------------------------------------------


def test_el_campo_trampa_vacio_es_una_persona(evaluar):
    assert evaluar("(m, d) => m.pareceRobot(d)", {"nombre": "Ana", "apellido": ""}) is False


def test_el_campo_trampa_lleno_es_un_robot(evaluar):
    assert evaluar("(m, d) => m.pareceRobot(d)", {"nombre": "Ana", "apellido": "Pérez"}) is True


def test_sin_campo_trampa_no_se_asume_robot(evaluar):
    """Un pedido viejo o de otro cliente no tiene por qué traerlo."""
    assert evaluar("(m, d) => m.pareceRobot(d)", {"nombre": "Ana"}) is False


# --- La forma del contacto que se guarda ---------------------------------


def test_el_contacto_tiene_la_forma_que_espera_el_crm(evaluar):
    """SI ESTO SE ROMPE, el contacto se guarda igual y se ve roto en el
    tablero — que es mucho peor que un error al guardar.

    lotes_interes son objetos {id, titulo}, no ids sueltos: así lo arma
    crearContactoDesdeInteresado en js/crm-datos.js y así lo lee el CRM.
    """
    contacto = evaluar(
        "(m, d, extra) => m.contactoDesdeConsulta(m.validarConsulta(d).consulta, extra)",
        {"loteId": "abc123", "nombre": "Ana", "telefono": "2664123456", "mensaje": "Hola"},
        {"creadoPor": "uid-web", "tituloLote": "Manzana 5 — Lote 7", "ahora": "2026-09-18T10:00:00.000Z"},
    )
    assert contacto["lotes_interes"] == [{"id": "abc123", "titulo": "Manzana 5 — Lote 7"}]
    assert contacto["estado"] == "nuevo"
    assert contacto["origen"] == "web"
    assert contacto["creado_por"] == "uid-web"
    assert contacto["asignado_a"] is None
    assert contacto["actividades"][0]["texto"] == "Hola"
    assert contacto["fecha_creacion"] == contacto["fecha_actualizacion"]


def test_el_email_del_interesado_queda_en_la_nota(evaluar):
    """El CRM no tiene campo propio para el mail de una consulta web, y
    perderlo sería perder una vía de contacto."""
    contacto = evaluar(
        "(m, d, extra) => m.contactoDesdeConsulta(m.validarConsulta(d).consulta, extra)",
        {"loteId": "abc", "nombre": "Ana", "telefono": "2664123456",
         "email": "ana@ejemplo.com", "mensaje": "Hola"},
        {"creadoPor": "uid", "tituloLote": "Lote", "ahora": "2026-09-18T10:00:00.000Z"},
    )
    assert "ana@ejemplo.com" in contacto["actividades"][0]["texto"]


def test_una_consulta_sin_mensaje_igual_dice_algo(evaluar):
    """Una actividad vacía en el historial no le sirve a nadie."""
    contacto = evaluar(
        "(m, d, extra) => m.contactoDesdeConsulta(m.validarConsulta(d).consulta, extra)",
        {"loteId": "abc", "nombre": "Ana", "telefono": "2664123456"},
        {"creadoPor": "uid", "tituloLote": "Manzana 5 — Lote 7", "ahora": "2026-09-18T10:00:00.000Z"},
    )
    assert "Manzana 5 — Lote 7" in contacto["actividades"][0]["texto"]
