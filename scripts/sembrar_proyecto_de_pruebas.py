#!/usr/bin/env python3
"""
Prepara (y revisa) el proyecto Firebase que usan los tests.

POR QUÉ EXISTE UN PROYECTO APARTE. Los tests de Playwright escriben en
Firestore de verdad. Cuando eso era el proyecto de producción, pasaban
dos cosas: los datos de prueba que quedaban sin borrar aparecían en el
Dashboard real del cliente, y una corrida completa de la suite agotaba
la cuota gratuita (50.000 lecturas por día, contadas POR DOCUMENTO), con
lo cual la app en producción empezaba a responder 429 a cualquiera que
entrara. Un proyecto separado corta las dos cosas de raíz.

QUÉ HACE ESTE SCRIPT. Chequea que el proyecto esté bien armado y crea lo
único que se puede crear desde acá. La idea es que un problema de
configuración se vea ahora, con un mensaje claro, en vez de aparecer
como un test rarísimo fallando a los 10 minutos de suite.

LO QUE **NO** PUEDE HACER, y por qué. Las reglas exigen ser root para
escribir en "usuarios" y "perfiles" (firestore.rules: `allow write: if
esRoot()`), y para ser root ya hay que tener esos documentos. Es un
huevo-y-gallina real: el primer root se crea a mano desde la consola de
Firebase, que es el único lugar que se saltea las reglas. Mismo bootstrap
que se hizo en producción.

USO:
    python3 scripts/sembrar_proyecto_de_pruebas.py

Lee la configuración de tests/.env (FIREBASE_API_KEY, FIREBASE_PROJECT_ID,
TEST_USER_EMAIL, TEST_USER_PASSWORD).
"""

import re
import sys
from pathlib import Path

RAIZ = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(RAIZ / "tests"))

import requests  # noqa: E402

import conftest  # noqa: E402  (carga tests/.env y resuelve el token)

# Permisos que los tests dan por sentado para el perfil "corredor" (el
# que usa crear_usuario_de_prueba en conftest.py). Las claves salen de
# PERMISOS_SECCIONES en js/admin.js.
PERMISOS_CORREDOR = {
    "cargar_lote": True,
    "editar_lote_propio": True,
    "borrar_lote_propio": True,
    "gestionar_contactos": True,
    "editar_lote_ajeno": False,
    "borrar_lote_ajeno": False,
    "ver_todos_los_lotes": False,
    "ver_todos_los_contactos": False,
    "administrar_usuarios": False,
    "administrar_sectores": False,
    "administrar_catalogos_crm": False,
}

ok_todo = True


def sin_credenciales(texto):
    """Saca la API key de un mensaje de error antes de imprimirlo.

    Los endpoints de Firebase la llevan en la query string, así que un
    `raise_for_status()` la mete en el texto de la excepción y de ahí va
    a la consola, a un log, o a una captura de pantalla pegada en un
    chat. Ya pasó una vez: este script la escupió en la primera corrida.
    """
    return re.sub(r"key=[^&\s]+", "key=<oculta>", str(texto))


def paso(texto):
    print(f"\n→ {texto}")


def bien(texto):
    print(f"   OK   {texto}")


def mal(texto, comoArreglarlo):
    global ok_todo
    ok_todo = False
    print(f"   FALLA  {texto}")
    for linea in comoArreglarlo.strip().splitlines():
        print(f"          {linea.strip()}")


def url(coleccion, doc_id=None):
    base = (
        f"https://firestore.googleapis.com/v1/projects/{conftest.FIREBASE_PROJECT_ID}"
        f"/databases/(default)/documents/{coleccion}"
    )
    return f"{base}/{doc_id}" if doc_id else base


