"""Cuenta las lecturas REST a Firestore que hace la suite, y quién las hace.

POR QUÉ EXISTE. El proyecto de tests se queda sin cuota de lecturas REST
casi todos los días de muchas corridas, y hasta ahora se optimizaba por
sospecha: se cambiaron los barridos que "parecían" caros. Esto mide en
vez de adivinar, y así el arreglo va al lugar que de verdad consume —
importa porque el código más caro sospechado es también el más delicado
de la suite (la limpieza de datos de prueba, que una vez casi borró datos
reales).

NO ES UN CONFTEST y no se carga solo, a propósito: no toca nada de la
suite si no se lo pide explícitamente.

    pytest tests/test_algo.py -p medir_lecturas

Necesita que scripts/ esté en el path de plugins; el modo simple es:

    PYTHONPATH=scripts pytest tests/test_algo.py -p medir_lecturas

QUÉ CUENTA. Solo lo que va a Firestore por REST, que es la cuota que se
agota. Las lecturas que hace el navegador con el SDK van por otro camino
y tienen su propia cuota (comprobado: el SDK leía bien mientras REST
devolvía 429), así que no se mezclan acá.
"""

import collections
import os
import re
import sys

import requests

# Cada entrada: (tipo, detalle, documentos, estado, test)
_llamadas = []
_test_actual = ["(arranque / fixtures de sesión)"]

_ORIGINALES = {}


def _clasificar(metodo, url):
    """Qué clase de operación es, en términos de la cuota."""
    if ":runQuery" in url:
        return "lectura", "runQuery (consulta filtrada)"
    if ":commit" in url:
        return "escritura", "commit (escritura en lote)"
    if metodo == "GET":
        # .../documents/contactos?pageSize=300  -> barrido de colección
        # .../documents/lotes/abc123            -> un documento
        camino = re.sub(r"^.*?/documents/", "", url.split("?")[0])
        partes = camino.split("/")
        if len(partes) == 1:
            return "lectura", f"barrido de la colección {partes[0]}"
        return "lectura", f"un documento de {partes[0]}"
    if metodo == "DELETE":
        return "escritura", "delete de un documento"
    if metodo == "POST":
        return "escritura", "POST"
    return "otro", metodo


def _contar_documentos(respuesta, tipo_detalle):
    """Cuántos documentos trajo. Es lo que consume cuota, no la llamada."""
    if not respuesta.ok:
        return 0
    try:
        datos = respuesta.json()
    except Exception:
        return 0
    if isinstance(datos, list):  # runQuery
        return sum(1 for fila in datos if fila.get("document"))
    if "documents" in datos:
        return len(datos["documents"])
    if "fields" in datos or "name" in datos:
        return 1
    return 0


def _envolver(nombre):
    original = getattr(requests, nombre)
    _ORIGINALES[nombre] = original

    def espia(url, *args, **kwargs):
        respuesta = original(url, *args, **kwargs)
        if "firestore.googleapis.com" in str(url):
            tipo, detalle = _clasificar(nombre.upper(), str(url))
            _llamadas.append(
                (tipo, detalle, _contar_documentos(respuesta, detalle),
                 respuesta.status_code, _test_actual[0])
            )
        return respuesta

    setattr(requests, nombre, espia)


def pytest_configure(config):
    for nombre in ("get", "post", "delete", "patch"):
        if hasattr(requests, nombre):
            _envolver(nombre)


def pytest_runtest_logstart(nodeid, location):
    _test_actual[0] = nodeid.split("::")[-1]


def pytest_unconfigure(config):
    for nombre, original in _ORIGINALES.items():
        setattr(requests, nombre, original)
    _informe()


def _informe():
    if not _llamadas:
        print("\n[medición] la suite no hizo ninguna llamada REST a Firestore.")
        return

    lecturas = [c for c in _llamadas if c[0] == "lectura"]
    escrituras = [c for c in _llamadas if c[0] == "escritura"]
    bloqueadas = [c for c in _llamadas if c[3] == 429]

    print("\n" + "=" * 78)
    print("LECTURAS REST A FIRESTORE EN ESTA CORRIDA")
    print("=" * 78)
    print(
        f"  llamadas de lectura:  {len(lecturas):>5}   "
        f"documentos leídos: {sum(c[2] for c in lecturas):>6}"
    )
    print(f"  llamadas de escritura:{len(escrituras):>5}")
    if bloqueadas:
        print(
            f"  BLOQUEADAS (429):     {len(bloqueadas):>5}   "
            f"(los documentos leídos están subestimados: estas no trajeron nada)"
        )

    print("\n  Por tipo de operación:")
    por_tipo = collections.defaultdict(lambda: [0, 0])
    for _, detalle, docs, _, _ in lecturas:
        por_tipo[detalle][0] += 1
        por_tipo[detalle][1] += docs
    for detalle, (llamadas, docs) in sorted(por_tipo.items(), key=lambda kv: -kv[1][0]):
        print(f"    {llamadas:>4} llamadas  {docs:>6} docs   {detalle}")

    print("\n  Quién las hace (top 12):")
    por_test = collections.defaultdict(lambda: [0, 0])
    for _, _, docs, _, test in lecturas:
        por_test[test][0] += 1
        por_test[test][1] += docs
    filas = sorted(por_test.items(), key=lambda kv: -kv[1][0])[:12]
    for test, (llamadas, docs) in filas:
        print(f"    {llamadas:>4} llamadas  {docs:>6} docs   {test[:58]}")

    print("=" * 78)
