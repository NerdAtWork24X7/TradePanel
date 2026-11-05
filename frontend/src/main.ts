import "./styles/fonts.css";
import "./styles/tokens.css";
import "./styles/shell.css";
import "./styles/ai.css";
import { bootstrapApp } from "./app/controller";

/** The critical inline styles keep the boot screen opaque until the module
 *  (and with it the real stylesheet) has run; fade it out only now. */
function dismissBootScreen(): void {
  const boot = document.getElementById("boot-screen");
  if (!boot) return;
  document.body.classList.add("app-ready");
  window.setTimeout(() => boot.remove(), 200);
}

try {
  bootstrapApp();
  dismissBootScreen();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  document.body.innerHTML = `<pre style="padding:24px;color:#f87171">TradePanel failed to start:\n${message}</pre>`;
}
