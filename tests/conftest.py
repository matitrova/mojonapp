import os
import socket
import subprocess
import sys
import time
from pathlib import Path

import pytest
import requests
from dotenv import load_dotenv

RAIZ_PROYECTO = Path(__file__).resolve().parent.parent

load_dotenv(Path(__file__).resolve().parent / ".env")

# Config pública del proyecto Firebase (la misma que en js/firebase-config.js,
# no es secreta). Las credenciales del usuario de prueba sí lo son y viven
# solo en tests/.env (no versionado).
FIREBASE_API_KEY = "AIzaSyCR9w0fwXixk4CZV051-srq9PsTvmp5lGQ"
FIREBASE_PROJECT_ID = "mojonapp"
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
    proceso = subprocess.Popen(
        [sys.executable, "-m", "http.server", str(puerto)],
        cwd=RAIZ_PROYECTO,
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


def _sesion_de_prueba():
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
    return respuesta.json()


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


def borrar_lote_de_prueba(doc_id):
    id_token = _id_token_de_prueba()
    requests.delete(
        f"{FIRESTORE_URL_BASE}/{doc_id}",
        headers={"Authorization": f"Bearer {id_token}"},
        timeout=10,
    )


def buscar_doc_id_por_observaciones(texto):
    """Lectura pública (sin login): busca un lote por su texto de
    observaciones exacto. Se usa para encontrar y limpiar el lote que un
    test creó a través del formulario de la UI (que no expone el id del
    documento nuevo)."""
    respuesta = requests.get(FIRESTORE_URL_BASE, timeout=10)
    respuesta.raise_for_status()
    for doc in respuesta.json().get("documents", []):
        campos = doc.get("fields", {})
        if campos.get("observaciones", {}).get("stringValue") == texto:
            return doc["name"].rsplit("/", 1)[-1]
    return None


LOTE_PRUEBA_DATOS = {
    "manzana": "T",
    "lote": "99",
    "nomenclatura": None,
    "superficie_m2": 460.63,
    "estado": "disponible",
    "precio_usd": 5000,
    "observaciones": "Lote de prueba generado por la suite de tests (se borra solo).",
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
