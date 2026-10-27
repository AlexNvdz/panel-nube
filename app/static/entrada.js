// Página de entrada: inicia el login en Cognito y recibe el regreso (callback)
const errorBox = document.getElementById("login-error");
const boton = document.getElementById("btn-entrar");

function mostrarError(msg) {
  errorBox.textContent = msg;
  errorBox.hidden = false;
}

(async () => {
  const q = new URLSearchParams(location.search);
  if (q.get("error")) {
    mostrarError(`Cognito no completó el inicio de sesión: ${q.get("error_description") || q.get("error")}`);
  } else if (q.get("code") && q.get("state")) {
    boton.disabled = true;
    boton.textContent = "Validando…";
    try {
      const u = await auth.signinRedirectCallback();
      location.replace(u.state && u.state !== "/" ? u.state : "/archivos");
      return;
    } catch (e) {
      mostrarError(`No se pudo completar el inicio de sesión. ${e.message}`);
      history.replaceState(null, "", "/");
    }
  } else {
    const u = await auth.getUser();
    if (u && !u.expired) return location.replace("/archivos");
  }
  boton.disabled = false;
  boton.textContent = "Entrar";
})();

boton.onclick = () => {
  boton.disabled = true;
  entrar("/archivos").catch((e) => { boton.disabled = false; mostrarError(e.message); });
};
