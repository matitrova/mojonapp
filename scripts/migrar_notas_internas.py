#!/usr/bin/env python3
"""
Migración de una sola vez: pasa el campo "observaciones" de cada lote a
la subcolección de notas internas, y lo deja vacío.

POR QUÉ. "observaciones" cumplía dos funciones incompatibles: era la
descripción que se publica Y la libreta del corredor. Como la colección
"lotes" es de lectura pública (allow read: if true, ver firestore.rules) y
la ficha mostraba ese campo sin ningún control, las notas de trabajo eran
legibles por cualquier visitante — "Vertices tomados del visor de catastro
(NATIVA/WGS84)", "Importado automáticamente del catastro de San Luis", y
lo que hubiera escrito el corredor.

A partir de este cambio hay dos lugares distintos: "descripcion" (campo
del lote, público) y lotes/{id}/privado/notas (subcolección, solo con
sesión). Este script mueve lo viejo al segundo, que es donde la decisión
del usuario dijo que va: nada de lo ya cargado queda expuesto.

POR QUÉ EN PYTHON Y POR REST. El proyecto no tiene Node ni Firebase CLI
instalados (decisión deliberada, ver tests/conftest.py y el comentario de
functions/_middleware.js). Estas son las mismas llamadas REST que ya usa
la suite de tests.

CÓMO SE CORRE.

    .venv/bin/python scripts/migrar_notas_internas.py            # dry-run: no escribe nada
    .venv/bin/python scripts/migrar_notas_internas.py --aplicar  # escribe de verdad

Con el Python del entorno virtual del proyecto, NO con el del sistema:
"requests" está instalado ahí (es la misma dependencia que usa la suite de
tests, ver tests/requirements.txt). Con `python3` pelado tira
ModuleNotFoundError.

Pide el mail y la contraseña de un corredor al arrancar. No se guardan en
ningún lado ni se escriben en disco.

ES SEGURO CORRERLO DOS VECES. Por cada lote: primero ESCRIBE la nota,
después vacía "observaciones". En ese orden a propósito — si se corta en
el medio, el dato queda duplicado, nunca perdido. Y si el lote ya tiene su
nota, lo saltea.
"""

import argparse
import getpass
import sys
from datetime import datetime, timezone

import requests

FIREBASE_API_KEY = "AIzaSyCR9w0fwXixk4CZV051-srq9PsTvmp5lGQ"
PROJECT_ID = "mojonapp"
BASE = f"https://firestore.googleapis.com/v1/projects/{PROJECT_ID}/databases/(default)/documents"
TIMEOUT = 20


def iniciar_sesion():
    email = input("Mail del corredor: ").strip()
    password = getpass.getpass("Contraseña: ")
    respuesta = requests.post(
        "https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword",
        params={"key": FIREBASE_API_KEY},
        json={"email": email, "password": password, "returnSecureToken": True},
        timeout=TIMEOUT,
    )
    if not respuesta.ok:
        # Mostrar el motivo REAL y no un "revisá el mail y la contraseña"
        # para todo: los tres casos se arreglan de forma distinta, y el
        # tercero no tiene nada que ver con lo que escribiste.
        try:
            codigo = respuesta.json()["error"]["message"]
        except Exception:
            codigo = f"HTTP {respuesta.status_code}"
        explicaciones = {
            "INVALID_LOGIN_CREDENTIALS": "Mail o contraseña incorrectos.",
            "INVALID_PASSWORD": "Contraseña incorrecta.",
            "EMAIL_NOT_FOUND": "No existe una cuenta con ese mail.",
            "USER_DISABLED": "Esa cuenta está deshabilitada.",
            # Firebase Auth limita los intentos por su cuenta, aparte de
            # cualquier cuota de Firestore. Pasa después de muchos logins
            # seguidos (la suite de tests hace unos cuantos) y se
            # destraba solo con el tiempo — ver el comentario de
            # _sesion_de_prueba en tests/conftest.py.
            "TOO_MANY_ATTEMPTS_TRY_LATER": (
                "Firebase bloqueó los intentos por un rato (demasiados logins seguidos). "
                "No es la contraseña: esperá unos minutos y reintentá."
            ),
        }
        sys.exit(f"No se pudo iniciar sesión — {explicaciones.get(codigo, codigo)}")
    return respuesta.json()["idToken"]


