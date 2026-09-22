"""Las reglas de los datos de la inmobiliaria (js/inmobiliaria-datos.js).

Se prueban SIN Firestore, importando el módulo suelto en el navegador:
son decisiones puras y así se cubren todos los bordes rápido.

POR QUÉ IMPORTA. Lo que se guarda acá es lo que ve un comprador en la
página pública de un lote, y de acá sale el número al que llega la
consulta por WhatsApp. Un teléfono mal guardado no rompe nada visible:
simplemente la consulta no llega, y nadie se entera.
"""

import pytest

MODULO = "/js/inmobiliaria-datos.js"


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


COMPLETA = {
    "nombre": "Inmobiliaria Los Algarrobos",
    "telefono": "266 4 55-8821",
    "localidad": "Merlo, San Luis",
    "direccion": "Av. del Sol 1240",
    "horario": "Lunes a viernes de 9 a 13",
    "email": "contacto@algarrobos.com.ar",
    "web": "www.algarrobos.com.ar",
    "matricula": "CSI 1234",
    "logo_url": "https://res.cloudinary.com/demo/image/upload/logo.png",
}


# --- Lo que tiene que entrar ---------------------------------------------


def test_los_datos_completos_pasan(evaluar):
    r = evaluar("(m, d) => m.validarInmobiliaria(d)", COMPLETA)
    assert r["ok"] is True
    assert r["datos"]["nombre"] == "Inmobiliaria Los Algarrobos"
    assert r["datos"]["matricula"] == "CSI 1234"


def test_alcanza_con_el_nombre(evaluar):
    """Una inmobiliaria chica configura esto en un minuto y con lo que tiene
    a mano. Exigirle horario y matrícula la deja sin poder guardar nada."""
    r = evaluar("(m, d) => m.validarInmobiliaria(d)", {"nombre": "Pérez Propiedades"})
    assert r["ok"] is True
    assert r["datos"]["telefono"] is None
    assert r["datos"]["web"] is None


def test_los_espacios_de_mas_se_recortan(evaluar):
    r = evaluar("(m, d) => m.validarInmobiliaria(d)", {"nombre": "  Pérez  ", "localidad": " Merlo "})
    assert r["datos"]["nombre"] == "Pérez"
    assert r["datos"]["localidad"] == "Merlo"


def test_un_campo_con_solo_espacios_queda_vacio(evaluar):
    """Guardar "   " es guardar basura que después se dibuja como una línea
    en blanco en la página pública."""
    r = evaluar("(m, d) => m.validarInmobiliaria(d)", {"nombre": "Pérez", "direccion": "     "})
    assert r["datos"]["direccion"] is None


# --- Lo que NO tiene que entrar ------------------------------------------


def test_sin_nombre_no_se_puede_guardar(evaluar):
    r = evaluar("(m, d) => m.validarInmobiliaria(d)", {"telefono": "2664558821"})
    assert r["ok"] is False
    assert "nombre" in r["error"].lower()


def test_el_nombre_en_blanco_tampoco(evaluar):
    r = evaluar("(m, d) => m.validarInmobiliaria(d)", {"nombre": "   "})
    assert r["ok"] is False


def test_un_email_sin_arroba_se_rechaza(evaluar):
    r = evaluar("(m, d) => m.validarInmobiliaria(d)", {"nombre": "Pérez", "email": "contacto.algarrobos.com"})
    assert r["ok"] is False
    assert "email" in r["error"].lower()


def test_un_telefono_sin_numeros_se_rechaza(evaluar):
    """"Llamar a la oficina" en el campo teléfono deja un botón de WhatsApp
    que no lleva a ningún lado."""
    r = evaluar("(m, d) => m.validarInmobiliaria(d)", {"nombre": "Pérez", "telefono": "llamar a la oficina"})
    assert r["ok"] is False


def test_un_nombre_larguisimo_se_rechaza(evaluar):
    r = evaluar("(m, d) => m.validarInmobiliaria(d)", {"nombre": "x" * 200})
    assert r["ok"] is False


def test_un_horario_larguisimo_se_rechaza(evaluar):
    r = evaluar("(m, d) => m.validarInmobiliaria(d)", {"nombre": "Pérez", "horario": "x" * 400})
    assert r["ok"] is False


