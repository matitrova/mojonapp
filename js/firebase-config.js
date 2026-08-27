// Config del proyecto Firebase (MojonApp). No es información secreta: la
// seguridad real la dan las reglas de Firestore/Auth (ver firestore.rules),
// no ocultar estos valores. Para apuntar la app a otro proyecto, se cambia
// solo acá.
import { initializeApp } from "https://www.gstatic.com/firebasejs/12.18.0/firebase-app.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/12.18.0/firebase-firestore.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/12.18.0/firebase-auth.js";

const firebaseConfig = {
  apiKey: "AIzaSyCR9w0fwXixk4CZV051-srq9PsTvmp5lGQ",
  authDomain: "mojonapp.firebaseapp.com",
  projectId: "mojonapp",
  storageBucket: "mojonapp.firebasestorage.app",
  messagingSenderId: "429408050490",
  appId: "1:429408050490:web:0d977ce145c87264958403"
};

const app = initializeApp(firebaseConfig);
export const db = getFirestore(app);
export const auth = getAuth(app);
// Se reexporta el config para el panel de administración: dar de alta un
// corredor nuevo levanta una segunda instancia de Firebase App/Auth en
// memoria (initializeApp(firebaseConfig, "alta-...")) para que crear esa
// cuenta no pise la sesión de quien la está creando.
export { firebaseConfig };