def main():
    print("=" * 66)
    print(f"Proyecto Firebase: {conftest.FIREBASE_PROJECT_ID}")
    print(f"Usuario de prueba: {conftest.TEST_USER_EMAIL}")
    print("=" * 66)

    if conftest.USA_PRODUCCION:
        print(
            "\nEste script apunta a PRODUCCION. No es para eso.\n"
            "Definí FIREBASE_API_KEY y FIREBASE_PROJECT_ID en tests/.env\n"
            "con los valores del proyecto de pruebas."
        )
        sys.exit(1)

    # ---- 1. El usuario existe y puede loguearse
    paso("Login del usuario de prueba")
    try:
        token = conftest._id_token_de_prueba()
        uid = conftest._uid_de_prueba()
        bien(f"entra bien (uid {uid})")
    except Exception as error:  # noqa: BLE001
        mal(
            f"no puede loguearse ({sin_credenciales(error)})",
            """
            En la consola de Firebase, proyecto de pruebas:
            - Authentication -> Sign-in method -> habilitar "Email/Password"
            - Authentication -> Users -> Add user, con el email y la
              contraseña que pusiste en tests/.env
            """,
        )
        return terminar()

    auth = {"Authorization": f"Bearer {token}"}

    # ---- 2. Las reglas están publicadas (y no quedó la base abierta)
    paso("Reglas de Firestore")
    sin_sesion = requests.post(url("lotes"), json={"fields": {}}, timeout=30)
    if sin_sesion.ok:
        mal(
            "¡se puede ESCRIBIR sin estar logueado!",
            """
            La base quedó en "modo de prueba" (reglas abiertas), o sea que
            cualquiera en internet puede escribirla. Pegá el contenido de
            firestore.rules en Firestore Database -> Reglas -> Publicar.
            """,
        )
        # Limpia lo que acabó de entrar, para no dejar basura.
        if sin_sesion.json().get("name"):
            requests.delete(
                f"https://firestore.googleapis.com/v1/{sin_sesion.json()['name']}", timeout=30
            )
    else:
        bien("escribir sin sesión está denegado")

    # ---- 3. El usuario tiene su doc en "usuarios"
    paso('Documento en "usuarios"')
    doc_usuario = requests.get(url("usuarios", uid), headers=auth, timeout=30)
    perfil_id = None
    if doc_usuario.status_code == 404:
        mal(
            f"falta usuarios/{uid}",
            f"""
            Crealo a mano en la consola (Firestore Database -> Datos):
              coleccion: usuarios
              id del documento: {uid}
              campos: email = "{conftest.TEST_USER_EMAIL}" (string)
                      perfil_id = "root" (string)
            """,
        )
    elif not doc_usuario.ok:
        mal(f"no se pudo leer usuarios/{uid} (HTTP {doc_usuario.status_code})", "Revisá las reglas.")
    else:
        perfil_id = (
            doc_usuario.json().get("fields", {}).get("perfil_id", {}).get("stringValue")
        )
        if perfil_id:
            bien(f'existe, con perfil_id "{perfil_id}"')
        else:
            mal(
                f"usuarios/{uid} existe pero no tiene perfil_id",
                'Agregale el campo perfil_id = "root" (string).',
            )

    # ---- 4. Ese perfil existe y es root
    if perfil_id:
        paso(f'Perfil "{perfil_id}"')
        doc_perfil = requests.get(url("perfiles", perfil_id), headers=auth, timeout=30)
        if doc_perfil.status_code == 404:
            mal(
                f"falta perfiles/{perfil_id}",
                f"""
                Crealo a mano en la consola:
                  coleccion: perfiles
                  id del documento: {perfil_id}
                  campos: nombre = "Root (tests)" (string)
                          es_root = true (boolean)
                """,
            )
        elif doc_perfil.ok:
            es_root = (
                doc_perfil.json().get("fields", {}).get("es_root", {}).get("booleanValue")
            )
            if es_root:
                bien("es root: puede administrar usuarios, perfiles y catálogos")
            else:
                mal(
                    f"perfiles/{perfil_id} existe pero es_root no es true",
                    """
                    Varios tests entran a Seguridad, Auditoría y los catálogos,
                    que son solo para root. Poné es_root = true (boolean).
                    """,
                )

    # ---- 5. perfiles/corredor (este sí lo puede crear el script)
    paso('Perfil "corredor" (lo pide crear_usuario_de_prueba)')
    doc_corredor = requests.get(url("perfiles", "corredor"), headers=auth, timeout=30)
    if doc_corredor.ok:
        bien("ya existe")
    else:
        campos = {
            "nombre": {"stringValue": "Corredor"},
            "es_root": {"booleanValue": False},
            "permisos": {
                "mapValue": {
                    "fields": {
                        clave: {"booleanValue": valor}
                        for clave, valor in PERMISOS_CORREDOR.items()
                    }
                }
            },
        }
        creado = requests.patch(
            url("perfiles", "corredor"), headers=auth, json={"fields": campos}, timeout=30
        )
        if creado.ok:
            bien("creado")
        else:
            mal(
                f"no se pudo crear (HTTP {creado.status_code})",
                """
                Escribir en "perfiles" requiere ser root: arreglá primero los
                pasos de arriba y volvé a correr este script.
                """,
            )

    terminar()


def terminar():
    print()
    print("=" * 66)
    if ok_todo:
        print("Todo listo. Ya se puede correr la suite contra este proyecto:")
        print("    pytest tests/ -q")
    else:
        print("Quedaron cosas por arreglar (ver arriba). Después volvé a correr:")
        print("    python3 scripts/sembrar_proyecto_de_pruebas.py")
    print("=" * 66)
    sys.exit(0 if ok_todo else 1)


if __name__ == "__main__":
    main()