# --- La web se arregla sola ----------------------------------------------


def test_a_la_web_sin_esquema_se_le_agrega_https(evaluar):
    """Nadie escribe "https://" cuando le preguntan por su sitio, y un link
    sin esquema el navegador lo toma como ruta de la propia app."""
    r = evaluar("(m, d) => m.validarInmobiliaria(d)", {"nombre": "Pérez", "web": "www.algarrobos.com.ar"})
    assert r["datos"]["web"] == "https://www.algarrobos.com.ar"


def test_una_web_que_ya_trae_esquema_queda_igual(evaluar):
    r = evaluar("(m, d) => m.validarInmobiliaria(d)", {"nombre": "Pérez", "web": "http://algarrobos.com.ar"})
    assert r["datos"]["web"] == "http://algarrobos.com.ar"


# --- Lo que viene de la base ---------------------------------------------


def test_normalizar_tira_las_claves_desconocidas(evaluar):
    """Un documento editado a mano en la consola de Firebase no tiene por
    qué llegar entero a la página de un comprador."""
    r = evaluar(
        "(m, d) => m.normalizarInmobiliaria(d)",
        {"nombre": "Pérez", "telefono": "2664558821", "campo_raro": "<script>alert(1)</script>"},
    )
    assert "campo_raro" not in r
    assert r["nombre"] == "Pérez"


def test_normalizar_sin_nombre_es_como_no_haber_configurado_nada(evaluar):
    r = evaluar("(m, d) => m.normalizarInmobiliaria(d)", {"telefono": "2664558821"})
    assert r is None


def test_normalizar_aguanta_un_documento_vacio(evaluar):
    assert evaluar("(m) => m.normalizarInmobiliaria(null)") is None
    assert evaluar("(m) => m.normalizarInmobiliaria(undefined)") is None


def test_normalizar_ignora_valores_que_no_son_texto(evaluar):
    """En Firestore un campo puede terminar siendo un número o un array."""
    r = evaluar("(m, d) => m.normalizarInmobiliaria(d)", {"nombre": "Pérez", "telefono": 2664558821})
    assert r["telefono"] is None


# --- Cómo se muestra -----------------------------------------------------


def test_sin_inmobiliaria_el_titulo_cae_a_mojonapp(evaluar):
    assert evaluar("(m) => m.nombreParaMostrar(null)") == "MojonApp"


def test_con_inmobiliaria_el_titulo_es_el_de_ella(evaluar):
    assert evaluar("(m, d) => m.nombreParaMostrar(d)", COMPLETA) == "Inmobiliaria Los Algarrobos"


def test_la_ubicacion_junta_direccion_y_localidad(evaluar):
    assert evaluar("(m, d) => m.comoUbicarla(d)", COMPLETA) == "Av. del Sol 1240 · Merlo, San Luis"


def test_la_ubicacion_con_una_sola_parte_no_deja_separadores_sueltos(evaluar):
    r = evaluar("(m, d) => m.comoUbicarla(d)", {"direccion": None, "localidad": "Merlo"})
    assert r == "Merlo"


def test_sin_direccion_ni_localidad_no_hay_linea(evaluar):
    assert evaluar("(m, d) => m.comoUbicarla(d)", {"direccion": None, "localidad": None}) is None
    assert evaluar("(m) => m.comoUbicarla(null)") is None


# --- El botón de WhatsApp ------------------------------------------------


def test_con_telefono_el_boton_de_whatsapp_tiene_sentido(evaluar):
    assert evaluar("(m, d) => m.puedeRecibirWhatsapp(d)", COMPLETA) is True


def test_sin_telefono_el_boton_de_whatsapp_no_va(evaluar):
    """Es exactamente el bug que esta feature vino a arreglar: un botón de
    WhatsApp sin destino abre el selector de contactos del comprador y la
    consulta se pierde. Mejor no mostrarlo."""
    assert evaluar("(m, d) => m.puedeRecibirWhatsapp(d)", {"nombre": "Pérez", "telefono": None}) is False
    assert evaluar("(m) => m.puedeRecibirWhatsapp(null)") is False
