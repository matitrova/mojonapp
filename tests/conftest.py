import os
import re
import socket
import subprocess
import sys
import time
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

FIREBASE_API_KEY = os.environ.get("FIREBASE_API_KEY", API_KEY_PRODUCCION)
FIREBASE_PROJECT_ID = os.environ.get("FIREBASE_PROJECT_ID", PROJECT_ID_PRODUCCION)
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


def _puerto_libre():
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


@pytest.fixture(scope="session")
def base_url():
    puerto = _puerto_libre()
    # scripts/servidor_dev.py y no "-m http.server" por dos motivos:
    #
    # 1. Aplica las reglas de _redirects, o sea que /contactos,
    #    /dashboard, etc. devuelven index.html igual que en Cloudflare
    #    Pages. Sin eso, los tests que entran directo a la URL de una
    #    sección (ver test_router.py) recibirían un 404 que en
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
    """Crea un documento en la colección "lotes" y devuelve su id.
    Agrega "creado_por" solo si datos no lo trae ya — la regla de
    creación en firestore.rules exige que sea el uid real de quien
    crea, así que no alcanza con omitirlo."""
    id_token = _id_token_de_prueba()
    if "creado_por" not in datos:
        datos = {**datos, "creado_por": _uid_de_prueba()}
    campos = {clave: _a_valor_firestore(valor) for clave, valor in datos.items()}
    respuesta = requests.post(
        FIRESTORE_URL_BASE,
        headers={"Authorization": f"Bearer {id_token}"},
        json={"fields": campos},
        timeout=10,
    )
    respuesta.raise_for_status()
    nombre_completo = respuesta.json()["name"]
    return nombre_completo.rsplit("/", 1)[-1]


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


def _con_reintento(intentar, intentos=8, espera=0.5):
    """La UI ya confirmó que el dato se guardó (el guardado por el SDK del
    navegador ya resolvió antes de que la UI reaccione), pero cada
    "buscar_..._por_..." de acá abajo lee por una vía completamente
    aparte (REST, desde Python) — un puñado de reintentos cortos evita un
    falso negativo por una carrera de red entre ambas lecturas, sin
    esconder un fallo real (agota los intentos y devuelve None).

    Un 429 (quota excedida — visto en vivo corriendo el suite completo
    varias veces seguidas) también se reintenta, con una espera más
    larga: es un fallo transitorio de la cuota de Firestore, no una
    señal de que el dato no está — dejarlo propagar como excepción corta
    los reintentos de golpe en el primer intento."""
    for intento in range(intentos):
        try:
            resultado = intentar()
        except requests.exceptions.HTTPError as error:
            if error.response is not None and error.response.status_code == 429 and intento < intentos - 1:
                time.sleep(espera * 4)
                continue
            raise
        if resultado:
            return resultado
        time.sleep(espera)
    return None


def buscar_doc_id_por_descripcion(texto):
    """Lectura pública (sin login): busca un lote por su texto de
    descripción exacto. Se usa para encontrar y limpiar el lote que un
    test creó a través del formulario de la UI (que no expone el id del
    documento nuevo).

    Pide pageSize=300 (por encima de la cantidad de lotes de prueba que
    hay hoy) para traer todo en un solo pedido — Firestore REST devuelve
    como mucho ~100 documentos por página si no se pide un tamaño mayor,
    y con más de 100 lotes ya cargados en la base de prueba, quedarse con
    el tamaño de página por default hacía que este helper no encontrara
    lotes recién creados que cayeran fuera de la primera página, y el
    test fallaba con "no apareció en Firestore" de forma intermitente
    aunque el lote sí se había guardado bien. Igual recorre nextPageToken
    por si en algún momento se supera ese tamaño, para no reintroducir el
    mismo bug más adelante."""

    def intentar():
        pagina_token = None
        while True:
            parametros = {"pageSize": 300}
            if pagina_token:
                parametros["pageToken"] = pagina_token
            respuesta = requests.get(FIRESTORE_URL_BASE, params=parametros, timeout=10)
            respuesta.raise_for_status()
            cuerpo = respuesta.json()
            for doc in cuerpo.get("documents", []):
                campos = doc.get("fields", {})
                if campos.get("descripcion", {}).get("stringValue") == texto:
                    return doc["name"].rsplit("/", 1)[-1]
            pagina_token = cuerpo.get("nextPageToken")
            if not pagina_token:
                return None

    return _con_reintento(intentar)


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

    def intentar():
        id_token = _id_token_de_prueba()
        respuesta = requests.get(
            FIRESTORE_URL_BASE_CONTACTOS,
            headers={"Authorization": f"Bearer {id_token}"},
            timeout=10,
        )
        respuesta.raise_for_status()
        for doc in respuesta.json().get("documents", []):
            campos = doc.get("fields", {})
            if campos.get("nombre", {}).get("stringValue") == nombre:
                return doc["name"].rsplit("/", 1)[-1]
        return None

    return _con_reintento(intentar)


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
    """Crea un documento en "contactos" directo por REST (sin pasar por
    la UI) y devuelve su id — para tests que necesitan un contacto con
    datos puntuales difíciles de armar clickeando (ej. "asignado_a" de
    OTRO corredor, para probar la vista "Todos"). "creado_por" tiene que
    ser el uid real de la cuenta de prueba (la regla de creación en
    firestore.rules lo exige, igual que en lotes) aunque "asignado_a" sea
    distinto — en la app real los dos siempre coinciden al crear un
    contacto, esto es solo para poder simular la cartera de "otro
    corredor" sin una segunda cuenta."""
    id_token = _id_token_de_prueba()
    if "creado_por" not in datos:
        datos = {**datos, "creado_por": _uid_de_prueba()}
    campos = {clave: _a_valor_firestore(valor) for clave, valor in datos.items()}
    respuesta = requests.post(
        FIRESTORE_URL_BASE_CONTACTOS,
        headers={"Authorization": f"Bearer {id_token}"},
        json={"fields": campos},
        timeout=10,
    )
    respuesta.raise_for_status()
    return respuesta.json()["name"].rsplit("/", 1)[-1]


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

# De qué campo sale el nombre visible de cada colección.
CAMPO_NOMBRE_POR_COLECCION = {"contactos": "nombre", "lotes": "manzana"}

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
    for coleccion, campo in CAMPO_NOMBRE_POR_COLECCION.items():
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
                nombre = doc.get("fields", {}).get(campo, {}).get("stringValue", "")
                if not PATRON_DATO_DE_PRUEBA.match(nombre):
                    continue
                if _antiguedad_en_minutos(doc) < MINUTOS_PARA_CONSIDERAR_SOBRANTE:
                    continue
                encontrados.append((doc["name"].rsplit("/", 1)[-1], nombre))
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
