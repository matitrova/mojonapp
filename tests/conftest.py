import os
import re
import socket
import subprocess
import sys
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path

import pytest
import requests
from dotenv import load_dotenv

RAIZ_PROYECTO = Path(__file__).resolve().parent.parent

load_dotenv(Path(__file__).resolve().parent / ".env")

# A qué proyecto Firebase le hablan los tests.
#
# POR QUÉ ES CONFIGURABLE. Hasta acá estos dos valores estaban fijos en
# el proyecto de PRODUCCIÓN, con dos consecuencias que se cobraron caro:
# los datos de prueba que quedaban sin borrar aparecían en el Dashboard
# real del cliente, y una corrida completa de la suite agotaba la cuota
# gratuita de Firestore (50.000 lecturas por día, contadas por
# documento) — o sea que después de correr los tests, la app en
# producción respondía 429 a cualquiera que entrara.
#
# Ahora salen del entorno (tests/.env), así que la suite puede correr
# contra un proyecto aparte. Si no están definidas se usa producción,
# pero avisando fuerte: vale seguir funcionando para quien todavía no
# armó su proyecto de pruebas, no vale que pase sin que se entere.
#
# Nada de esto es secreto (la seguridad real la dan firestore.rules, ver
# el comentario en js/firebase-config.js). Las credenciales del usuario
# de prueba sí, y viven solo en tests/.env, que no se versiona.
API_KEY_PRODUCCION = "AIzaSyCR9w0fwXixk4CZV051-srq9PsTvmp5lGQ"
PROJECT_ID_PRODUCCION = "mojonapp"

# `or` y no el default de .get(): en GitHub Actions, un secret que no
# está definido llega igual como variable de entorno con string VACÍO, y
# .get() devolvería "" en vez del default. Con eso, los tests apuntarían a
# un proyecto llamado "" y fallarían de una forma incomprensible.
FIREBASE_API_KEY = os.environ.get("FIREBASE_API_KEY") or API_KEY_PRODUCCION
FIREBASE_PROJECT_ID = os.environ.get("FIREBASE_PROJECT_ID") or PROJECT_ID_PRODUCCION
USA_PRODUCCION = FIREBASE_PROJECT_ID == PROJECT_ID_PRODUCCION

if USA_PRODUCCION:
    print(
        "\n"
        "  ==========================================================\n"
        "   ATENCION: los tests van a correr contra PRODUCCION\n"
        "   (proyecto Firebase 'mojonapp').\n"
        "\n"
        "   Van a escribir y borrar datos reales, y pueden agotar la\n"
        "   cuota diaria de Firestore y dejar la app respondiendo 429\n"
        "   a los clientes.\n"
        "\n"
        "   Para usar el proyecto de pruebas, definir en tests/.env:\n"
        "     FIREBASE_API_KEY=...\n"
        "     FIREBASE_PROJECT_ID=...\n"
        "   Ver scripts/sembrar_proyecto_de_pruebas.py\n"
        "  ==========================================================\n",
        file=sys.stderr,
    )

TEST_USER_EMAIL = os.environ["TEST_USER_EMAIL"]
TEST_USER_PASSWORD = os.environ["TEST_USER_PASSWORD"]

FIRESTORE_URL_BASE = (
    f"https://firestore.googleapis.com/v1/projects/{FIREBASE_PROJECT_ID}"
    "/databases/(default)/documents/lotes"
)

# La raíz de documentos, sin colección: la necesitan ":runQuery" y
# ":commit", que trabajan sobre la base entera y no sobre una colección.
FIRESTORE_RAIZ_RELATIVA = f"projects/{FIREBASE_PROJECT_ID}/databases/(default)/documents"
FIRESTORE_RAIZ = f"https://firestore.googleapis.com/v1/{FIRESTORE_RAIZ_RELATIVA}"


def _puerto_libre():
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