def traer_lotes(token):
    """Trae todos los lotes, paginando. La colección puede crecer, así que
    no se asume que entran en una sola respuesta."""
    lotes = []
    pagina = None
    while True:
        params = {"pageSize": 300}
        if pagina:
            params["pageToken"] = pagina
        r = requests.get(f"{BASE}/lotes", params=params, headers={"Authorization": f"Bearer {token}"}, timeout=TIMEOUT)
        if r.status_code == 429:
            sys.exit("Firestore devolvió 429 (cuota agotada). Probá de nuevo cuando se resetee.")
        r.raise_for_status()
        datos = r.json()
        lotes.extend(datos.get("documents", []))
        pagina = datos.get("nextPageToken")
        if not pagina:
            return lotes


def ya_tiene_nota(token, lote_id):
    r = requests.get(
        f"{BASE}/lotes/{lote_id}/privado/notas", headers={"Authorization": f"Bearer {token}"}, timeout=TIMEOUT
    )
    return r.status_code == 200


def escribir_nota(token, lote_id, texto, fecha):
    r = requests.patch(
        f"{BASE}/lotes/{lote_id}/privado/notas",
        headers={"Authorization": f"Bearer {token}"},
        json={"fields": {"texto": {"stringValue": texto}, "fecha_actualizacion": {"stringValue": fecha}}},
        timeout=TIMEOUT,
    )
    r.raise_for_status()


def vaciar_observaciones(token, lote_id):
    """updateMask acota la escritura a ESE campo: el resto del documento
    (geometría, precio, estado...) no se toca ni se reenvía."""
    r = requests.patch(
        f"{BASE}/lotes/{lote_id}",
        params={"updateMask.fieldPaths": "observaciones"},
        headers={"Authorization": f"Bearer {token}"},
        json={"fields": {"observaciones": {"nullValue": None}}},
        timeout=TIMEOUT,
    )
    r.raise_for_status()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--aplicar", action="store_true", help="escribir de verdad (sin esto, solo informa)")
    args = parser.parse_args()

    token = iniciar_sesion()
    lotes = traer_lotes(token)
    print(f"\n{len(lotes)} lotes en total.")

    pendientes = []
    for documento in lotes:
        observaciones = documento.get("fields", {}).get("observaciones", {}).get("stringValue", "").strip()
        if observaciones:
            pendientes.append((documento["name"].rsplit("/", 1)[-1], observaciones))

    if not pendientes:
        print("Ninguno tiene observaciones cargadas. No hay nada que migrar.")
        return

    print(f"{len(pendientes)} con observaciones para pasar a notas internas.\n")
    for lote_id, texto in pendientes:
        recorte = texto if len(texto) <= 70 else texto[:67] + "..."
        print(f"  {lote_id}  {recorte}")

    if not args.aplicar:
        print("\nDry-run: no se escribió nada. Volvé a correrlo con --aplicar para hacerlo de verdad.")
        return

    print()
    migrados = salteados = 0
    fecha = datetime.now(timezone.utc).isoformat()
    for lote_id, texto in pendientes:
        if ya_tiene_nota(token, lote_id):
            print(f"  {lote_id}: ya tenía nota, se saltea")
            salteados += 1
            continue
        escribir_nota(token, lote_id, texto, fecha)
        vaciar_observaciones(token, lote_id)
        print(f"  {lote_id}: migrado")
        migrados += 1

    print(f"\nListo: {migrados} migrados, {salteados} salteados.")


if __name__ == "__main__":
    main()