@pytest.fixture(scope="session")
def base_url():
    puerto = _puerto_libre()
    # scripts/servidor_dev.py y no "-m http.server" por dos motivos:
    #
    # 1. Devuelve index.html en las rutas del router (/contactos,
    #    /dashboard, etc.), que es lo que hace Cloudflare Pages en
    #    producción. Sin eso, los tests que entran directo a la URL de
    #    una sección (ver test_router.py) recibirían un 404 que en
    #    producción no existe.
    # 2. Sirve el firebase-config del proyecto que digan estas variables,
    #    así la APP que ve el navegador habla con el mismo proyecto que
    #    los helpers REST de este archivo. Si se desincronizaran, los
    #    tests fallarían de formas dificilísimas de entender: sembrando
    #    en un proyecto y buscando en el otro.
    entorno = {
        **os.environ,
        "MOJONAPP_FIREBASE_API_KEY": FIREBASE_API_KEY,
        "MOJONAPP_FIREBASE_PROJECT_ID": FIREBASE_PROJECT_ID,
    }
    proceso = subprocess.Popen(
        [sys.executable, str(RAIZ_PROYECTO / "scripts" / "servidor_dev.py"), str(puerto)],
        cwd=RAIZ_PROYECTO,
        env=entorno,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    url = f"http://127.0.0.1:{puerto}"

    for _ in range(50):
        try:
            with socket.create_connection(("127.0.0.1", puerto), timeout=0.2):
                break
        except OSError:
            time.sleep(0.1)
    else:
        proceso.terminate()
        raise RuntimeError("El servidor estático de prueba no arrancó a tiempo.")

    yield url

    proceso.terminate()
    proceso.wait(timeout=5)


# ---------------------------------------------------------------------------
# Un solo login por corrida
#
# POR QUÉ. Cada test se logueaba por la UI, o sea ~140 verificaciones de
# contraseña por corrida. Firebase Authentication tiene una cuota propia
# para eso, aparte de la de Firestore, y se agota con tres o cuatro
# corridas seguidas.
#
# Lo caro no es el límite sino cómo se disfraza: Firebase devuelve
# "QUOTA_EXCEEDED: Exceeded quota for verifying passwords", la app
# muestra "Email o contraseña incorrectos", y en los tests aparece como
# un timeout esperando #sesion-activa — o, todavía más confuso, como un
# fill("#login-email") que dice "element is not visible". Se parece
# muchísimo a un bug real; ya costó horas de diagnóstico y 13 fallos de
# una corrida completa que no eran fallos de nada.
#
# CÓMO. Se hace UN login por corrida y se guarda el estado del navegador;
# cada test que lo pide arranca con ese estado ya puesto. Firebase guarda
# la sesión en IndexedDB, que storage_state() históricamente no capturaba
# — de ahí el indexed_db=True, que existe desde Playwright 1.51.
#
# Es OPT-IN, con el marcador "con_sesion", y no al revés: hay 19 archivos
# que nunca loguean (favoritos anónimo, compartir lote, el catálogo
# público) a los que una sesión les cambiaría la pantalla debajo de los
# pies, y 4 tests que verifican justamente qué se ve SIN sesión.
# ---------------------------------------------------------------------------


def pytest_configure(config):
    config.addinivalue_line(
        "markers",
        "con_sesion: el test arranca ya logueado (ver estado_de_sesion en conftest.py)",
    )


@pytest.fixture(scope="session")
def estado_de_sesion(browser, base_url, tmp_path_factory):
    """Hace EL login de la corrida y devuelve la ruta al estado guardado."""
    ruta = tmp_path_factory.mktemp("sesion") / "estado.json"
    contexto = browser.new_context()
    pagina = contexto.new_page()
    try:
        pagina.goto(base_url)
        pagina.locator("#btn-abrir-login").click()
        pagina.locator("#login-email").fill(TEST_USER_EMAIL)
        pagina.locator("#login-password").fill(TEST_USER_PASSWORD)
        pagina.locator("[data-testid='login-submit']").click()
        pagina.wait_for_selector("#sesion-activa:not(.oculto)", timeout=20000)
    except Exception as error:  # noqa: BLE001
        # Mensaje propio: si esto falla, falla TODA la suite, y sin
        # aclararlo parece que el roto fuera el primer test que corra.
        raise RuntimeError(
            "No se pudo hacer el login inicial de la corrida (el único que se hace). "
            f"Usuario {TEST_USER_EMAIL} en el proyecto {FIREBASE_PROJECT_ID}. "
            "Si Firebase devolvió QUOTA_EXCEEDED, es la cuota de verificación de "
            "contraseñas: se repone sola en ~1 hora."
        ) from error
    finally:
        # indexed_db=True es lo que hace que la sesión de Firebase viaje:
        # el SDK la guarda ahí, no en localStorage.
        if not pagina.is_closed():
            contexto.storage_state(path=str(ruta), indexed_db=True)
        contexto.close()
    return str(ruta)


@pytest.fixture
def context(browser, browser_context_args, request, estado_de_sesion):
    """Reemplaza al `context` de pytest-playwright para inyectar la sesión.

    Se sobrescribe ESTE y no `page` a propósito: pytest-playwright arma
    `page` a partir de acá, así que los tests siguen recibiendo `page` y
    no hubo que tocar ninguna firma ni ningún cuerpo de test.
    """
    args = dict(browser_context_args)
    if request.node.get_closest_marker("con_sesion"):
        args["storage_state"] = estado_de_sesion
    contexto = browser.new_context(**args)
    yield contexto
    contexto.close()


# ---------------------------------------------------------------------------
# Helpers de Firestore/Auth por API REST: los tests siembran y borran sus
# propios datos de prueba en el proyecto real de Firebase (no hay emulador
# instalado en esta máquina), así cada corrida es independiente y no deja
# basura acumulada. Se usa REST en vez del SDK de JS porque estos helpers
# corren del lado de Python, no del navegador.
# ---------------------------------------------------------------------------


_sesion_de_prueba_cacheada = None  # ver _sesion_de_prueba()


def _sesion_de_prueba():
    """Cacheada a nivel de módulo: cada helper de este archivo (crear/
    borrar lote, crear/borrar contacto, buscar por nombre/descripción...)
    llama esto para autenticarse, y con retries de por medio (ver
    _buscar_contacto_con_reintento en test_crm.py) una corrida completa de
    la suite puede pedir un token muchas veces. signInWithPassword vía
    REST tiene rate limit propio (independiente del login real que hacen
    los tests contra la UI) — sin cachear, se vio la suite entera fallar
    con "TOO_MANY_ATTEMPTS_TRY_LATER" / "Email o contraseña incorrectos"
    en la UI. El idToken dura 1 hora, muchísimo más que cualquier corrida
    de tests, así que un solo login por sesión de pytest alcanza."""
    global _sesion_de_prueba_cacheada
    if _sesion_de_prueba_cacheada is None:
        respuesta = requests.post(
            "https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword",
            params={"key": FIREBASE_API_KEY},
            json={
                "email": TEST_USER_EMAIL,
                "password": TEST_USER_PASSWORD,
                "returnSecureToken": True,
            },
            timeout=10,
        )
        respuesta.raise_for_status()
        _sesion_de_prueba_cacheada = respuesta.json()
    return _sesion_de_prueba_cacheada


def _id_token_de_prueba():
    return _sesion_de_prueba()["idToken"]


def _uid_de_prueba():
    """El uid de la cuenta de test — hace falta para sembrar un lote con
    "creado_por" válido (la regla de creación en firestore.rules exige
    que coincida con quien está creando, ver el comentario ahí)."""
    return _sesion_de_prueba()["localId"]


def _a_valor_firestore(valor):
    if valor is None:
        return {"nullValue": None}
    if isinstance(valor, bool):
        return {"booleanValue": valor}
    if isinstance(valor, int):
        return {"integerValue": str(valor)}
    if isinstance(valor, float):
        return {"doubleValue": valor}
    if isinstance(valor, str):
        return {"stringValue": valor}
    if isinstance(valor, list):
        return {"arrayValue": {"values": [_a_valor_firestore(v) for v in valor]}}
    if isinstance(valor, dict):
        return {"mapValue": {"fields": {k: _a_valor_firestore(v) for k, v in valor.items()}}}
    raise TypeError(f"Tipo no soportado para Firestore: {type(valor)}")


def crear_lote_de_prueba(datos):
    """Crea un lote y devuelve su id.

    Delega en el plural para que haya UN solo camino de escritura (ver
    _commit). "creado_por" se completa solo si no vino: la regla de
    creación de firestore.rules exige que sea el uid real de quien crea,
    así que no alcanza con omitirlo.
    """
    return crear_lotes_de_prueba([datos])[0]


def _borrar_con_verificacion(url, nombre_para_avisos):
    """Compartida por las 3 "borrar_*_de_prueba" de abajo. El bug real que
    esto arregla: un DELETE por REST que devuelve 429 (u otro error
    transitorio) no lanza excepción con requests si nadie llama
    raise_for_status() — antes estas funciones ni siquiera miraban el
    status code, así que un borrado fallido quedaba invisible: el test
    seguía viéndose PASSED (la falla fue en el "finally" de limpieza, no
    en el test en sí) y el lote/contacto de prueba quedaba sonando en
    PRODUCCIÓN real sin que nada lo avisara. Pasó de verdad, repetidas
    veces, la noche del 2026-09-03/04 con el 429 de Firestore agotado —
    cada corrida del suite completo dejaba basura nueva sin que el
    resultado en verde lo delatara.

    No se propaga la excepción si falla incluso después de reintentar:
    esto se llama casi siempre desde un "finally", y una excepción ahí
    puede tapar el error real del test (Python reemplaza la excepción en
    curso por la del finally). Mejor un aviso bien visible por stdout
    (pytest lo muestra igual) que un traceback confuso."""
    id_token = _id_token_de_prueba()

    def intentar():
        respuesta = requests.delete(url, headers={"Authorization": f"Bearer {id_token}"}, timeout=10)
        respuesta.raise_for_status()
        return True

    if not _con_reintento(intentar):
        print(f"\n⚠️  No se pudo borrar {nombre_para_avisos} después de reintentar — revisar a mano en Firestore.")


def borrar_lote_de_prueba(doc_id):
    _borrar_con_verificacion(f"{FIRESTORE_URL_BASE}/{doc_id}", f"el lote de prueba {doc_id}")


class CuotaDeLecturasAgotada(Exception):
    """La cuota de lecturas REST de Firestore se agotó por hoy.

    Existe para que el fallo se lea de una: antes salía un HTTPError 429
    crudo desde el fondo de un fixture, y para entender que era la cuota
    —y no el código del test— había que ir a leer conftest.
    """


# Cuántas veces se reintenta un 429 antes de darlo por perdido.
#
# ERAN 8 Y AHORA SON 2, medido. La cuota de lecturas de Firestore es
# DIARIA: cuando se agota, reintentar no la trae de vuelta. Se midió el
# 2026-09-18 con scripts/medir_lecturas.py: con la cuota agotada, 11
# tests de CRM hacían 65 llamadas de lectura (8 por test, todas 429) y
# tardaban 160 segundos en fallar. Las 8 eran puro reintento contra una
# pared.
#
# No se baja a 0 porque un 429 TAMBIÉN puede venir de un pico
# instantáneo de pedidos, y ese sí es transitorio. Dos intentos cubren
# ese caso y no convierten una pared en dos minutos de espera.
INTENTOS_ANTE_429 = 2


def _con_reintento(intentar, intentos=8, espera=0.5):
    """La UI ya confirmó que el dato se guardó (el guardado por el SDK del
    navegador ya resolvió antes de que la UI reaccione), pero cada
    "buscar_..._por_..." de acá abajo lee por una vía completamente
    aparte (REST, desde Python) — un puñado de reintentos cortos evita un
    falso negativo por una carrera de red entre ambas lecturas, sin
    esconder un fallo real (agota los intentos y devuelve None).

    Un 429 se reintenta pocas veces (ver INTENTOS_ANTE_429) y después se
    corta con un mensaje claro, en vez de seguir golpeando una cuota
    diaria que no va a ceder.
    """
    intentos_429 = 0
    for intento in range(intentos):
        try:
            resultado = intentar()
        except requests.exceptions.HTTPError as error:
            respuesta = error.response
            if respuesta is not None and respuesta.status_code == 429:
                intentos_429 += 1
                if intentos_429 < INTENTOS_ANTE_429:
                    time.sleep(espera * 4)
                    continue
                raise CuotaDeLecturasAgotada(
                    f"Firestore devolvió 429 (cuota agotada) en el proyecto "
                    f"{FIREBASE_PROJECT_ID} después de {intentos_429} intentos.\n"
                    f"La cuota de LECTURAS por REST es diaria y se renueva a "
                    f"medianoche del Pacífico (~4 de la mañana en Argentina); "
                    f"reintentar no la trae de vuelta.\n"
                    f"Las escrituras y el SDK del navegador tienen su propia "
                    f"cuota y suelen seguir funcionando, así que esto NO "
                    f"significa que el código del test esté mal."
                ) from error
            raise
        if resultado:
            return resultado
        time.sleep(espera)
    return None


def _commit(escrituras):
    """Manda varias escrituras a Firestore en UN solo pedido HTTP.

    Un test que crea tres lotes y después los borra hacía seis pedidos;
    con esto hace dos. La cuota que se agotó el 2026-09-18 fue la de
    lecturas, no la de escrituras, así que esto no era lo más urgente —
    pero cada pedido de menos es un pedido que no puede fallar, y el
    "finally" de limpieza de cada test pasa a ser una sola llamada en vez
    de una por documento.

    Firestore acepta hasta 500 escrituras por commit; los tests de acá
    trabajan con puñados, así que no hace falta partir en tandas. Si
    alguna vez hiciera falta, este es el lugar.
    """
    respuesta = requests.post(
        f"{FIRESTORE_RAIZ}:commit",
        headers={"Authorization": f"Bearer {_id_token_de_prueba()}"},
        json={"writes": escrituras},
        timeout=20,
    )
    respuesta.raise_for_status()
    return respuesta.json()


def _escritura_de_alta(coleccion, doc_id, datos):
    """Una entrada de commit que crea un documento con id elegido por acá.

    El id lo genera el cliente porque un commit necesita saber el nombre
    del documento antes de escribirlo — a diferencia del POST a la
    colección, donde lo inventa Firestore. Da igual para los tests: lo
    único que importa es que sea único.
    """
    if "creado_por" not in datos:
        datos = {**datos, "creado_por": _uid_de_prueba()}
    return {
        "update": {
            "name": f"{FIRESTORE_RAIZ_RELATIVA}/{coleccion}/{doc_id}",
            "fields": {clave: _a_valor_firestore(valor) for clave, valor in datos.items()},
        }
    }


def _id_nuevo():
    return uuid.uuid4().hex[:20]


def crear_lotes_de_prueba(lista_de_datos):
    """Crea varios lotes en un solo pedido y devuelve sus ids, en orden."""
    ids = [_id_nuevo() for _ in lista_de_datos]
    _commit([_escritura_de_alta("lotes", doc_id, datos) for doc_id, datos in zip(ids, lista_de_datos)])
    return ids


def crear_contactos_de_prueba(lista_de_datos):
    """Crea varios contactos en un solo pedido y devuelve sus ids, en orden."""
    ids = [_id_nuevo() for _ in lista_de_datos]
    _commit([_escritura_de_alta("contactos", doc_id, datos) for doc_id, datos in zip(ids, lista_de_datos)])
    return ids


def _borrar_varios(coleccion, doc_ids, nombre_para_avisos):
    """Borra varios documentos en un solo pedido.

    Mismo criterio que _borrar_con_verificacion: reintenta y, si igual no
    puede, avisa por stdout en vez de lanzar. Esto se llama casi siempre
    desde un "finally", y una excepción ahí taparía el error real del
    test.
    """
    doc_ids = [doc_id for doc_id in doc_ids if doc_id]
    if not doc_ids:
        return

    def intentar():
        _commit([{"delete": f"{FIRESTORE_RAIZ_RELATIVA}/{coleccion}/{doc_id}"} for doc_id in doc_ids])
        return True

    if not _con_reintento(intentar):
        print(f"\n⚠️  No se pudieron borrar {len(doc_ids)} {nombre_para_avisos} — revisar a mano en Firestore.")


def borrar_lotes_de_prueba(doc_ids):
    _borrar_varios("lotes", doc_ids, "lotes de prueba")


def borrar_contactos_de_prueba(doc_ids):
    _borrar_varios("contactos", doc_ids, "contactos de prueba")


def _buscar_por_campo_exacto(coleccion, campo, valor, con_sesion):
    """Busca UN documento por el valor exacto de un campo, filtrando del
    lado del servidor.

    POR QUÉ ESTO EXISTE, Y POR QUÉ IMPORTA MÁS DE LO QUE PARECE. Antes
    estos buscadores se traían la colección ENTERA (pageSize=300) y
    filtraban en Python. Con el reintento de por medio, una búsqueda que
    no encontraba nada a la primera hacía hasta OCHO barridos completos,
    y cada documento leído cuenta contra la cuota de lecturas de
    Firestore. Con 108 lotes en la base eso eran 864 lecturas por una
    sola búsqueda fallida.

    El 2026-09-18 la cuota de LECTURAS por REST del proyecto de pruebas
    se agotó a media mañana (escrituras y borrados seguían andando, y el
    SDK del navegador también: era solo el camino de lectura REST). Esto
    es lo que más la consumía.

    Con el filtro del lado del servidor, la misma búsqueda lee un
    documento en vez de la colección entera, y los reintentos pasan a
    ser baratos.
    """
    consulta = {
        "structuredQuery": {
            "from": [{"collectionId": coleccion}],
            "where": {
                "fieldFilter": {
                    "field": {"fieldPath": campo},
                    "op": "EQUAL",
                    "value": {"stringValue": valor},
                }
            },
            "limit": 1,
        }
    }
    cabeceras = {"Authorization": f"Bearer {_id_token_de_prueba()}"} if con_sesion else {}
    respuesta = requests.post(f"{FIRESTORE_RAIZ}:runQuery", headers=cabeceras, json=consulta, timeout=10)
    respuesta.raise_for_status()
    return id_del_primer_documento(respuesta.json())


def id_del_primer_documento(respuesta_de_runquery):
    """El id del primer documento de una respuesta de ":runQuery", o None.

    Está separado de la llamada HTTP para poder testearlo sin red: es
    parseo de una forma de respuesta que no es obvia. runQuery NO devuelve
    un objeto con "documents" como el GET de una colección, sino una
    LISTA de entradas, y las entradas sin resultado traen solo un
    "readTime" — una consulta que no encuentra nada devuelve
    [{"readTime": "..."}], no una lista vacía.

    Verificado contra Firestore real (una consulta sin resultados sobre
    el proyecto de producción, que devolvió exactamente esa forma).
    """
    for entrada in respuesta_de_runquery:
        documento = entrada.get("document")
        if documento:
            return documento["name"].rsplit("/", 1)[-1]
    return None


def buscar_doc_id_por_descripcion(texto):
    """Busca un lote por su texto de descripción exacto.

    Se usa para encontrar el lote que un test creó a través del
    formulario de la UI, que no expone el id del documento nuevo.

    Lectura pública: la colección "lotes" se lee sin sesión (ver
    firestore.rules), así que no hace falta token acá.

    El reintento sigue: la UI ya confirmó el guardado, pero esta lectura
    va por una vía distinta (REST desde Python) y puede llegar un
    instante antes que el dato. Ahora cada reintento cuesta una lectura
    en vez de un barrido entero — ver _buscar_por_campo_exacto.
    """
    return _con_reintento(lambda: _buscar_por_campo_exacto("lotes", "descripcion", texto, con_sesion=False))


FIRESTORE_URL_BASE_CONTACTOS = (
    f"https://firestore.googleapis.com/v1/projects/{FIREBASE_PROJECT_ID}"
    "/databases/(default)/documents/contactos"
)


def buscar_contacto_doc_id_por_nombre(nombre):
    """Mismo criterio que buscar_doc_id_por_descripcion, para la
    colección "contactos" (CRM, ver js/crm.js): encuentra el id del
    contacto que un test creó a través de la UI (que no lo expone). A
    diferencia de "lotes", leer "contactos" requiere sesión (ver
    firestore.rules), así que este helper sí manda el token."""

    return _con_reintento(lambda: _buscar_por_campo_exacto("contactos", "nombre", nombre, con_sesion=True))


def borrar_contacto_de_prueba(doc_id):
    _borrar_con_verificacion(f"{FIRESTORE_URL_BASE_CONTACTOS}/{doc_id}", f"el contacto de prueba {doc_id}")


FIRESTORE_URL_BASE_USUARIOS = (
    f"https://firestore.googleapis.com/v1/projects/{FIREBASE_PROJECT_ID}"
    "/databases/(default)/documents/usuarios"
)


def crear_usuario_de_prueba(uid, email):
    """Crea (o pisa) un doc en "usuarios/{uid}" directo por REST — para
    tests que necesitan un SEGUNDO corredor real en la lista (ej.
    reasignar un contacto en el CRM) sin depender de qué usuarios reales
    haya cargados hoy en este proyecto, ni crear una cuenta de Firebase
    Auth nueva (alcanza con el doc de Firestore, que es lo único que lee
    la app para armar el <select>). Solo root puede escribir en
    "usuarios" (ver firestore.rules) — la cuenta de prueba lo es."""
    id_token = _id_token_de_prueba()
    campos = {clave: _a_valor_firestore(valor) for clave, valor in {"email": email, "perfil_id": "corredor"}.items()}
    respuesta = requests.patch(
        f"{FIRESTORE_URL_BASE_USUARIOS}/{uid}",
        headers={"Authorization": f"Bearer {id_token}"},
        json={"fields": campos},
        timeout=10,
    )
    respuesta.raise_for_status()


def borrar_usuario_de_prueba(uid):
    _borrar_con_verificacion(f"{FIRESTORE_URL_BASE_USUARIOS}/{uid}", f"el usuario de prueba {uid}")


def crear_contacto_de_prueba(datos):
    """Crea un contacto y devuelve su id.

    Sirve para tests que necesitan un contacto con datos difíciles de
    armar clickeando (por ejemplo "asignado_a" de OTRO corredor, para
    probar la vista "Todos"). "creado_por" tiene que ser el uid real de
    la cuenta de prueba aunque "asignado_a" sea distinto: la regla de
    creación lo exige, y en la app real los dos siempre coinciden.

    Delega en el plural, que escribe por commit (ver _commit).
    """
    return crear_contactos_de_prueba([datos])[0]


LOTE_PRUEBA_DATOS = {
    "manzana": "T",
    "lote": "99",
    "nomenclatura": None,
    "superficie_m2": 460.63,
    "estado": "disponible",
    "precio_usd": 5000,
    "descripcion": "Lote de prueba generado por la suite de tests (se borra solo).",
    # Array plano de {lon, lat}, no el anillo GeoJSON anidado
    # ([[lon,lat], ...]): Firestore no admite un array que tenga otro array
    # como elemento directo, y ese anillo tiene 2 niveles de arrays. La app
    # (ver docALoteFeature en js/app.js) lo envuelve de vuelta al formato
    # GeoJSON estándar en memoria, después de leerlo.
    "geometry": {
        "type": "Polygon",
        "coordinates": [
            {"lon": -65.020000, "lat": -32.350000},
            {"lon": -65.019780, "lat": -32.350000},
            {"lon": -65.019780, "lat": -32.350200},
            {"lon": -65.020000, "lat": -32.350200},
            {"lon": -65.020000, "lat": -32.350000},
        ],
    },
}


@pytest.fixture
def lote_sembrado():
    """Crea un único lote de prueba en Firestore antes del test y lo borra
    después, sin importar si el test pasó o falló. Incluye "doc_id" además
    de los datos: la app le pone una clase CSS "lote-<doc_id>" a cada
    polígono (ver cargarLotesDesdeFirestore en js/app.js), así el test
    apunta al lote que sembró sin importar cuántos otros lotes reales haya
    ya cargados en Firestore."""
    doc_id = crear_lote_de_prueba(LOTE_PRUEBA_DATOS)
    try:
        yield {**LOTE_PRUEBA_DATOS, "doc_id": doc_id}
    finally:
        borrar_lote_de_prueba(doc_id)


# ---------------------------------------------------------------------------
# Los datos de la inmobiliaria (configuracion/inmobiliaria)
# ---------------------------------------------------------------------------

# Un documento FIJO, no uno por test. Es configuración de la instalación,
# no un dato de negocio: hay uno solo y la app lo lee por id. Por eso este
# fixture guarda lo que había y lo repone al terminar, en vez de crear y
# borrar como los demás — si el proyecto de pruebas ya tiene datos
# cargados a mano, un test no tiene por qué pisárselos.
INMOBILIARIA_PRUEBA = {
    "nombre": "Inmobiliaria de Prueba",
    "telefono": "2664558821",
    "localidad": "Merlo, San Luis",
    "direccion": "Av. del Sol 1240",
    "horario": "Lunes a viernes de 9 a 13",
    "email": "contacto@ejemplo.com.ar",
    "web": "https://www.ejemplo.com.ar",
    "matricula": "CSI 1234",
    "logo_url": None,
}


def _leer_inmobiliaria():
    """Lo que hay guardado, o None si no hay documento."""
    respuesta = requests.get(
        f"{FIRESTORE_RAIZ}/configuracion/inmobiliaria",
        headers={"Authorization": f"Bearer {_id_token_de_prueba()}"},
        timeout=20,
    )
    if respuesta.status_code == 404:
        return None
    respuesta.raise_for_status()
    campos = respuesta.json().get("fields", {})
    return {
        clave: (None if "nullValue" in valor else valor.get("stringValue"))
        for clave, valor in campos.items()
    }


def _escribir_inmobiliaria(datos):
    _commit(
        [
            {
                "update": {
                    "name": f"{FIRESTORE_RAIZ_RELATIVA}/configuracion/inmobiliaria",
                    "fields": {k: _a_valor_firestore(v) for k, v in datos.items()},
                }
            }
        ]
    )


def _borrar_inmobiliaria():
    _commit([{"delete": f"{FIRESTORE_RAIZ_RELATIVA}/configuracion/inmobiliaria"}])


@pytest.fixture
def inmobiliaria_configurada():
    """Deja datos de agencia conocidos, y repone lo que había al terminar."""
    anterior = _leer_inmobiliaria()
    _escribir_inmobiliaria(INMOBILIARIA_PRUEBA)
    try:
        yield dict(INMOBILIARIA_PRUEBA)
    finally:
        if anterior is None:
            _borrar_inmobiliaria()
        else:
            _escribir_inmobiliaria(anterior)


@pytest.fixture
def inmobiliaria_sin_configurar():
    """El caso "recién instalada": no hay documento de agencia.

    Importa tanto como el caso configurado — es el estado en el que queda
    la app apenas se instala, y es donde se ve si algo asume que los
    datos están.

    NO CORRE CONTRA PRODUCCIÓN, y no es una formalidad: este fixture
    BORRA el documento y su única copia vive en memoria de este proceso.
    Si la corrida se corta en el medio (Ctrl-C, un crash, el runner que
    mata el proceso), esa copia se va con él. En el proyecto de pruebas
    eso cuesta volver a sembrar la demo; en producción sería dejar a la
    inmobiliaria sin su teléfono de contacto y sin forma de recuperarlo.
    El resto de la suite avisa fuerte sobre producción pero igual corre
    (ver el aviso de arriba); este caso puntual no.
    """
    if USA_PRODUCCION:
        pytest.skip(
            "Este test borra configuracion/inmobiliaria y la única copia queda en "
            "memoria: no se corre contra producción. Configurá FIREBASE_PROJECT_ID "
            "en tests/.env con el proyecto de pruebas."
        )
    anterior = _leer_inmobiliaria()
    _borrar_inmobiliaria()
    try:
        yield
    finally:
        if anterior is not None:
            _escribir_inmobiliaria(anterior)


@pytest.fixture
def inmobiliaria_sin_telefono():
    """Configurada a medias: con nombre, sin teléfono.

    Es el estado más probable de los dos "incompletos" — una
    inmobiliaria carga su nombre y deja el teléfono para después — y es
    donde se decide si el botón de WhatsApp se ofrece o no.
    """
    datos = {**INMOBILIARIA_PRUEBA, "telefono": None}
    anterior = _leer_inmobiliaria()
    _escribir_inmobiliaria(datos)
    try:
        yield dict(datos)
    finally:
        if anterior is None:
            _borrar_inmobiliaria()
        else:
            _escribir_inmobiliaria(anterior)


# ---------------------------------------------------------------------------
# Abrir el menú, sin que cada test tenga que saber en qué ancho corre
# ---------------------------------------------------------------------------


def abrir_menu(page):
    """Deja las secciones del menú a mano.

    POR QUÉ HACE FALTA UN HELPER. Desde el rediseño del 2026-09-18 la
    barra lateral está SIEMPRE desplegada en escritorio y el ☰ no existe
    ahí: no hay nada que abrir. En teléfono el menú sigue siendo un cajón
    y el ☰ es el único acceso.

    Los 65 tests que antes clickeaban "#btn-menu" a ciegas fallaban en
    escritorio ("element is not visible") y seguían necesitándolo en
    teléfono, así que la condición vive acá y no repetida en cada test.
    """
    boton = page.locator("#btn-menu")
    if boton.is_visible():
        boton.click()


def esperar_sesion_en_el_menu(page, timeout=30000):
    """Espera a que el menú muestre lo que solo se ve con sesión.

    POR QUÉ HACE FALTA. Los lotes son públicos y llegan de Firestore
    antes de que Firebase resuelva quién sos, así que esperar a que
    aparezca un lote NO garantiza que haya sesión. Los bloques
    .solo-con-sesion del menú pierden la clase "oculto" recién en
    onAuthStateChanged (ver js/app.js).

    Se notó al mover "Apartados" adentro de ese gate: los tests que
    recargaban y clickeaban el ítem enseguida empezaron a fallar con
    "element is not visible", que no dice nada de lo que realmente
    estaba pasando.
    """
    page.wait_for_function(
        """() => {
             const bloques = document.querySelectorAll('.solo-con-sesion');
             return bloques.length > 0 && [...bloques].every((b) => !b.classList.contains('oculto'));
           }""",
        timeout=timeout,
    )


# ---------------------------------------------------------------------------
# Soltar el hover del menú lateral
# ---------------------------------------------------------------------------

def soltar_el_mouse(page):
    """Mueve el puntero al centro, lejos del menú lateral.

    HACE FALTA de verdad: el menú se expande al pasar el mouse por encima
    (pedido explícito del usuario) y expandido mide 288px, o sea que tapa
    toda la franja izquierda de la pantalla. Playwright deja el puntero
    donde hizo el último click, así que después de elegir algo del menú
    el puntero queda ENCIMA del menú, el menú se queda expandido, y se
    come el click siguiente con un "subtree intercepts pointer events".

    Un usuario real no lo sufre porque al mover el mouse hacia el
    contenido el menú se contrae solo — el puntero de Playwright, en
    cambio, no se mueve si nadie se lo pide.
    """
    page.mouse.move(700, 400)


# ---------------------------------------------------------------------------
# Limpieza de datos de prueba que quedaron de corridas anteriores
#
# POR QUÉ HACE FALTA. Cada test borra lo que sembró en un `finally`, pero
# si el test se corta antes —o si el propio borrado falla— el dato queda
# en Firestore. Así se juntaron ~160 contactos de prueba, y el problema
# no fue cosmético: Firestore cobra las lecturas POR DOCUMENTO, con
# 50.000 por día en el plan gratuito. Cada apertura del CRM leía esos 162
# contactos, así que una corrida completa de la suite agotaba la cuota
# del proyecto (429 RESOURCE_EXHAUSTED) y a partir de ahí fallaba todo,
# tanto los tests como la app EN PRODUCCIÓN. Además inflaba los números
# del Dashboard real ("162 Contactos", 22 seguimientos que no existían).
# ---------------------------------------------------------------------------

# Los tests nombran lo que siembran como f"PREFIJO-{uuid4().hex[:8]}":
# prefijo en MAYÚSCULAS, guion, y 8 caracteres hexadecimales EN
# MINÚSCULAS. Un dato real ("Juan Pérez", "Merlo") no matchea.
#
# El `(?=[0-9a-f]*[a-f])` exige que el marcador tenga al menos una letra
# a-f, y no es un detalle de más: sin eso, "PARCELA-12345678" matcheaba
# —8 dígitos también son hexadecimal válido— y un nombre así lo puede
# haber cargado un corredor de verdad. Esto BORRA datos de producción,
# así que ante la duda no se toca. El costo es que a un ~2% de los datos
# de prueba le toca un marcador todo numérico y la limpieza automática
# lo deja pasar; esos se juntan de a poquito y se barren a mano con
# scripts/limpiar_datos_de_prueba.py, que muestra la lista antes de
# borrar para que una persona la revise.
# Lo cubre tests/test_limpieza_datos_de_prueba.py.
PATRON_DATO_DE_PRUEBA = re.compile(r"^[A-Z0-9]+(?:-[A-Z0-9]+)*-(?=[0-9a-f]*[a-f])[0-9a-f]{8}$")

# En qué campos puede estar el marcador, por colección. Son VARIOS a
# propósito: los tests lo ponen donde después lo van a buscar, y eso
# cambia según el test.
#
# En "lotes" el caso que se escapó: test_corredor_logueado_puede_cargar_un_lote
# escribe el marcador en la descripción (antes "observaciones") porque es
# el único campo que la UI de alta expone y que el test puede leer
# después por REST para encontrar el documento — la manzana la elige el
# usuario. Mirando solo "manzana", el limpiador reportaba "0 sobrantes"
# mientras había 41 lotes de prueba en producción, más de un cuarto del
# inventario del cliente, visibles en el mapa y en el Dashboard.
#
# "observaciones" y "descripcion" son el mismo campo antes y después del
# renombre del 2026-09-16 (ver la separación descripción / notas
# internas): se miran los dos, porque en producción conviven documentos
# viejos y nuevos.
#
# El patrón exige que el campo COMPLETO sea el marcador, así que un texto
# largo del importador de catastro —que es lo que tienen casi todos los
# lotes reales en ese campo— no matchea.
CAMPOS_CON_MARCADOR = {
    "contactos": ("nombre",),
    "lotes": ("manzana", "descripcion", "observaciones"),
}

# Solo se borra lo creado hace más de esto. Es la protección contra
# borrarle los datos a una corrida que está pasando AHORA (dos sesiones
# de pytest en paralelo, o esta misma suite mientras avanza): lo que un
# test acaba de sembrar nunca tiene esta antigüedad.
MINUTOS_PARA_CONSIDERAR_SOBRANTE = 30


def _url_de_coleccion(coleccion):
    return (
        f"https://firestore.googleapis.com/v1/projects/{FIREBASE_PROJECT_ID}"
        f"/databases/(default)/documents/{coleccion}"
    )


def _antiguedad_en_minutos(doc):
    creado = doc.get("createTime")
    if not creado:
        return 0
    # createTime viene RFC3339 con "Z" y hasta 9 decimales; fromisoformat
    # no se lleva bien con más de 6, así que se recortan.
    texto = creado.replace("Z", "+00:00")
    if "." in texto:
        entero, resto = texto.split(".", 1)
        fraccion, zona = resto[:-6], resto[-6:]
        texto = f"{entero}.{fraccion[:6]}{zona}"
    creado_dt = datetime.fromisoformat(texto)
    return (datetime.now(timezone.utc) - creado_dt).total_seconds() / 60


def datos_de_prueba_sobrantes():
    """Los documentos de prueba viejos, por colección. Solo lee."""
    id_token = _id_token_de_prueba()
    sobrantes = {}
    for coleccion, campos in CAMPOS_CON_MARCADOR.items():
        encontrados, pagina = [], None
        while True:
            parametros = {"pageSize": 300}
            if pagina:
                parametros["pageToken"] = pagina
            respuesta = requests.get(
                _url_de_coleccion(coleccion),
                headers={"Authorization": f"Bearer {id_token}"},
                params=parametros,
                timeout=30,
            )
            respuesta.raise_for_status()
            datos = respuesta.json()
            for doc in datos.get("documents", []):
                valores = doc.get("fields", {})
                # El marcador puede estar en cualquiera de los campos de
                # la colección; alcanza con que UNO sea exactamente el
                # marcador para que el documento sea de prueba.
                marcador = next(
                    (
                        valores.get(c, {}).get("stringValue", "")
                        for c in campos
                        if PATRON_DATO_DE_PRUEBA.match(valores.get(c, {}).get("stringValue", "") or "")
                    ),
                    None,
                )
                if marcador is None:
                    continue
                if _antiguedad_en_minutos(doc) < MINUTOS_PARA_CONSIDERAR_SOBRANTE:
                    continue
                encontrados.append((doc["name"].rsplit("/", 1)[-1], marcador))
            pagina = datos.get("nextPageToken")
            if not pagina:
                break
        sobrantes[coleccion] = encontrados
    return sobrantes


def borrar_datos_de_prueba_sobrantes():
    """Borra los sobrantes y devuelve cuántos por colección."""
    id_token = _id_token_de_prueba()
    borrados = {}
    for coleccion, documentos in datos_de_prueba_sobrantes().items():
        cuenta = 0
        for doc_id, _ in documentos:
            respuesta = requests.delete(
                f"{_url_de_coleccion(coleccion)}/{doc_id}",
                headers={"Authorization": f"Bearer {id_token}"},
                timeout=30,
            )
            if respuesta.ok:
                cuenta += 1
            elif respuesta.status_code == 429:
                break  # cuota agotada: lo que quede se limpia la próxima
        borrados[coleccion] = cuenta
    return borrados


@pytest.fixture(scope="session", autouse=True)
def limpiar_sobrantes_al_arrancar():
    """Arranca cada corrida con la base sin basura de corridas previas.

    Cuesta una lectura por documento, UNA vez por corrida — muchísimo
    menos que dejar los sobrantes y que cada test que abre el CRM los
    vuelva a leer todos.

    Nunca hace fallar la suite: si Firestore no responde (o la cuota ya
    está agotada) avisa y sigue. Los tests que necesiten Firestore van a
    fallar igual, pero con su propio mensaje, que es más claro que un
    error en el setup de la sesión.
    """
    try:
        borrados = borrar_datos_de_prueba_sobrantes()
        total = sum(borrados.values())
        if total:
            detalle = ", ".join(f"{k}: {v}" for k, v in borrados.items() if v)
            print(f"\n[limpieza] borrados {total} datos de prueba sobrantes ({detalle})")
    except Exception as error:  # noqa: BLE001 — nunca romper la suite por esto
        print(f"\n[limpieza] no se pudo limpiar ({type(error).__name__}: {error}); se sigue igual")
    yield
